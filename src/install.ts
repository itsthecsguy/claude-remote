import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DeskError, assertNever } from "./domain.js";
import { removeHookScript, writeHookScript } from "./hook-script.js";
import { HTTP_HOST, HTTP_PORT } from "./http.js";
import { assertSpawnAllowed } from "./launch.js";
import { ensureToken, tokenDirectory, tokenPath } from "./token.js";
import { DEFAULT_APPROVE_TIMEOUT_S } from "./config.js";
import { checkNotifyUrl, describeNotifyUrl, notifyFilePath, secretUsable, type NotifyFile } from "./notify.js";
import { hookPlan, hooksInstalled, installHooks, settingsPathFor, uninstallHooks, type HookPlan, type SettingsEdit } from "./hook-settings.js";

const execFileAsync = promisify(execFile);

export const HTTP_LABEL = "com.claude-remote.http";
export const TUNNEL_LABEL = "com.claude-remote.tunnel";

export const remoteConnector = {
  headerName: "Authorization",
  headerValue: "Bearer <token>",
  urlShape: "https://<your-tunnel>.trycloudflare.com/mcp",
} as const;

const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type CommandResult = { code: number; stdout: string; stderr: string };

export type InstallInput = {
  home: string;
  platform: NodeJS.Platform;
  uid: number;
  port: number;
  allowSend: boolean;
  allowLaunch: boolean;
  dryRun: boolean;
  nodeBin: string;
  entry: string;
  cloudflaredBin: string;
  cloudflaredPresent: boolean;
  brewBin: string;
  launchctlBin: string;
  claudeBin: string;
  urlWaitMs: number;
  allowApprove?: boolean;
  approveTimeoutS?: number;
  hooks?: boolean;
  configRoot?: string;
  now?: Date;
  bootstrapRetryMs?: number;
  notify?: NotifyFile | null;
};

export type InstallHooks = {
  run: (bin: string, args: string[]) => Promise<CommandResult>;
  build: () => Promise<void>;
};

export type InstallReport = {
  dryRun: boolean;
  tokenPath: string;
  url: string | null;
  port: number;
  brew: "install" | "skip";
  helperLabel: string;
  tunnelLabel: string;
  httpPlistPath: string;
  tunnelPlistPath: string;
  httpPlist: string;
  tunnelPlist: string;
  hookEvents: string[];
  hookScript: string | null;
  hooks: SettingsEdit | null;
  tunnelReloaded: boolean;
  notify: { url: string; signed: boolean; auth: string; includeText: boolean; cleared: boolean } | null;
};

export type StatusReport = {
  helper: "running" | "stopped";
  tunnel: "running" | "stopped";
  url: string | null;
  tokenPath: string;
  tokenFile: "present" | "missing";
  port: number;
};

export type UninstallReport = {
  dryRun: boolean;
  purge: boolean;
  removed: string[];
  hooks: SettingsEdit | { settingsPath: string; installed: boolean } | null;
};

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function serverEntry(): string {
  return path.join(packageRoot(), "dist", "index.js");
}

export function launchAgentsDir(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}

export function httpPlistPath(home: string): string {
  return path.join(launchAgentsDir(home), `${HTTP_LABEL}.plist`);
}

export function tunnelPlistPath(home: string): string {
  return path.join(launchAgentsDir(home), `${TUNNEL_LABEL}.plist`);
}

export function tunnelLogPath(home: string): string {
  return path.join(home, ".claude-remote", "tunnel", "cloudflared.log");
}

export function helperLogPath(home: string): string {
  return path.join(tokenDirectory(home), "helper.log");
}

export const CLOUDFLARED_SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;

export function portPath(home: string): string {
  return path.join(tokenDirectory(home), "port");
}

export function tunnelArguments(port: number, log: string): string[] {
  return [
    "tunnel",
    "--url",
    `http://${HTTP_HOST}:${port}`,
    "--http-host-header",
    `${HTTP_HOST}:${port}`,
    "--no-autoupdate",
    "--logfile",
    log,
  ];
}

export function publicUrlFromLog(text: string): string | null {
  const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  const last = found?.[found.length - 1];
  return last ? `${last}${MCP_SUFFIX}` : null;
}

const MCP_SUFFIX = "/mcp";

export function renderHttpPlist(input: InstallInput): string {
  return plist(HTTP_LABEL, [input.nodeBin, input.entry, "http"], {
    HOME: input.home,
    PATH: LAUNCHD_PATH,
    CLAUDE_REMOTE_ALLOW_SEND: input.allowSend ? "1" : "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: input.allowLaunch ? "1" : "0",
    CLAUDE_REMOTE_HTTP_PORT: String(input.port),
    CLAUDE_REMOTE_ALLOW_APPROVE: input.allowApprove ? "1" : "0",
    CLAUDE_REMOTE_APPROVE_TIMEOUT_S: String(input.approveTimeoutS ?? DEFAULT_APPROVE_TIMEOUT_S),
    ...(path.isAbsolute(input.claudeBin) ? { CLAUDE_REMOTE_CLAUDE_BIN: input.claudeBin } : {}),
  }, {
    out: helperLogPath(input.home),
    err: helperLogPath(input.home),
  });
}

function checkNotifyInput(notify: NotifyFile | null | undefined): notify is NotifyFile {
  if (!notify) return false;
  if (!checkNotifyUrl(notify.url)) throw new DeskError("usage", "--notify-url must be https, or http on 127.0.0.1 or localhost, with no user name or password");
  if (notify.secret !== undefined && !secretUsable(notify.secret)) throw new DeskError("usage", "--notify-secret must be 16 to 512 characters with no spaces or quotes");
  return true;
}

function planFor(input: InstallInput): HookPlan {
  return hookPlan(input.nodeBin, input.entry, input.approveTimeoutS ?? DEFAULT_APPROVE_TIMEOUT_S);
}

export function renderTunnelPlist(input: InstallInput): string {
  const log = tunnelLogPath(input.home);
  return plist(TUNNEL_LABEL, [input.cloudflaredBin, ...tunnelArguments(input.port, log)], {
    HOME: input.home,
    PATH: LAUNCHD_PATH,
  }, { out: log, err: log });
}

export async function executeInstall(input: InstallInput, hooks: InstallHooks = defaultHooks()): Promise<InstallReport> {
  if (input.platform !== "darwin" && !input.dryRun) {
    throw new DeskError("unsupported-platform", "install writes LaunchAgents on macOS");
  }
  const report: InstallReport = {
    dryRun: input.dryRun,
    tokenPath: tokenPath(input.home),
    url: null,
    port: input.port,
    brew: input.cloudflaredPresent ? "skip" : "install",
    helperLabel: HTTP_LABEL,
    tunnelLabel: TUNNEL_LABEL,
    httpPlistPath: httpPlistPath(input.home),
    tunnelPlistPath: tunnelPlistPath(input.home),
    httpPlist: renderHttpPlist(input),
    tunnelPlist: renderTunnelPlist(input),
    hookEvents: input.hooks === false ? [] : Object.keys(planFor(input)),
    hookScript: null,
    hooks: null,
    tunnelReloaded: false,
    notify: checkNotifyInput(input.notify) ? {
      url: describeNotifyUrl(input.notify.url),
      signed: Boolean(input.notify.secret),
      auth: input.notify.auth ?? "hmac",
      includeText: input.notify.includeText === true,
      cleared: input.notify.cleared === true,
    } : null,
  };
  if (input.dryRun) return report;
  await hooks.build();
  if (!input.cloudflaredPresent) {
    const installed = await hooks.run(input.brewBin, ["install", "cloudflared"]);
    if (installed.code !== 0) throw new DeskError("brew-failed", "cloudflared install failed");
  }
  await ensureToken(input.home);
  await writePrivate(portPath(input.home), `${input.port}\n`);
  // The helper reads the alert endpoint and secret from this file, so neither goes in the plist.
  if (input.notify) await writePrivate(notifyFilePath(input.home), `${JSON.stringify(input.notify)}\n`);
  else await unlinkFile(notifyFilePath(input.home));
  await ensureLog(helperLogPath(input.home));
  await ensureLog(tunnelLogPath(input.home));
  await writePrivate(report.httpPlistPath, report.httpPlist, "launchAgents");
  const previousTunnel = await readPlainFile(report.tunnelPlistPath);
  await writePrivate(report.tunnelPlistPath, report.tunnelPlist, "launchAgents");
  const domain = `gui/${input.uid}`;
  // A quick tunnel gets a new hostname every time it starts, so leave a loaded tunnel with an
  // unchanged plist running. The helper always reloads, to pick up the new build.
  const tunnelLoaded = (await hooks.run(input.launchctlBin, ["print", `${domain}/${TUNNEL_LABEL}`])).code === 0;
  report.tunnelReloaded = !(tunnelLoaded && previousTunnel === report.tunnelPlist);
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${HTTP_LABEL}`]);
  if (report.tunnelReloaded) await hooks.run(input.launchctlBin, ["bootout", `${domain}/${TUNNEL_LABEL}`]);
  const httpBoot = await bootstrapWithRetry(hooks, input.launchctlBin, domain, report.httpPlistPath, input.bootstrapRetryMs);
  if (httpBoot !== 0) throw new DeskError("launchctl-failed", "http helper did not load");
  if (report.tunnelReloaded) {
    const tunnelBoot = await bootstrapWithRetry(hooks, input.launchctlBin, domain, report.tunnelPlistPath, input.bootstrapRetryMs);
    if (tunnelBoot !== 0) throw new DeskError("launchctl-failed", "tunnel did not load");
  }
  await registerChannel(input, hooks);
  if (input.hooks !== false) {
    // Each event runs a small sh script that talks to the helper with curl, instead of starting Node.
    report.hookScript = await writeHookScript(input.home, input.nodeBin, input.entry);
    const plan = hookPlan(input.nodeBin, input.entry, input.approveTimeoutS ?? DEFAULT_APPROVE_TIMEOUT_S, report.hookScript);
    report.hooks = await installHooks(input.configRoot ?? path.join(input.home, ".claude"), plan, input.now);
  }
  report.url = await waitForUrl(input.home, input.urlWaitMs);
  return report;
}

export async function executeStatus(
  home: string,
  uid: number,
  launchctlBin: string,
  hooks: InstallHooks = defaultHooks(),
): Promise<StatusReport> {
  const domain = `gui/${uid}`;
  const helper = await hooks.run(launchctlBin, ["print", `${domain}/${HTTP_LABEL}`]);
  const tunnel = await hooks.run(launchctlBin, ["print", `${domain}/${TUNNEL_LABEL}`]);
  return {
    helper: helper.code === 0 ? "running" : "stopped",
    tunnel: tunnel.code === 0 ? "running" : "stopped",
    url: await readUrl(home),
    tokenPath: tokenPath(home),
    tokenFile: await tokenPresent(home) ? "present" : "missing",
    port: await readPort(home),
  };
}

export async function executeUninstall(
  input: { home: string; uid: number; dryRun: boolean; purge: boolean; launchctlBin: string; claudeBin: string; configRoot?: string; now?: Date },
  hooks: InstallHooks = defaultHooks(),
): Promise<UninstallReport> {
  const configRoot = input.configRoot ?? path.join(input.home, ".claude");
  const removed = [
    httpPlistPath(input.home),
    tunnelPlistPath(input.home),
    tokenPath(input.home),
    portPath(input.home),
    tunnelLogPath(input.home),
    notifyFilePath(input.home),
  ];
  if (input.dryRun) {
    return { dryRun: true, purge: input.purge, removed, hooks: { settingsPath: settingsPathFor(configRoot), installed: await hooksInstalled(configRoot) } };
  }
  const domain = `gui/${input.uid}`;
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${HTTP_LABEL}`]);
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${TUNNEL_LABEL}`]);
  for (const file of removed) await unlinkFile(file);
  await hooks.run(input.claudeBin, ["mcp", "remove", "--scope", "user", "claude-remote-channel"]);
  const settings = await uninstallHooks(configRoot, input.now);
  await removeHookScript(input.home);
  if (input.purge) {
    for (const name of ["attachments", "queue", "inbox", "launches", "c", "channel", "mcp", "http", "tunnel"]) {
      await rmTreeSafe(path.join(input.home, ".claude-remote", name));
    }
  }
  return { dryRun: false, purge: input.purge, removed, hooks: settings };
}

export function defaultHooks(): InstallHooks {
  return { run: defaultRun, build: defaultBuild };
}

// launchd starts the helper with a fixed PATH, so pin the CLI the installer found.
export async function resolveClaudeBin(bin: string, searchPath: string | undefined): Promise<string> {
  if (bin.includes("/")) return path.resolve(bin);
  for (const dir of (searchPath ?? "").split(":")) {
    if (!dir || !path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, bin);
    if (await cloudflaredPresent(candidate)) return candidate;
  }
  return bin;
}

export async function cloudflaredPresent(bin: string): Promise<boolean> {
  try {
    await access(bin, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCloudflared(
  env: NodeJS.ProcessEnv,
  extraDirs: readonly string[] = CLOUDFLARED_SEARCH_DIRS,
): Promise<{ bin: string; present: boolean }> {
  const override = env.CLAUDE_REMOTE_CLOUDFLARED_BIN;
  if (override) return { bin: override, present: await cloudflaredPresent(override) };
  const seen = new Set<string>();
  const dirs = [...(env.PATH ?? "").split(path.delimiter).filter((dir) => dir.length > 0), ...extraDirs];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, "cloudflared");
    if (await cloudflaredPresent(candidate)) return { bin: candidate, present: true };
  }
  return { bin: "cloudflared", present: false };
}

export function stableNodeBin(execPath: string, commandV: string | null): string {
  const preferred = commandV && commandV.length > 0 ? commandV : null;
  if (preferred && !preferred.includes(`${path.sep}Cellar${path.sep}`)) return preferred;
  const mapped = optNode(preferred ?? execPath);
  return mapped ?? execPath;
}

export async function commandVNode(env: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const result = await execFileAsync("/bin/sh", ["-c", "command -v node"], {
      timeout: 2000,
      maxBuffer: 4096,
      env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" },
    });
    const line = String(result.stdout ?? "").trim().split("\n")[0] ?? "";
    if (line.length === 0 || line.includes("\0") || line.includes("\n")) return null;
    return line;
  } catch {
    return null;
  }
}

function optNode(bin: string): string | null {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(bin);
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/opt/${match[2]}/bin/node`;
}

export async function ensureLog(file: string): Promise<void> {
  await mkdirPrivate(path.dirname(file));
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink()) throw new DeskError("denied", "refusing to follow a symlink");
    if (!existing.isFile()) throw new DeskError("denied", "log path is not a file");
    await chmod(file, 0o600);
    return;
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(file).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(file, 0o600);
}

// launchctl bootout returns before launchd has finished removing a running job, and a bootstrap
// of the same label fails until it has (EIO). Retry for a few seconds.
async function bootstrapWithRetry(
  hooks: InstallHooks,
  launchctlBin: string,
  domain: string,
  plistPath: string,
  delayMs = 500,
): Promise<number> {
  let code = 1;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    code = (await hooks.run(launchctlBin, ["bootstrap", domain, plistPath])).code ?? 1;
    if (code === 0) return 0;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return code;
}

async function readPlainFile(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function registerChannel(input: InstallInput, hooks: InstallHooks): Promise<void> {
  const got = await hooks.run(input.claudeBin, ["mcp", "get", "claude-remote-channel"]);
  if (got.code === 0) return;
  const added = await hooks.run(input.claudeBin, [
    "mcp",
    "add",
    "--scope",
    "user",
    "claude-remote-channel",
    "--",
    input.nodeBin,
    input.entry,
    "channel",
  ]);
  if (added.code !== 0) throw new DeskError("channel-register", "channel registration failed");
}

async function waitForUrl(home: string, waitMs: number): Promise<string | null> {
  const deadline = Date.now() + waitMs;
  let url = await readUrl(home);
  while (!url && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    url = await readUrl(home);
  }
  return url;
}

async function readUrl(home: string): Promise<string | null> {
  try {
    const info = await lstat(tunnelLogPath(home));
    if (info.isSymbolicLink() || !info.isFile()) return null;
    const handle = await open(tunnelLogPath(home), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const text = await handle.readFile({ encoding: "utf8" });
      return publicUrlFromLog(text.slice(0, 1_000_000));
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

async function readPort(home: string): Promise<number> {
  try {
    const text = (await readFile(portPath(home), "utf8")).trim();
    const parsed = Number(text);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  } catch {
    return HTTP_PORT;
  }
  return HTTP_PORT;
}

async function tokenPresent(home: string): Promise<boolean> {
  try {
    const info = await lstat(tokenPath(home));
    return info.isFile() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function defaultRun(bin: string, args: string[]): Promise<CommandResult> {
  assertSpawnAllowed(bin);
  try {
    const result = await execFileAsync(bin, args, { timeout: 120000, maxBuffer: 1_000_000 });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: unknown; stderr?: unknown };
    if (failed.code === "ENOENT") return { code: 127, stdout: "", stderr: "" };
    const code = typeof failed.code === "number" ? failed.code : 1;
    return { code, stdout: String(failed.stdout ?? ""), stderr: String(failed.stderr ?? "") };
  }
}

async function defaultBuild(): Promise<void> {
  assertSpawnAllowed("npm");
  try {
    await execFileAsync("npm", ["run", "build"], { cwd: packageRoot(), timeout: 120000, maxBuffer: 1_000_000 });
  } catch {
    throw new DeskError("build-failed", "build failed");
  }
}

function plist(label: string, args: string[], env: Record<string, string>, logs: { out: string; err: string }): string {
  const argumentsXml = args.map((arg) => `<string>${xml(arg)}</string>`).join("");
  const envXml = Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProgramArguments</key><array>${argumentsXml}</array><key>EnvironmentVariables</key><dict>${envXml}</dict><key>StandardOutPath</key><string>${xml(logs.out)}</string><key>StandardErrorPath</key><string>${xml(logs.err)}</string></dict></plist>
`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function writePrivate(file: string, text: string, parent: "private" | "launchAgents" = "private"): Promise<void> {
  switch (parent) {
    case "private":
      await mkdirPrivate(path.dirname(file));
      break;
    case "launchAgents":
      await mkdirLaunchAgents(path.dirname(file));
      break;
    default: {
      const _never: never = parent;
      return assertNever(_never);
    }
  }
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink()) throw new DeskError("denied", "refusing to follow a symlink");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(tmp, file);
  await chmod(file, 0o600);
}

async function mkdirLaunchAgents(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new DeskError("denied", "directory is not allowed");
    return;
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  await mkdir(dir, { recursive: true });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "directory is not allowed");
  await chmod(dir, 0o755);
}

async function mkdirPrivate(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new DeskError("denied", "directory is not allowed");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "directory is not allowed");
  await chmod(dir, 0o700);
}

async function unlinkFile(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return;
    if (path.basename(file).includes(".key")) return;
    await unlink(file);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

async function rmTreeSafe(dir: string): Promise<void> {
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    await unlinkFile(dir);
    return;
  }
  for (const name of await readdir(dir)) {
    if (name.includes(".key")) continue;
    await rmTreeSafe(path.join(dir, name));
  }
  const left = await readdir(dir);
  if (left.length === 0) await rmdir(dir);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
