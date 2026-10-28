import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
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
import { claudeChildEnv } from "./oauth.js";
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
import { FORBIDDEN_FLAGS } from "./followup.js";
import {
  assertNoBypass,
  cloudArgs,
  initFromLine,
  launchMode,
  localLaunchFlags,
  parseCloudJson,
  parseCloudPane,
  parseLaunchOptions,
  type InitFacts,
  type LaunchOptions,
} from "./launch-options.js";
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

export type FastModeReport = {
  requested: boolean;
  /** fast_mode_state from the stream-json init event. null when no init event was read. */
  state: "on" | "off" | "cooldown" | null;
  disabledReason: string | null;
  source: "init-event" | "no-init-event" | "not-requested";
};

export type StartResult = {
  sessionId: string | null;
  tmuxTarget: string | null;
  kind: "tmux" | "terminal-app" | "headless" | "cloud";
  recordId: string;
  prepared: string[] | null;
  worktree?: true | string | null;
  fastMode?: FastModeReport;
  claudePid?: number | null;
  cloudSessionId?: string | null;
  cloudUrl?: string | null;
};

export class BlockedByDialog extends DeskError {
  readonly dialog: BlockingDialog;

  constructor(dialog: BlockingDialog) {
    super("blocked-by-dialog", "a startup dialog is blocking the session");
    this.dialog = dialog;
  }
}

export const WORKTREE_TRUST_HINT =
  "--worktree exits when the folder has not been trusted yet; open claude there once and accept the trust dialog";

export class UnobservedLaunch extends DeskError {
  readonly tmuxTarget: string;
  readonly recordId: string;

  constructor(tmuxTarget: string, recordId: string, hint?: string) {
    super("session-unobserved", hint
      ? `the new process did not publish a session id (${hint})`
      : "the new process did not publish a session id");
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
  launchFlags?: string[];
};

type LaunchFiles = {
  addDir: string;
  mcpConfig: string;
  prepared: PreparedProject | null;
};

export async function startNew(
  config: Config,
  input: {
    folder: string;
    tmuxName?: string;
    acceptDevChannelPrompt: boolean;
    prepare?: boolean;
    options?: Partial<Record<keyof LaunchOptions, unknown>>;
  },
  io?: LaunchIo,
): Promise<StartResult> {
  requireLaunch(config);
  const options = parseLaunchOptions(input.options ?? {});
  const folder = await existingDirectory(input.folder);
  const mode = launchMode(options);
  switch (mode) {
    case "environment":
      return startEnvironment(config, folder, options);
    case "cloud":
      return startCloud(config, folder, options, input.tmuxName, io);
    case "headless":
      return startHeadless(config, folder, options, input.prepare === true);
    case "interactive": {
      const started = await startInFolder(config, {
        cwd: folder,
        sessionId: null,
        tmuxName: input.tmuxName,
        acceptDevChannelPrompt: input.acceptDevChannelPrompt,
        prepare: input.prepare === true,
        launchFlags: localLaunchFlags(options),
      }, io);
      return {
        ...started,
        worktree: options.worktree,
        fastMode: options.fastMode
          ? { requested: true, state: null, disabledReason: null, source: "no-init-event" }
          : { requested: false, state: null, disabledReason: null, source: "not-requested" },
      };
    }
    default: {
      const _never: never = mode;
      return assertNever(_never);
    }
  }
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
  const headlessMatches = matches.filter((record) => record.kind === "headless");
  if (tmuxMatches.length === 0 && headlessMatches.length === 0) {
    throw new DeskError("manual-window", "close the Terminal window from this launch by hand");
  }
  let stopped: "exited" | "already" | "killed" = "already";
  for (const record of tmuxMatches) {
    stopped = await stopTmux(config, record, io);
  }
  for (const record of headlessMatches) {
    const result = await stopHeadless(config, record);
    if (result !== "already") stopped = result;
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
  const args = terminalArgs(config.claudeBin, request.sessionId, files, request.launchFlags ?? []);
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
    const worktree = (request.launchFlags ?? []).includes("--worktree");
    throw new UnobservedLaunch(target, recordId, worktree ? WORKTREE_TRUST_HINT : undefined);
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
  const line = shellLine(request.cwd, terminalArgs(config.claudeBin, request.sessionId, files, request.launchFlags ?? []));
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

/** Children of headless launches this process started, so stop can signal the exact child. */
const HEADLESS_CHILDREN = new Map<string, ChildProcess>();

/**
 * Start `claude -p --output-format stream-json --verbose` with the prompt on stdin, read lines
 * until the system/init event, and return its session id and fast_mode_state. The child keeps
 * running detached. Its output is drained and dropped, never logged.
 */
async function startHeadless(config: Config, cwd: string, options: LaunchOptions, prepare: boolean): Promise<StartResult> {
  const started = Date.now();
  const files = await launchFiles(config, { cwd, sessionId: null, acceptDevChannelPrompt: false, prepare });
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--add-dir", files.addDir, ...localLaunchFlags(options)];
  assertNoBypass(args, FORBIDDEN_FLAGS);
  assertSpawnAllowed(config.claudeBin);
  const child = spawn(config.claudeBin, args, { cwd, detached: true, stdio: ["pipe", "pipe", "ignore"], env: await claudeChildEnv(config) });
  const init = readInit(child, Math.max(config.launchWaitMs, 1000));
  child.stdin?.end(options.prompt ?? "");
  const facts = await init;
  child.unref();
  (child.stdout as { unref?: () => void } | null)?.unref?.();
  const recordId = freshRecordId();
  const pid = child.pid ?? null;
  if (pid != null && child.exitCode == null) {
    HEADLESS_CHILDREN.set(recordId, child);
    child.once("exit", () => {
      HEADLESS_CHILDREN.delete(recordId);
      void removeLaunch(config.home, recordId);
    });
  }
  await writeLaunch(config.home, {
    recordId,
    kind: "headless",
    tmuxTarget: null,
    cwd,
    startedAt: new Date(started).toISOString(),
    sessionId: facts?.sessionId ?? null,
    claudePid: pid,
  });
  logEvent({
    tool: "new",
    sessionId: facts?.sessionId ?? undefined,
    durationMs: Date.now() - started,
    code: facts ? "headless-init" : "headless-no-init",
  });
  return {
    sessionId: facts?.sessionId ?? null,
    tmuxTarget: null,
    kind: "headless",
    recordId,
    prepared: files.prepared?.keys ?? null,
    worktree: options.worktree,
    claudePid: pid,
    fastMode: {
      requested: options.fastMode,
      state: facts?.fastModeState ?? null,
      disabledReason: facts?.fastModeDisabledReason ?? null,
      source: facts ? "init-event" : "no-init-event",
    },
  };
}

/** Resolve with the init facts, or null at the deadline or exit. Every line after init is dropped. */
function readInit(child: ChildProcess, timeoutMs: number): Promise<InitFacts | null> {
  return new Promise<InitFacts | null>((resolve) => {
    let buffer = "";
    let settled = false;
    const finish = (value: InitFacts | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      buffer = "";
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString("utf8");
      if (buffer.length > 1_000_000) {
        finish(null);
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const facts = initFromLine(line);
        if (facts) {
          finish(facts);
          return;
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.once("error", () => finish(null));
    child.once("exit", () => finish(null));
  });
}

async function stopHeadless(
  config: Config,
  record: Extract<LaunchRecord, { kind: "headless" }>,
): Promise<"exited" | "already" | "killed"> {
  const child = HEADLESS_CHILDREN.get(record.recordId);
  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
    await removeLaunch(config.home, record.recordId);
    logEvent({ tool: "stop", sessionId: record.sessionId ?? undefined, code: "stopped" });
    return "killed";
  }
  const pid = record.claudePid;
  // Without the child handle, signal the pid only while its sessions file still names this session.
  if (pid != null && record.sessionId) {
    const found = await sessionRecordForPid(config.configRoot, pid, config.home);
    if (found?.sessionId === record.sessionId) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The process has already exited.
      }
      await removeLaunch(config.home, record.recordId);
      logEvent({ tool: "stop", sessionId: record.sessionId, code: "stopped" });
      return "killed";
    }
  }
  await removeLaunch(config.home, record.recordId);
  return "already";
}

/**
 * `claude --cloud "<desc>"` needs a terminal, so it runs in tmux. remain-on-exit keeps the pane
 * after the CLI exits so the printed session id can be read back.
 */
async function startCloud(
  config: Config,
  cwd: string,
  options: LaunchOptions,
  tmuxName: string | undefined,
  io?: LaunchIo,
): Promise<StartResult> {
  const started = Date.now();
  const probe = io?.probeTmux ?? probeTmux;
  if (!(await probe(config.tmuxBin))) throw new DeskError("tmux-missing", TMUX_INSTALL_HINT);
  const run = io?.runTmux ?? runTmux;
  const target = await pickTarget(run, config.tmuxBin, tmuxName);
  const args = cloudArgs(options);
  assertNoBypass(args, FORBIDDEN_FLAGS);
  const created = await tmuxCode(run, config.tmuxBin, ["new-session", "-d", "-s", target, "-c", cwd, "--", config.claudeBin, ...args]);
  if (created !== 0) throw new DeskError("spawn-failed", "tmux did not start the session");
  await tmuxCode(run, config.tmuxBin, ["set-option", "-t", target, "remain-on-exit", "on"]);
  let found: { cloudSessionId: string; url: string | null } | null = null;
  const deadline = Date.now() + config.launchWaitMs;
  do {
    found = parseCloudPane(await tmuxText(run, config.tmuxBin, ["capture-pane", "-t", target, "-p"]));
    if (found || Date.now() >= deadline) break;
    await delay(Math.min(200, config.launchWaitMs));
  } while (Date.now() <= deadline);
  const recordId = freshRecordId();
  await writeLaunch(config.home, {
    recordId,
    kind: "tmux",
    tmuxTarget: target,
    cwd,
    startedAt: new Date(started).toISOString(),
    sessionId: null,
    claudePid: null,
  });
  logEvent({ tool: "new", durationMs: Date.now() - started, code: found ? "cloud-created" : "cloud-unobserved" });
  return {
    sessionId: null,
    tmuxTarget: target,
    kind: "cloud",
    recordId,
    prepared: null,
    cloudSessionId: found?.cloudSessionId ?? null,
    cloudUrl: found?.url ?? null,
  };
}

/** `claude -p "<desc>" --environment ccpool_... --output-format json` creates the session and exits. */
async function startEnvironment(config: Config, cwd: string, options: LaunchOptions): Promise<StartResult> {
  const started = Date.now();
  const args = cloudArgs(options);
  assertNoBypass(args, FORBIDDEN_FLAGS);
  assertSpawnAllowed(config.claudeBin);
  let stdout = "";
  try {
    // stdin is closed right away, like `< /dev/null` in the documented example, so -p does not wait on it.
    const pending = execFileAsync(config.claudeBin, args, {
      cwd,
      timeout: Math.min(config.sendTimeoutMs, 55_000),
      maxBuffer: 1_000_000,
      env: await claudeChildEnv(config),
    });
    pending.child.stdin?.end();
    const result = await pending;
    stdout = String(result.stdout ?? "");
  } catch (error) {
    const failed = error as { stdout?: unknown; code?: unknown };
    if (failed.code === "ENOENT") throw new DeskError("spawn-failed", "claude binary not found");
    stdout = String(failed.stdout ?? "");
  }
  const created = parseCloudJson(stdout);
  logEvent({ tool: "new", durationMs: Date.now() - started, code: created.ok ? "cloud-created" : created.code });
  if (!created.ok) throw new DeskError(created.code, "the cloud session was not created");
  return {
    sessionId: null,
    tmuxTarget: null,
    kind: "cloud",
    recordId: freshRecordId(),
    prepared: null,
    cloudSessionId: created.cloudSessionId,
    cloudUrl: created.url,
  };
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

const REAL_BINARIES = new Set(["osascript", "open", "tmux", "cloudflared", "brew", "launchctl", "claude", "tailscale", "Tailscale"]);

export function assertSpawnAllowed(bin: string): void {
  if (process.env.CLAUDE_REMOTE_SPAWN_GUARD !== "1") return;
  if (REAL_BINARIES.has(path.basename(bin))) {
    throw new DeskError("denied", "refusing a real terminal launcher");
  }
}

const NEW_SESSION_DESCRIPTION = "Start a session in a folder. Requires the launch gate. With no options it starts an interactive terminal session in tmux. worktree (true, or a name of letters, digits, dot, dash, underscore) adds --worktree. fastMode true adds --settings {\"fastMode\":true}; it is off unless set because fast mode bills extra usage. prompt starts a headless -p session instead and returns the session id and fast_mode_state from its init event; an interactive launch has no init event, so fastMode.state is null there. cloud with a task description runs claude --cloud in tmux and returns the cloud session id once printed. cloud plus environment (a ccpool_ id) runs claude -p <description> --environment <id> --output-format json. cloud does not combine with worktree, fastMode, or prompt. Sends Enter on the development-channels prompt only when acceptDevChannelPrompt is true and the highlighted line is the accept option. Does not answer workspace trust, a new MCP server prompt, or the Chrome extension prompt. No permission-bypass flag is ever passed.";

export function registerLaunchTools(server: McpServer, config: Config): void {
  if (!config.allowLaunch) return;
  server.registerTool(
    "new_session",
    {
      description: NEW_SESSION_DESCRIPTION,
      inputSchema: z.object({
        folder: z.string().min(1),
        name: z.string().min(1).max(80).optional(),
        acceptDevChannelPrompt: z.boolean().optional(),
        prepare: z.boolean().optional(),
        worktree: z.union([z.boolean(), z.string().min(1).max(64)]).optional(),
        fastMode: z.boolean().optional(),
        cloud: z.string().min(1).max(2000).optional(),
        environment: z.string().min(8).max(140).optional(),
        prompt: z.string().min(1).max(100000).optional(),
      }),
    },
    async (args) => {
      try {
        const started = await startNew(config, {
          folder: args.folder,
          tmuxName: args.name,
          acceptDevChannelPrompt: args.acceptDevChannelPrompt === true,
          prepare: args.prepare === true,
          options: {
            worktree: args.worktree,
            fastMode: args.fastMode,
            cloud: args.cloud,
            environment: args.environment,
            prompt: args.prompt,
          },
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
