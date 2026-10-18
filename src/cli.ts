import { approveTimeoutSeconds, MAX_APPROVE_TIMEOUT_S, parseConfig, type Config } from "./config.js";
import { cleanupDesk } from "./cleanup.js";
import { DeskError, assertNever } from "./domain.js";
import { listenHttp, resolveHttpPort, HTTP_HOST } from "./http.js";
import {
  commandVNode,
  executeInstall,
  executeStatus,
  executeUninstall,
  resolveCloudflared,
  serverEntry,
  resolveClaudeBin,
  stableNodeBin,
  type InstallReport,
  type StatusReport,
  type UninstallReport,
} from "./install.js";
import { BlockedByDialog, startContinue, startNew, stopLaunched, UnobservedLaunch, type StartResult } from "./launch.js";
import { pendingFilePath, registryLiveness, startPendingPersistence } from "./pending-file.js";
import { pendingStore } from "./pending.js";
import { listRows, type DeskRow } from "./rows.js";
import { showSession, type ShowView } from "./show.js";
import { mintToken, tokenPath, writeToken } from "./token.js";
import { RENAME_MESSAGE, sendFollowup } from "./tools.js";
import type { FollowupOutcome } from "./queue.js";

const COMMANDS = ["list", "show", "new", "continue", "send", "rename", "stop", "cleanup", "http", "install", "uninstall", "status", "rotate-token"] as const;

type CommandName = (typeof COMMANDS)[number];

const USAGE = "usage: claude-remote list|show|new|continue|send|rename|stop|cleanup|http|install|uninstall|status|rotate-token|hook";

type Parsed =
  | { command: "list"; json: boolean; project?: string }
  | { command: "show"; json: boolean; sessionId: string }
  | { command: "new"; json: boolean; folder: string; tmuxName?: string; acceptDevChannelPrompt: boolean; prepare: boolean }
  | { command: "continue"; json: boolean; sessionId: string; iStoppedIt: boolean; acceptDevChannelPrompt: boolean; tmuxName?: string; prepare: boolean }
  | { command: "send"; json: boolean; sessionId: string; message: string; attach: string[]; yes: boolean }
  | { command: "rename"; json: boolean; sessionId: string; title: string }
  | { command: "stop"; json: boolean; sessionId?: string; target?: string }
  | { command: "cleanup"; json: boolean }
  | { command: "http"; port?: number }
  | { command: "install"; json: boolean; dryRun: boolean; allowSend: boolean; allowLaunch: boolean; allowApprove: boolean; approveTimeoutS?: number; hooks: boolean; port?: number }
  | { command: "uninstall"; json: boolean; dryRun: boolean; purge: boolean }
  | { command: "status"; json: boolean }
  | { command: "rotate-token"; json: boolean };

type Io = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

export function isDeskCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

export async function runCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  io: Io = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  },
): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    const config = parseConfig(env);
    return await dispatch(config, parsed, io, env);
  } catch (error) {
    return report(error, io, wantsJson(argv));
  }
}

async function dispatch(config: Config, parsed: Parsed, io: Io, env: NodeJS.ProcessEnv): Promise<number> {
  switch (parsed.command) {
    case "list": {
      const rows = await listRows(config, { project: parsed.project });
      io.stdout(parsed.json ? `${JSON.stringify({ sessions: rows })}\n` : rows.map(listLine).join("\n") + (rows.length ? "\n" : ""));
      return 0;
    }
    case "show": {
      const view = await showSession(config, parsed.sessionId);
      io.stdout(parsed.json ? `${JSON.stringify(view)}\n` : showText(view));
      return 0;
    }
    case "new": {
      const started = await startNew(config, {
        folder: parsed.folder,
        tmuxName: parsed.tmuxName,
        acceptDevChannelPrompt: parsed.acceptDevChannelPrompt,
        prepare: parsed.prepare,
      });
      io.stdout(parsed.json ? `${JSON.stringify(started)}\n` : startText(started));
      return 0;
    }
    case "continue": {
      const started = await startContinue(config, {
        sessionId: parsed.sessionId,
        iStoppedIt: parsed.iStoppedIt,
        acceptDevChannelPrompt: parsed.acceptDevChannelPrompt,
        tmuxName: parsed.tmuxName,
        prepare: parsed.prepare,
      });
      io.stdout(parsed.json ? `${JSON.stringify(started)}\n` : startText(started));
      return 0;
    }
    case "send": {
      const outcome = await sendFollowup(config, {
        sessionId: parsed.sessionId,
        message: parsed.message,
        confirm: parsed.yes,
        attachments: parsed.attach.map((file) => ({ path: file })),
      });
      io.stdout(parsed.json ? `${JSON.stringify(publicSend(outcome))}\n` : sendLine(outcome));
      return 0;
    }
    case "rename":
      throw new DeskError("no-documented-route", RENAME_MESSAGE);
    case "stop": {
      const stopped = await stopLaunched(config, { sessionId: parsed.sessionId, target: parsed.target });
      io.stdout(parsed.json ? `${JSON.stringify(stopped)}\n` : `stopped=${stopped.stopped}\n`);
      return 0;
    }
    case "cleanup": {
      const cleaned = await cleanupDesk(config);
      io.stdout(parsed.json ? `${JSON.stringify(cleaned)}\n` : `sockets=${cleaned.sockets} tokens=${cleaned.tokens}\n`);
      return 0;
    }
    case "http": {
      const port = resolveHttpPort(env, parsed.port);
      const saved = await startPendingPersistence(pendingStore, {
        file: pendingFilePath(config.home),
        approveTimeoutMs: config.approveTimeoutMs,
        liveness: registryLiveness(config),
      });
      const listener = await listenHttp(config, port);
      io.stdout(`listening=${HTTP_HOST}:${listener.port}\ntokenPath=${tokenPath(config.home)}\n`);
      await new Promise<void>((resolve) => {
        const stop = () => {
          void listener.close().then(() => saved.stop()).finally(resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
      return 0;
    }
    case "install": {
      const port = resolveHttpPort(env, parsed.port);
      const cloudflared = await resolveCloudflared(env);
      const nodeBin = stableNodeBin(process.execPath, await commandVNode(env));
      const report = await executeInstall({
        home: config.home,
        platform: config.platform,
        uid: process.getuid?.() ?? 0,
        port,
        allowSend: parsed.allowSend,
        allowLaunch: parsed.allowLaunch,
        allowApprove: parsed.allowApprove,
        approveTimeoutS: parsed.approveTimeoutS ?? approveTimeoutSeconds(env.CLAUDE_REMOTE_APPROVE_TIMEOUT_S),
        hooks: parsed.hooks,
        configRoot: config.configRoot,
        dryRun: parsed.dryRun,
        nodeBin,
        entry: serverEntry(),
        cloudflaredBin: cloudflared.bin,
        cloudflaredPresent: cloudflared.present,
        brewBin: env.CLAUDE_REMOTE_BREW_BIN || "brew",
        launchctlBin: env.CLAUDE_REMOTE_LAUNCHCTL_BIN || "launchctl",
        claudeBin: await resolveClaudeBin(config.claudeBin, env.PATH),
        urlWaitMs: urlWaitMs(env),
      });
      io.stdout(parsed.json ? `${JSON.stringify(report)}\n` : installText(report));
      return 0;
    }
    case "uninstall": {
      const report = await executeUninstall({
        home: config.home,
        uid: process.getuid?.() ?? 0,
        dryRun: parsed.dryRun,
        purge: parsed.purge,
        launchctlBin: env.CLAUDE_REMOTE_LAUNCHCTL_BIN || "launchctl",
        claudeBin: config.claudeBin,
        configRoot: config.configRoot,
      });
      io.stdout(parsed.json ? `${JSON.stringify(report)}\n` : uninstallText(report));
      return 0;
    }
    case "status": {
      const report = await executeStatus(
        config.home,
        process.getuid?.() ?? 0,
        env.CLAUDE_REMOTE_LAUNCHCTL_BIN || "launchctl",
      );
      io.stdout(parsed.json ? `${JSON.stringify(report)}\n` : statusText(report));
      return 0;
    }
    case "rotate-token": {
      const file = await writeToken(config.home, mintToken());
      io.stdout(parsed.json ? `${JSON.stringify({ tokenPath: file })}\n` : `tokenPath=${file}\n`);
      return 0;
    }
    default: {
      const _never: never = parsed;
      return assertNever(_never);
    }
  }
}

function parseArgv(argv: string[]): Parsed {
  const command = argv[0];
  if (!command || !isDeskCommand(command)) throw new DeskError("usage", USAGE);
  if (command === "http" || command === "install" || command === "uninstall" || command === "status" || command === "rotate-token") {
    return parseRemote(command, argv.slice(1));
  }
  const bag = readBag(argv.slice(1));
  switch (command) {
    case "list":
      if (bag.positionals.length > 0 || bag.prepare) throw new DeskError("usage", USAGE);
      return { command, json: bag.json, project: bag.project };
    case "show":
      if (bag.positionals.length !== 1 || bag.prepare) throw new DeskError("usage", USAGE);
      return { command, json: bag.json, sessionId: bag.positionals[0] ?? "" };
    case "new":
      if (bag.positionals.length !== 1) throw new DeskError("usage", USAGE);
      return {
        command,
        json: bag.json,
        folder: bag.positionals[0] ?? "",
        tmuxName: bag.name,
        acceptDevChannelPrompt: bag.accept,
        prepare: bag.prepare,
      };
    case "continue":
      if (bag.positionals.length !== 1) throw new DeskError("usage", USAGE);
      return {
        command,
        json: bag.json,
        sessionId: bag.positionals[0] ?? "",
        iStoppedIt: bag.stopped,
        acceptDevChannelPrompt: bag.accept,
        tmuxName: bag.name,
        prepare: bag.prepare,
      };
    case "send": {
      if (bag.positionals.length !== 1 || bag.message == null || bag.prepare) throw new DeskError("usage", USAGE);
      return {
        command,
        json: bag.json,
        sessionId: bag.positionals[0] ?? "",
        message: bag.message,
        attach: bag.attach,
        yes: bag.yes,
      };
    }
    case "rename":
      if (bag.positionals.length !== 2 || bag.prepare) throw new DeskError("usage", USAGE);
      return { command, json: bag.json, sessionId: bag.positionals[0] ?? "", title: bag.positionals[1] ?? "" };
    case "stop":
      if (bag.positionals.length > 1 || bag.prepare) throw new DeskError("usage", USAGE);
      if (bag.positionals.length === 0 && !bag.target) throw new DeskError("usage", USAGE);
      return { command, json: bag.json, sessionId: bag.positionals[0], target: bag.target };
    case "cleanup":
      if (bag.positionals.length > 0 || bag.prepare) throw new DeskError("usage", USAGE);
      return { command, json: bag.json };
    default: {
      const _never: never = command;
      return assertNever(_never);
    }
  }
}

type Bag = {
  json: boolean;
  yes: boolean;
  accept: boolean;
  stopped: boolean;
  prepare: boolean;
  project?: string;
  name?: string;
  message?: string;
  target?: string;
  attach: string[];
  positionals: string[];
};

function readBag(argv: string[]): Bag {
  const bag: Bag = { json: false, yes: false, accept: false, stopped: false, prepare: false, attach: [], positionals: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token == null) continue;
    if (token === "--") {
      bag.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      bag.positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const next = (): string => {
      if (inline != null) return inline;
      const value = argv[i + 1];
      if (value == null || value.startsWith("--")) throw new DeskError("usage", USAGE);
      i += 1;
      return value;
    };
    switch (flag) {
      case "--json":
        bag.json = true;
        break;
      case "--yes":
        bag.yes = true;
        break;
      case "--accept-dev-channel-prompt":
        bag.accept = true;
        break;
      case "--prepare-project":
        bag.prepare = true;
        break;
      case "--i-stopped-it":
      case "--force-live-owner":
        bag.stopped = true;
        break;
      case "--project":
        bag.project = next();
        break;
      case "--name":
        bag.name = next();
        break;
      case "--message":
        bag.message = next();
        break;
      case "--target":
        bag.target = next();
        break;
      case "--attach":
        bag.attach.push(next());
        break;
      default:
        throw new DeskError("usage", USAGE);
    }
  }
  return bag;
}

function report(error: unknown, io: Io, json: boolean): number {
  if (error instanceof UnobservedLaunch) {
    const body = { code: error.code, message: error.message, tmuxTarget: error.tmuxTarget, recordId: error.recordId };
    io.stdout(json ? `${JSON.stringify(body)}\n` : `code=${error.code} tmuxTarget=${error.tmuxTarget}\n`);
    return 1;
  }
  if (error instanceof BlockedByDialog) {
    const body = { code: error.code, dialog: error.dialog, message: error.message };
    io.stdout(json ? `${JSON.stringify(body)}\n` : `code=${error.code} dialog=${error.dialog}\n`);
    return 1;
  }
  if (error instanceof DeskError) {
    if (error.code === "usage") {
      io.stderr(`${error.message}\n`);
      return 2;
    }
    const body = { code: error.code, message: error.message };
    io.stdout(json ? `${JSON.stringify(body)}\n` : `code=${error.code}\n${error.message}\n`);
    return 1;
  }
  io.stderr("unexpected failure\n");
  return 1;
}

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json") || argv.some((arg) => arg.startsWith("--json="));
}

function parseRemote(command: "http" | "install" | "uninstall" | "status" | "rotate-token", argv: string[]): Parsed {
  let json = false;
  let dryRun = false;
  let allowSend = false;
  let allowLaunch = false;
  let allowApprove = false;
  let approveTimeoutS: number | undefined;
  let hooks = true;
  let purge = false;
  let port: number | undefined;
  for (const token of argv) {
    if (token === "--json") json = true;
    else if (token === "--dry-run") dryRun = true;
    else if (token === "--allow-send") allowSend = true;
    else if (token === "--allow-launch") allowLaunch = true;
    else if (token === "--allow-approve" && command === "install") allowApprove = true;
    else if (token === "--no-hooks" && command === "install") hooks = false;
    else if (token.startsWith("--approve-timeout=") && command === "install") approveTimeoutS = parseApproveTimeout(token.slice("--approve-timeout=".length));
    else if (token === "--purge") purge = true;
    else if (token.startsWith("--port=")) port = parsePort(token.slice("--port=".length));
    else throw new DeskError("usage", USAGE);
  }
  switch (command) {
    case "http":
      if (json || dryRun || allowSend || allowLaunch || purge) throw new DeskError("usage", USAGE);
      return { command, port };
    case "install":
      if (purge) throw new DeskError("usage", USAGE);
      return { command, json, dryRun, allowSend, allowLaunch, allowApprove, approveTimeoutS, hooks, port };
    case "uninstall":
      if (allowSend || allowLaunch || port != null) throw new DeskError("usage", USAGE);
      return { command, json, dryRun, purge };
    case "status":
      if (dryRun || allowSend || allowLaunch || purge || port != null) throw new DeskError("usage", USAGE);
      return { command, json };
    case "rotate-token":
      if (dryRun || allowSend || allowLaunch || purge || port != null) throw new DeskError("usage", USAGE);
      return { command, json };
    default: {
      const _never: never = command;
      return assertNever(_never);
    }
  }
}

function parseApproveTimeout(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 5 || parsed > MAX_APPROVE_TIMEOUT_S) throw new DeskError("usage", USAGE);
  return parsed;
}

function parsePort(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new DeskError("usage", USAGE);
  return parsed;
}

function urlWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CLAUDE_REMOTE_URL_WAIT_MS;
  if (!raw) return 8000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 8000;
  return Math.min(Math.floor(parsed), 20000);
}

function installText(report: InstallReport): string {
  return [
    `dryRun=${report.dryRun ? "yes" : "no"}`,
    `tokenPath=${report.tokenPath}`,
    `url=${report.url ?? "-"}`,
    `port=${report.port}`,
    `brew=${report.brew}`,
    `hookEvents=${report.hookEvents.join(",") || "-"}`,
    `settings=${report.hooks ? report.hooks.settingsPath : "-"}`,
    `settingsChanged=${report.hooks ? (report.hooks.changed ? "yes" : "no") : "-"}`,
    `settingsBackup=${report.hooks?.backupPath ?? "-"}`,
    report.httpPlist,
    report.tunnelPlist,
  ].join("\n") + "\n";
}

function statusText(report: StatusReport): string {
  return [
    `helper=${report.helper}`,
    `tunnel=${report.tunnel}`,
    `url=${report.url ?? "-"}`,
    `tokenPath=${report.tokenPath}`,
    `tokenFile=${report.tokenFile}`,
    `port=${report.port}`,
  ].join("\n") + "\n";
}

function uninstallText(report: UninstallReport): string {
  const hooks = report.hooks && "changed" in report.hooks
    ? `settingsChanged=${report.hooks.changed ? "yes" : "no"}\nsettingsBackup=${report.hooks.backupPath ?? "-"}\n`
    : report.hooks ? `hooksInstalled=${report.hooks.installed ? "yes" : "no"}\n` : "";
  return `dryRun=${report.dryRun ? "yes" : "no"}\npurge=${report.purge ? "yes" : "no"}\nremoved=${report.removed.join(",")}\n${hooks}`;
}

function listLine(row: DeskRow): string {
  return [
    row.sessionId,
    cell(row.title),
    cell(row.projectName),
    cell(row.cwd),
    row.liveOwner,
    row.channelAttached ? "yes" : "no",
    row.activity,
    cell(row.command),
    cell(row.warning),
  ].join("\t");
}

function showText(view: ShowView): string {
  return [
    `sessionId=${view.sessionId}`,
    `title=${cell(view.title)}`,
    `lastActivity=${cell(view.lastActivity)}`,
    `messageCount=${view.messageCount}`,
    `reply=${cell(view.reply)}`,
  ].join("\n") + "\n";
}

function startText(started: StartResult): string {
  const prepared = started.prepared && started.prepared.length > 0
    ? `prepared=.claude/settings.local.json keys=${started.prepared.join(",")}\n`
    : "";
  return `sessionId=${started.sessionId ?? "-"}\ntmuxTarget=${started.tmuxTarget ?? "-"}\nkind=${started.kind}\n${prepared}`;
}

function cell(value: string | null): string {
  if (value == null || value.length === 0) return "-";
  return value.replace(/[\t\r\n]/g, " ");
}

function sendLine(outcome: FollowupOutcome): string {
  const body = publicSend(outcome);
  return `disposition=${body.disposition} sessionId=${body.sessionId ?? "-"}\n`;
}

function publicSend(outcome: FollowupOutcome): PublicSend {
  const attachmentCount = "attachments" in outcome && outcome.attachments ? outcome.attachments.length : 0;
  switch (outcome.disposition) {
    case "sent":
      return {
        disposition: "sent",
        sessionId: outcome.sessionId,
        exitCode: outcome.exitCode,
        ticketId: outcome.ticketId,
        attachmentCount,
      };
    case "queued":
      return {
        disposition: "queued",
        sessionId: outcome.sessionId,
        reason: outcome.reason,
        ticketId: outcome.ticketId,
        attachmentCount,
      };
    case "handed":
      return {
        disposition: "handed",
        sessionId: outcome.sessionId,
        observedStatus: outcome.observedStatus,
        offerId: outcome.offerId,
        attachmentCount,
      };
    case "undelivered":
      return { disposition: "undelivered", sessionId: outcome.sessionId, code: outcome.code, attachmentCount };
    case "rejected":
      return { disposition: "rejected", sessionId: outcome.sessionId, code: outcome.code, attachmentCount };
    case "unsupported":
      return { disposition: "unsupported", sessionId: outcome.sessionId, code: outcome.code, attachmentCount };
    default: {
      const _never: never = outcome;
      return assertNever(_never);
    }
  }
}

type PublicSend = {
  disposition: FollowupOutcome["disposition"];
  sessionId: string | null;
  exitCode?: number;
  observedStatus?: string | null;
  reason?: string;
  code?: string;
  ticketId?: string;
  offerId?: string;
  attachmentCount: number;
};
