import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ensureAttachmentsRoot } from "./attachments.js";
import { writeChannelMcpConfig } from "./channel.js";
import type { Config } from "./config.js";
import type { LiveOwner } from "./domain.js";
import { DeskError, assertNever } from "./domain.js";
import { logEvent } from "./log.js";
import {
  freshRecordId,
  readLaunches,
  removeLaunch,
  safeTarget,
  writeLaunch,
  type LaunchRecord,
} from "./launches.js";
import { processIdentity, sessionRecordForPid, type ProcessIdentityLookup } from "./registry.js";
import { listCmdlines } from "./running.js";
import { prepareProject, type PreparedProject } from "./prepare.js";
import {
  appleScriptDo,
  blockingDialog,
  devPromptReady,
  paneBlocksExit,
  shellLine,
  terminalArgs,
  TMUX_INSTALL_HINT,
  type BlockingDialog,
} from "./terminal.js";
import { continueCommand, type CommandLister } from "./tools.js";

const execFileAsync = promisify(execFile);

export type ExecResult = { code: number; stdout: string; stderr: string };

export type LaunchIo = {
  probeTmux?: (bin: string) => Promise<boolean>;
  runTmux?: (bin: string, args: string[]) => Promise<ExecResult>;
  openTerminal?: (script: string) => Promise<void>;
};

export type StartResult = {
  sessionId: string | null;
  tmuxTarget: string | null;
  kind: "tmux" | "terminal-app";
  recordId: string;
  prepared: string[] | null;
};

export class BlockedByDialog extends DeskError {
  readonly dialog: BlockingDialog;

  constructor(dialog: BlockingDialog) {
    super("blocked-by-dialog", "a startup dialog is blocking the session");
    this.dialog = dialog;
  }
}

export class UnobservedLaunch extends DeskError {
  readonly tmuxTarget: string;
  readonly recordId: string;

  constructor(tmuxTarget: string, recordId: string) {
    super("session-unobserved", "the new process did not publish a session id");
    this.tmuxTarget = tmuxTarget;
    this.recordId = recordId;
  }
}

type LaunchRequest = {
  cwd: string;
  sessionId: string | null;
  tmuxName?: string;
  acceptDevChannelPrompt: boolean;
  prepare: boolean;
};

type LaunchFiles = {
  addDir: string;
  mcpConfig: string;
  prepared: PreparedProject | null;
};

export async function startNew(
  config: Config,
  input: { folder: string; tmuxName?: string; acceptDevChannelPrompt: boolean; prepare?: boolean },
  io?: LaunchIo,
): Promise<StartResult> {
  requireLaunch(config);
  const folder = await existingDirectory(input.folder);
  return startInFolder(config, {
    cwd: folder,
    sessionId: null,
    tmuxName: input.tmuxName,
    acceptDevChannelPrompt: input.acceptDevChannelPrompt,
    prepare: input.prepare === true,
  }, io);
}

export async function startContinue(
  config: Config,
  input: { sessionId: string; iStoppedIt: boolean; acceptDevChannelPrompt: boolean; tmuxName?: string; prepare?: boolean },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
  io?: LaunchIo,
): Promise<StartResult> {
  requireLaunch(config);
  const first = await continueCommand(config, { sessionId: input.sessionId }, lister, identity);
  if (first.liveOwner !== "none" && !input.iStoppedIt) refuseOwner(first.liveOwner);
  const confirmClear = async (): Promise<void> => {
    const second = await continueCommand(config, { sessionId: input.sessionId }, lister, identity);
    if (second.liveOwner !== "none") refuseOwner(second.liveOwner);
  };
  return startInFolder(config, {
    cwd: first.cwd,
    sessionId: first.sessionId,
    tmuxName: input.tmuxName,
    acceptDevChannelPrompt: input.acceptDevChannelPrompt,
    prepare: input.prepare === true,
  }, io, confirmClear);
}

export async function stopLaunched(
  config: Config,
  input: { sessionId?: string; target?: string },
  io?: LaunchIo,
): Promise<{ stopped: "exited" | "already" | "killed" }> {
  requireLaunch(config);
  const records = await readLaunches(config.home);
  const matches = records.filter((record) => matchesStop(record, input));
  if (matches.length === 0) throw new DeskError("not-ours", "no recorded launch matches");
  const tmuxMatches = matches.filter((record) => record.kind === "tmux");
  if (tmuxMatches.length === 0) {
    throw new DeskError("manual-window", "close the Terminal window from this launch by hand");
  }
  let stopped: "exited" | "already" | "killed" = "already";
  for (const record of tmuxMatches) {
    stopped = await stopTmux(config, record, io);
  }
  return { stopped };
}

async function stopTmux(
  config: Config,
  record: Extract<LaunchRecord, { kind: "tmux" }>,
  io?: LaunchIo,
): Promise<"exited" | "already" | "killed"> {
  const run = io?.runTmux ?? runTmux;
  const alive = await tmuxCode(run, config.tmuxBin, ["has-session", "-t", record.tmuxTarget]);
  if (alive !== 0) {
    await removeLaunch(config.home, record.recordId);
    return "already";
  }
  const pane = await tmuxText(run, config.tmuxBin, ["capture-pane", "-t", record.tmuxTarget, "-p"]);
  const blocked = paneBlocksExit(pane);
  if (!blocked) {
    await tmuxCode(run, config.tmuxBin, ["send-keys", "-t", record.tmuxTarget, "-l", "/exit"]);
    await tmuxCode(run, config.tmuxBin, ["send-keys", "-t", record.tmuxTarget, "Enter"]);
  }
  await tmuxCode(run, config.tmuxBin, ["kill-session", "-t", record.tmuxTarget]);
  await removeLaunch(config.home, record.recordId);
  logEvent({ tool: "stop", sessionId: record.sessionId ?? undefined, code: "stopped" });
  return blocked ? "killed" : "exited";
}

async function startInFolder(
  config: Config,
  request: LaunchRequest,
  io?: LaunchIo,
  confirmClear?: () => Promise<void>,
): Promise<StartResult> {
  const started = Date.now();
  const probe = io?.probeTmux ?? probeTmux;
  const present = await probe(config.tmuxBin);
  if (!present) {
    if (config.platform !== "darwin") throw new DeskError("tmux-missing", TMUX_INSTALL_HINT);
    if (confirmClear) await confirmClear();
    return openMacTerminal(config, request, io);
  }
  const run = io?.runTmux ?? runTmux;
  const target = await pickTarget(run, config.tmuxBin, request.tmuxName);
  if (confirmClear) await confirmClear();
  const files = await launchFiles(config, request);
  const args = terminalArgs(config.claudeBin, request.sessionId, files);
  const created = await tmuxCode(run, config.tmuxBin, [
    "new-session", "-d", "-s", target, "-c", request.cwd, "--", ...args,
  ]);
  if (created !== 0) throw new DeskError("spawn-failed", "tmux did not start the session");
  if (request.acceptDevChannelPrompt) await acceptDevPrompt(run, config, target);
  const found = await waitForSession(config, run, target);
  const recordId = freshRecordId();
  await writeLaunch(config.home, {
    recordId,
    kind: "tmux",
    tmuxTarget: target,
    cwd: request.cwd,
    startedAt: new Date(started).toISOString(),
    sessionId: found.sessionId,
    claudePid: found.pid,
  });
  logEvent({
    tool: request.sessionId ? "continue" : "new",
    sessionId: found.sessionId ?? request.sessionId ?? undefined,
    durationMs: Date.now() - started,
    code: found.sessionId ? "observed" : (found.dialog ? "blocked-by-dialog" : "session-unobserved"),
  });
  if (!found.sessionId) {
    if (found.dialog) throw new BlockedByDialog(found.dialog);
    throw new UnobservedLaunch(target, recordId);
  }
  return {
    sessionId: found.sessionId,
    tmuxTarget: target,
    kind: "tmux",
    recordId,
    prepared: files.prepared?.keys ?? null,
  };
}

async function openMacTerminal(config: Config, request: LaunchRequest, io?: LaunchIo): Promise<StartResult> {
  const started = Date.now();
  const files = await launchFiles(config, request);
  const line = shellLine(request.cwd, terminalArgs(config.claudeBin, request.sessionId, files));
  const open = io?.openTerminal ?? ((script) => defaultOpenTerminal(config, script));
  await open(appleScriptDo(line));
  const recordId = freshRecordId();
  await writeLaunch(config.home, {
    recordId,
    kind: "terminal-app",
    tmuxTarget: null,
    cwd: request.cwd,
    startedAt: new Date(started).toISOString(),
    sessionId: request.sessionId,
    claudePid: null,
  });
  logEvent({
    tool: request.sessionId ? "continue" : "new",
    sessionId: request.sessionId ?? undefined,
    durationMs: Date.now() - started,
    code: "terminal-app",
  });
  return {
    sessionId: request.sessionId,
    tmuxTarget: null,
    kind: "terminal-app",
    recordId,
    prepared: files.prepared?.keys ?? null,
  };
}

async function launchFiles(config: Config, request: LaunchRequest): Promise<LaunchFiles> {
  const addDir = await ensureAttachmentsRoot(config.home);
  const prepared = request.prepare ? await prepareProject(request.cwd, config.home, addDir) : null;
  const mcpConfig = await writeChannelMcpConfig(config.home);
  return { addDir, mcpConfig, prepared };
}

async function acceptDevPrompt(
  run: (bin: string, args: string[]) => Promise<ExecResult>,
  config: Config,
  target: string,
): Promise<void> {
  const deadline = Date.now() + config.launchWaitMs;
  do {
    const pane = await tmuxText(run, config.tmuxBin, ["capture-pane", "-t", target, "-p"]);
    if (blockingDialog(pane)) return;
    if (devPromptReady(pane)) {
      await tmuxCode(run, config.tmuxBin, ["send-keys", "-t", target, "Enter"]);
      return;
    }
    if (Date.now() >= deadline) return;
    await delay(Math.min(100, config.launchWaitMs));
  } while (Date.now() <= deadline);
}

async function waitForSession(
  config: Config,
  run: (bin: string, args: string[]) => Promise<ExecResult>,
  target: string,
): Promise<{ sessionId: string | null; pid: number | null; dialog: BlockingDialog | null }> {
  const deadline = Date.now() + config.launchWaitMs;
  do {
    const text = await tmuxText(run, config.tmuxBin, ["list-panes", "-t", target, "-F", "#{pane_pid}"]);
    const pid = Number(text.trim().split("\n")[0]);
    if (Number.isInteger(pid) && pid > 0) {
      const found = await sessionRecordForPid(config.configRoot, pid, config.home);
      if (found) return { sessionId: found.sessionId, pid, dialog: null };
    }
    const pane = await tmuxText(run, config.tmuxBin, ["capture-pane", "-t", target, "-p"]);
    const dialog = blockingDialog(pane);
    if (dialog) return { sessionId: null, pid: Number.isInteger(pid) && pid > 0 ? pid : null, dialog };
    if (Date.now() >= deadline) {
      return { sessionId: null, pid: Number.isInteger(pid) && pid > 0 ? pid : null, dialog: null };
    }
    await delay(Math.min(100, config.launchWaitMs));
  } while (Date.now() <= deadline);
  return { sessionId: null, pid: null, dialog: null };
}

async function pickTarget(
  run: (bin: string, args: string[]) => Promise<ExecResult>,
  bin: string,
  requested: string | undefined,
): Promise<string> {
  if (requested) {
    if (!safeTarget(requested)) throw new DeskError("bad-name", "tmux name must be letters, digits, _ or -");
    const code = await tmuxCode(run, bin, ["has-session", "-t", requested]);
    if (code === 0) throw new DeskError("tmux-name", "that tmux name is already in use");
    return requested;
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = `sd${randomBytes(4).toString("hex")}`;
    const code = await tmuxCode(run, bin, ["has-session", "-t", name]);
    if (code !== 0) return name;
  }
  throw new DeskError("tmux-name", "could not choose a free tmux name");
}

function matchesStop(record: LaunchRecord, input: { sessionId?: string; target?: string }): boolean {
  if (input.target && record.kind === "tmux" && record.tmuxTarget === input.target) return true;
  if (input.sessionId && record.sessionId === input.sessionId) return true;
  return false;
}

function refuseOwner(owner: LiveOwner): never {
  switch (owner) {
    case "none":
      throw new DeskError("live-owner", "a live process owns this session");
    case "desktop":
      throw new DeskError("live-owner", "stop this session in the desktop app before launching it again");
    case "terminal":
      throw new DeskError("live-owner", "stop the terminal process that owns this session before launching it again");
    case "unknown":
      throw new DeskError("live-owner", "a live process may still own this session");
    default: {
      const _never: never = owner;
      return assertNever(_never);
    }
  }
}

function requireLaunch(config: Config): void {
  if (!config.allowLaunch) throw new DeskError("launch-disabled", "launch is disabled");
}

async function existingDirectory(folder: string): Promise<string> {
  let info;
  try {
    info = await stat(folder);
  } catch {
    throw new DeskError("missing-cwd", "session directory does not exist");
  }
  if (!info.isDirectory()) throw new DeskError("missing-cwd", "session directory does not exist");
  return folder;
}

async function probeTmux(bin: string): Promise<boolean> {
  const result = await runTmux(bin, ["-V"]);
  return result.code === 0;
}

async function defaultOpenTerminal(config: Config, script: string): Promise<void> {
  assertSpawnAllowed(config.osascriptBin);
  await execFileAsync(config.osascriptBin, ["-e", script], { timeout: 10000 });
}

const REAL_BINARIES = new Set(["osascript", "open", "tmux", "cloudflared", "brew", "launchctl", "claude"]);

export function assertSpawnAllowed(bin: string): void {
  if (process.env.CLAUDE_REMOTE_SPAWN_GUARD !== "1") return;
  if (REAL_BINARIES.has(path.basename(bin))) {
    throw new DeskError("denied", "refusing a real terminal launcher");
  }
}

export function registerLaunchTools(server: McpServer, config: Config): void {
  if (!config.allowLaunch) return;
  server.registerTool(
    "new_session",
    {
      description: "Start a terminal session in a folder. Requires the launch gate. Sends Enter on the development-channels prompt only when acceptDevChannelPrompt is true and the highlighted line is the accept option. Does not answer workspace trust, a new MCP server prompt, or the Chrome extension prompt.",
      inputSchema: z.object({
        folder: z.string().min(1),
        name: z.string().min(1).max(80).optional(),
        acceptDevChannelPrompt: z.boolean().optional(),
        prepare: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        const started = await startNew(config, {
          folder: args.folder,
          tmuxName: args.name,
          acceptDevChannelPrompt: args.acceptDevChannelPrompt === true,
          prepare: args.prepare === true,
        });
        return { content: [{ type: "text", text: JSON.stringify(started) }] };
      } catch (error) {
        return launchToolError(error);
      }
    },
  );
  server.registerTool(
    "continue_session",
    {
      description: "Launch a resumed terminal session. Requires the launch gate. Refuses a live owner unless confirmLiveOwner is true, and still refuses if that process is alive. Sends Enter on the development-channels prompt only when acceptDevChannelPrompt is true and the highlighted line is the accept option.",
      inputSchema: z.object({
        sessionId: z.string(),
        confirmLiveOwner: z.boolean().optional(),
        acceptDevChannelPrompt: z.boolean().optional(),
        name: z.string().min(1).max(80).optional(),
        prepare: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        const started = await startContinue(config, {
          sessionId: args.sessionId,
          iStoppedIt: args.confirmLiveOwner === true,
          acceptDevChannelPrompt: args.acceptDevChannelPrompt === true,
          tmuxName: args.name,
          prepare: args.prepare === true,
        });
        return { content: [{ type: "text", text: JSON.stringify(started) }] };
      } catch (error) {
        return launchToolError(error);
      }
    },
  );
  server.registerTool(
    "stop_session",
    {
      description: "Stop a tmux session this desk recorded. Requires the launch gate. Does not stop a desktop process.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        target: z.string().optional(),
      }),
    },
    async (args) => {
      try {
        if (!args.sessionId && !args.target) throw new DeskError("usage", "sessionId or target is required");
        const stopped = await stopLaunched(config, { sessionId: args.sessionId, target: args.target });
        return { content: [{ type: "text", text: JSON.stringify(stopped) }] };
      } catch (error) {
        return launchToolError(error);
      }
    },
  );
}

function launchToolError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  if (error instanceof BlockedByDialog) {
    return { isError: true, content: [{ type: "text", text: `code=blocked-by-dialog dialog=${error.dialog}` }] };
  }
  if (error instanceof DeskError) {
    return { isError: true, content: [{ type: "text", text: `code=${error.code}\n${error.message}` }] };
  }
  return { isError: true, content: [{ type: "text", text: "unexpected failure" }] };
}

async function runTmux(bin: string, args: string[]): Promise<ExecResult> {
  assertSpawnAllowed(bin);
  try {
    const result = await execFileAsync(bin, args, { timeout: 10000, maxBuffer: 1_000_000 });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
    if (failed.code === "ENOENT") return { code: 127, stdout: "", stderr: "" };
    const code = typeof failed.code === "number" ? failed.code : 1;
    return { code, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") };
  }
}

async function tmuxCode(
  run: (bin: string, args: string[]) => Promise<ExecResult>,
  bin: string,
  args: string[],
): Promise<number> {
  const result = await run(bin, args);
  return result.code;
}

async function tmuxText(
  run: (bin: string, args: string[]) => Promise<ExecResult>,
  bin: string,
  args: string[],
): Promise<string> {
  const result = await run(bin, args);
  return result.stdout;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
