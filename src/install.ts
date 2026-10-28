import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, readdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DeskError, assertNever } from "./domain.js";
import { ensureLog, readPlainFile, readTail, unlinkFile, writePrivate } from "./files.js";
import { localProbeUrl, parseLaunchctlPrint, probeUrl, quickTunnelUrl, summarizeTunnelLog, type LaunchdJob, type ProbeFn } from "./health.js";
import { removeHookScript, writeHookScript } from "./hook-script.js";
import { HTTP_HOST, HTTP_PORT } from "./http.js";
import {
  HTTP_LABEL,
  TUNNEL_LABEL,
  WATCHDOG_LABEL,
  httpPlistPath,
  launchAgentsDir,
  plist,
  tunnelPlistPath,
  watchdogPlistPath,
  type CommandResult,
} from "./launchd.js";
import { assertSpawnAllowed } from "./launch.js";
import { inspectOauthToken, oauthTokenPath, OAUTH_TOKEN_WARN_AGE_DAYS, type OauthTokenState } from "./oauth.js";
import { pendingFilePath } from "./pending-file.js";
import { ensureToken, tokenDirectory, tokenPath } from "./token.js";
import { DEFAULT_APPROVE_TIMEOUT_S } from "./config.js";
import { checkNotifyUrl, describeNotifyUrl, notifyFilePath, secretUsable, type NotifyFile } from "./notify.js";
import { hookPlan, hooksInstalled, installHooks, settingsPathFor, uninstallHooks, type HookPlan, type SettingsEdit } from "./hook-settings.js";
import {
  fixedPublicUrl,
  funnelArguments,
  funnelHostnameFromStatus,
  managesTunnelProcess,
  namedConfigPath,
  publicHostname,
  readTunnelSettings,
  renderNamedConfig,
  tunnelProcessArguments,
  tunnelSettingsPath,
  writeTunnelSettings,
  type TunnelMode,
  type TunnelSettings,
} from "./tunnel.js";
import {
  DEFAULT_WATCHDOG_INTERVAL_S,
  helperLogPath,
  readWatchdogState,
  tunnelLogPath,
  watchdogLogPath,
  watchdogStatePath,
} from "./watchdog.js";

export { HTTP_LABEL, TUNNEL_LABEL, WATCHDOG_LABEL, httpPlistPath, launchAgentsDir, tunnelPlistPath, watchdogPlistPath, type CommandResult } from "./launchd.js";
export { helperLogPath, tunnelLogPath } from "./watchdog.js";
export { ensureLog } from "./files.js";

const execFileAsync = promisify(execFile);

export const remoteConnector = {
  headerName: "Authorization",
  headerValue: "Bearer <token>",
  urlShape: "https://<your-tunnel>.trycloudflare.com/mcp",
} as const;

const LAUNCHD_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const URL_TAIL_BYTES = 1024 * 1024;

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
  /** How the helper is reached from outside. Defaults to a quick tunnel, as before. */
  tunnel?: TunnelSettings;
  /** Install the watchdog LaunchAgent. Defaults to on. */
  watchdog?: boolean;
  watchdogIntervalS?: number;
  tailscaleBin?: string;
  oauthTokenFile?: string;
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
  watchdogLabel: string;
  httpPlistPath: string;
  tunnelPlistPath: string;
  watchdogPlistPath: string;
  httpPlist: string;
  /** Empty for a mode without a cloudflared LaunchAgent (funnel, none). */
  tunnelPlist: string;
  watchdogPlist: string | null;
  tunnelMode: TunnelMode;
  publicHost: string | null;
  tunnelSettingsPath: string;
  namedConfigPath: string | null;
  /** The tailscale command install runs (or would run) for the funnel mode. */
  funnelCommand: string | null;
  oauthTokenPath: string;
  oauthTokenFile: OauthTokenState;
  hookEvents: string[];
  hookScript: string | null;
  hooks: SettingsEdit | null;
  tunnelReloaded: boolean;
  notify: { url: string; signed: boolean; auth: string; includeText: boolean; cleared: boolean } | null;
};

export type StatusVerdict =
  | "ok"
  | "ok-no-tunnel"
  | "helper-not-loaded"
  | "helper-not-answering"
  | "tunnel-not-loaded"
  | "no-public-url"
  | "public-not-answering";

export type StatusReport = {
  /** The one line to act on. */
  verdict: StatusVerdict;
  checkedAt: string;
  helper: "running" | "stopped";
  helperPid: number | null;
  helperLastExit: number | null;
  /** Did GET http://127.0.0.1:<port>/mcp get the helper's 401 challenge? */
  helperAnswers: "yes" | "no" | "skipped";
  helperDetail: string | null;
  tunnelMode: TunnelMode;
  /** running or stopped for a cloudflared LaunchAgent; external for Tailscale Funnel; none when no tunnel is managed. */
  tunnel: "running" | "stopped" | "external" | "none";
  tunnelPid: number | null;
  tunnelRuns: number | null;
  tunnelLastExit: number | null;
  tunnelLastRegistered: string | null;
  tunnelLastRetry: string | null;
  tunnelRetries10m: number;
  tunnelConnected: "yes" | "no" | "unknown";
  tunnelLogBytes: number;
  url: string | null;
  /** Did GET <url> get the helper's 401 challenge through the tunnel? */
  publicAnswers: "yes" | "no" | "skipped";
  publicDetail: string | null;
  tokenPath: string;
  tokenFile: "present" | "missing";
  port: number;
  oauthTokenPath: string;
  oauthTokenFile: OauthTokenState;
  oauthTokenMode: string | null;
  oauthTokenAgeDays: number | null;
  oauthTokenWarning: string | null;
  watchdog: "loaded" | "missing";
  watchdogLastRun: string | null;
  watchdogLastVerdict: string | null;
  watchdogHelperRestarts: number;
  watchdogTunnelRestarts: number;
};

export type UninstallReport = {
  dryRun: boolean;
  purge: boolean;
  removed: string[];
  hooks: SettingsEdit | { settingsPath: string; installed: boolean } | null;
  funnelCommand: string | null;
};

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function serverEntry(): string {
  return path.join(packageRoot(), "dist", "index.js");
}

export const CLOUDFLARED_SEARCH_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"] as const;
export const TAILSCALE_SEARCH_DIRS = ["/Applications/Tailscale.app/Contents/MacOS", "/opt/homebrew/bin", "/usr/local/bin"] as const;

export function portPath(home: string): string {
  return path.join(tokenDirectory(home), "port");
}

/** The quick-tunnel arguments. Kept for callers that predate tunnel modes. */
export function tunnelArguments(port: number, log: string): string[] {
  return tunnelProcessArguments({ mode: "quick" }, port, log, "") ?? [];
}

export function publicUrlFromLog(text: string): string | null {
  return quickTunnelUrl(text);
}

export function renderHttpPlist(input: InstallInput): string {
  const publicHost = publicHostname(input.tunnel ?? { mode: "quick" });
  return plist(HTTP_LABEL, [input.nodeBin, input.entry, "http"], {
    HOME: input.home,
    PATH: LAUNCHD_PATH,
    CLAUDE_REMOTE_ALLOW_SEND: input.allowSend ? "1" : "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: input.allowLaunch ? "1" : "0",
    CLAUDE_REMOTE_HTTP_PORT: String(input.port),
    CLAUDE_REMOTE_ALLOW_APPROVE: input.allowApprove ? "1" : "0",
    CLAUDE_REMOTE_APPROVE_TIMEOUT_S: String(input.approveTimeoutS ?? DEFAULT_APPROVE_TIMEOUT_S),
    ...(path.isAbsolute(input.claudeBin) ? { CLAUDE_REMOTE_CLAUDE_BIN: input.claudeBin } : {}),
    ...(publicHost ? { CLAUDE_REMOTE_PUBLIC_HOST: publicHost } : {}),
  }, {
    out: helperLogPath(input.home),
    err: helperLogPath(input.home),
  });
}

export function renderTunnelPlist(input: InstallInput): string {
  const log = tunnelLogPath(input.home);
  const args = tunnelProcessArguments(input.tunnel ?? { mode: "quick" }, input.port, log, input.home);
  if (!args) return "";
  return plist(TUNNEL_LABEL, [input.cloudflaredBin, ...args], {
    HOME: input.home,
    PATH: LAUNCHD_PATH,
  }, { out: log, err: log });
}

export function renderWatchdogPlist(input: InstallInput): string {
  const log = watchdogLogPath(input.home);
  return plist(WATCHDOG_LABEL, [input.nodeBin, input.entry, "watchdog"], {
    HOME: input.home,
    PATH: LAUNCHD_PATH,
    CLAUDE_REMOTE_HTTP_PORT: String(input.port),
  }, { out: log, err: log }, { kind: "interval", intervalS: input.watchdogIntervalS ?? DEFAULT_WATCHDOG_INTERVAL_S });
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

/** A funnel install without --hostname asks tailscaled for this node's MagicDNS name. */
async function resolveFunnelHostname(input: InstallInput, settings: TunnelSettings, hooks: InstallHooks): Promise<TunnelSettings> {
  if (settings.mode !== "funnel" || settings.hostname) return settings;
  const bin = input.tailscaleBin;
  if (!bin) throw new DeskError("tailscale-missing", "tailscale was not found; pass --hostname=<node>.<tailnet>.ts.net or CLAUDE_REMOTE_TAILSCALE_BIN");
  const status = await hooks.run(bin, ["status", "--json"]);
  const hostname = status.code === 0 ? funnelHostnameFromStatus(status.stdout) : null;
  if (!hostname) throw new DeskError("tailscale-status", "tailscale status --json did not report a MagicDNS name; pass --hostname");
  return { mode: "funnel", hostname };
}

export async function executeInstall(rawInput: InstallInput, hooks: InstallHooks = defaultHooks()): Promise<InstallReport> {
  if (rawInput.platform !== "darwin" && !rawInput.dryRun) {
    throw new DeskError("unsupported-platform", "install writes LaunchAgents on macOS");
  }
  const settings = await resolveFunnelHostname(rawInput, rawInput.tunnel ?? { mode: "quick" }, hooks);
  const input: InstallInput = { ...rawInput, tunnel: settings };
  const watchdog = input.watchdog !== false;
  const needsCloudflared = managesTunnelProcess(settings);
  const oauthFile = input.oauthTokenFile ?? oauthTokenPath(input.home);
  const report: InstallReport = {
    dryRun: input.dryRun,
    tokenPath: tokenPath(input.home),
    url: fixedPublicUrl(settings),
    port: input.port,
    brew: needsCloudflared && !input.cloudflaredPresent ? "install" : "skip",
    helperLabel: HTTP_LABEL,
    tunnelLabel: TUNNEL_LABEL,
    watchdogLabel: WATCHDOG_LABEL,
    httpPlistPath: httpPlistPath(input.home),
    tunnelPlistPath: tunnelPlistPath(input.home),
    watchdogPlistPath: watchdogPlistPath(input.home),
    httpPlist: renderHttpPlist(input),
    tunnelPlist: renderTunnelPlist(input),
    watchdogPlist: watchdog ? renderWatchdogPlist(input) : null,
    tunnelMode: settings.mode,
    publicHost: publicHostname(settings),
    tunnelSettingsPath: tunnelSettingsPath(input.home),
    namedConfigPath: settings.mode === "named" ? namedConfigPath(input.home) : null,
    funnelCommand: settings.mode === "funnel" ? [input.tailscaleBin ?? "tailscale", ...funnelArguments(input.port)].join(" ") : null,
    oauthTokenPath: oauthFile,
    oauthTokenFile: (await inspectOauthToken(oauthFile)).state,
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
  if (report.brew === "install") {
    const installed = await hooks.run(input.brewBin, ["install", "cloudflared"]);
    if (installed.code !== 0) throw new DeskError("brew-failed", "cloudflared install failed");
  }
  if (settings.mode === "funnel" && !input.tailscaleBin) {
    throw new DeskError("tailscale-missing", "tailscale was not found; install Tailscale or set CLAUDE_REMOTE_TAILSCALE_BIN");
  }
  await ensureToken(input.home);
  await writePrivate(portPath(input.home), `${input.port}\n`);
  // The helper reads the alert endpoint and secret from this file, so neither goes in the plist.
  if (input.notify) await writePrivate(notifyFilePath(input.home), `${JSON.stringify(input.notify)}\n`);
  else await unlinkFile(notifyFilePath(input.home));
  await ensureLog(helperLogPath(input.home));
  await ensureLog(tunnelLogPath(input.home));
  await ensureLog(watchdogLogPath(input.home));
  await writePrivate(report.httpPlistPath, report.httpPlist, "launchAgents");
  const domain = `gui/${input.uid}`;
  const tunnelLoaded = (await hooks.run(input.launchctlBin, ["print", `${domain}/${TUNNEL_LABEL}`])).code === 0;
  if (needsCloudflared) {
    if (settings.mode === "named") await writePrivate(namedConfigPath(input.home), renderNamedConfig(settings, input.port));
    else await unlinkFile(namedConfigPath(input.home));
    const previousTunnel = await readPlainFile(report.tunnelPlistPath);
    await writePrivate(report.tunnelPlistPath, report.tunnelPlist, "launchAgents");
    // A quick tunnel gets a new hostname every time it starts, so leave a loaded tunnel with an
    // unchanged plist running. The helper always reloads, to pick up the new build.
    report.tunnelReloaded = !(tunnelLoaded && previousTunnel === report.tunnelPlist);
  } else {
    // Funnel and none: no cloudflared job. Take down one left by an earlier quick-tunnel install.
    if (tunnelLoaded) await hooks.run(input.launchctlBin, ["bootout", `${domain}/${TUNNEL_LABEL}`]);
    await unlinkFile(report.tunnelPlistPath);
    await unlinkFile(namedConfigPath(input.home));
  }
  await writeTunnelSettings(input.home, settings);
  if (report.watchdogPlist) await writePrivate(report.watchdogPlistPath, report.watchdogPlist, "launchAgents");
  else await unlinkFile(report.watchdogPlistPath);
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${HTTP_LABEL}`]);
  if (report.tunnelReloaded) await hooks.run(input.launchctlBin, ["bootout", `${domain}/${TUNNEL_LABEL}`]);
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${WATCHDOG_LABEL}`]);
  const httpBoot = await bootstrapWithRetry(hooks, input.launchctlBin, domain, report.httpPlistPath, input.bootstrapRetryMs);
  if (httpBoot !== 0) throw new DeskError("launchctl-failed", "http helper did not load");
  if (report.tunnelReloaded) {
    const tunnelBoot = await bootstrapWithRetry(hooks, input.launchctlBin, domain, report.tunnelPlistPath, input.bootstrapRetryMs);
    if (tunnelBoot !== 0) throw new DeskError("launchctl-failed", "tunnel did not load");
  }
  if (settings.mode === "funnel" && input.tailscaleBin) {
    const funnel = await hooks.run(input.tailscaleBin, funnelArguments(input.port));
    if (funnel.code !== 0) throw new DeskError("funnel-failed", "tailscale funnel did not start; is Funnel enabled for this node in the admin console?");
  }
  if (report.watchdogPlist) {
    const watchdogBoot = await bootstrapWithRetry(hooks, input.launchctlBin, domain, report.watchdogPlistPath, input.bootstrapRetryMs);
    if (watchdogBoot !== 0) throw new DeskError("launchctl-failed", "watchdog did not load");
  }
  await registerChannel(input, hooks);
  if (input.hooks !== false) {
    // Each event runs a small sh script that talks to the helper with curl, instead of starting Node.
    report.hookScript = await writeHookScript(input.home, input.nodeBin, input.entry);
    const plan = hookPlan(input.nodeBin, input.entry, input.approveTimeoutS ?? DEFAULT_APPROVE_TIMEOUT_S, report.hookScript);
    report.hooks = await installHooks(input.configRoot ?? path.join(input.home, ".claude"), plan, input.now);
  }
  if (settings.mode === "quick") report.url = await waitForUrl(input.home, input.urlWaitMs);
  return report;
}

export type StatusOptions = {
  /** null skips both probes (status --no-probe); undefined uses the real HTTP probe. */
  probe?: ProbeFn | null;
  now?: number;
  oauthTokenFile?: string;
};

export async function executeStatus(
  home: string,
  uid: number,
  launchctlBin: string,
  hooks: InstallHooks = defaultHooks(),
  options: StatusOptions = {},
): Promise<StatusReport> {
  const domain = `gui/${uid}`;
  const now = options.now ?? Date.now();
  const job = async (label: string): Promise<LaunchdJob> => {
    const printed = await hooks.run(launchctlBin, ["print", `${domain}/${label}`]);
    return parseLaunchctlPrint(printed.code, printed.stdout);
  };
  const settings = await readTunnelSettings(home);
  const helperJob = await job(HTTP_LABEL);
  const tunnelJob = managesTunnelProcess(settings) ? await job(TUNNEL_LABEL) : null;
  const watchdogJob = await job(WATCHDOG_LABEL);
  const tail = await readTail(tunnelLogPath(home), URL_TAIL_BYTES);
  const summary = summarizeTunnelLog(tail, now);
  const url = fixedPublicUrl(settings) ?? (settings.mode === "quick" ? summary.url : null);
  const port = await readPort(home);
  const probe = options.probe === null ? null : (options.probe ?? ((target) => probeUrl(target)));
  const helperProbe = probe ? await probe(localProbeUrl(port)) : null;
  const publicProbe = probe && url ? await probe(url) : null;
  const oauth = await inspectOauthToken(options.oauthTokenFile ?? oauthTokenPath(home), now);
  const watchdogState = await readWatchdogState(home);
  let logBytes = 0;
  try {
    const info = await lstat(tunnelLogPath(home));
    if (info.isFile()) logBytes = info.size;
  } catch {
    logBytes = 0;
  }
  const helperRunning = helperJob.loaded && !(helperJob.state && helperJob.state !== "running" && helperJob.pid == null);
  const tunnelRunning = tunnelJob ? tunnelJob.loaded && !(tunnelJob.state && tunnelJob.state !== "running" && tunnelJob.pid == null) : false;
  const report: StatusReport = {
    verdict: "ok",
    checkedAt: new Date(now).toISOString(),
    helper: helperRunning ? "running" : "stopped",
    helperPid: helperJob.pid,
    helperLastExit: helperJob.lastExitCode,
    helperAnswers: helperProbe ? (helperProbe.state === "answers" ? "yes" : "no") : "skipped",
    helperDetail: helperProbe && helperProbe.state !== "answers" ? `${helperProbe.state}${helperProbe.detail ? `:${helperProbe.detail}` : ""}` : null,
    tunnelMode: settings.mode,
    tunnel: settings.mode === "none" ? "none" : settings.mode === "funnel" ? "external" : tunnelRunning ? "running" : "stopped",
    tunnelPid: tunnelJob?.pid ?? null,
    tunnelRuns: tunnelJob?.runs ?? null,
    tunnelLastExit: tunnelJob?.lastExitCode ?? null,
    tunnelLastRegistered: summary.lastRegistered,
    tunnelLastRetry: summary.lastRetry,
    tunnelRetries10m: summary.retriesLast10m,
    tunnelConnected: summary.connected == null ? "unknown" : summary.connected ? "yes" : "no",
    tunnelLogBytes: logBytes,
    url,
    publicAnswers: publicProbe ? (publicProbe.state === "answers" ? "yes" : "no") : "skipped",
    publicDetail: publicProbe && publicProbe.state !== "answers" ? `${publicProbe.state}${publicProbe.detail ? `:${publicProbe.detail}` : ""}` : null,
    tokenPath: tokenPath(home),
    tokenFile: await tokenPresent(home) ? "present" : "missing",
    port,
    oauthTokenPath: oauth.path,
    oauthTokenFile: oauth.state,
    oauthTokenMode: oauth.mode,
    oauthTokenAgeDays: oauth.ageDays,
    oauthTokenWarning: oauthWarning(oauth.state, oauth.ageDays),
    watchdog: watchdogJob.loaded ? "loaded" : "missing",
    watchdogLastRun: watchdogState.lastRunAt,
    watchdogLastVerdict: watchdogState.lastVerdict,
    watchdogHelperRestarts: watchdogState.helperRestarts,
    watchdogTunnelRestarts: watchdogState.tunnelRestarts,
  };
  report.verdict = verdictFor(report, settings);
  return report;
}

function oauthWarning(state: OauthTokenState, ageDays: number | null): string | null {
  switch (state) {
    case "present":
      return ageDays != null && ageDays >= OAUTH_TOKEN_WARN_AGE_DAYS
        ? `the setup-token file is ${ageDays} days old; setup-token tokens last one year, so replace it soon`
        : null;
    case "missing":
      return "no setup-token file; headless claude children use the interactive login, which expires";
    case "bad-mode":
      return "the token file is ignored because its mode is not 0600 (chmod 600 it)";
    case "symlink":
      return "the token file is ignored because it is a symlink";
    case "not-a-file":
      return "the token file path is not a regular file";
    case "empty":
      return "the token file is ignored because it is empty";
    case "bad-shape":
      return "the token file is ignored because its first line does not look like a token";
    default: {
      const _never: never = state;
      return assertNever(_never);
    }
  }
}

function verdictFor(report: StatusReport, settings: TunnelSettings): StatusVerdict {
  if (report.helper !== "running") return "helper-not-loaded";
  if (report.helperAnswers === "no") return "helper-not-answering";
  if (settings.mode === "none") return "ok-no-tunnel";
  if (managesTunnelProcess(settings) && report.tunnel !== "running") return "tunnel-not-loaded";
  if (!report.url) return "no-public-url";
  if (report.publicAnswers === "no") return "public-not-answering";
  return "ok";
}

export async function executeUninstall(
  input: { home: string; uid: number; dryRun: boolean; purge: boolean; launchctlBin: string; claudeBin: string; tailscaleBin?: string; configRoot?: string; now?: Date },
  hooks: InstallHooks = defaultHooks(),
): Promise<UninstallReport> {
  const configRoot = input.configRoot ?? path.join(input.home, ".claude");
  const settings = await readTunnelSettings(input.home);
  const port = await readPort(input.home);
  const removed = [
    httpPlistPath(input.home),
    tunnelPlistPath(input.home),
    watchdogPlistPath(input.home),
    pendingFilePath(input.home),
    tokenPath(input.home),
    portPath(input.home),
    tunnelLogPath(input.home),
    `${tunnelLogPath(input.home)}.1`,
    tunnelSettingsPath(input.home),
    namedConfigPath(input.home),
    watchdogStatePath(input.home),
    watchdogLogPath(input.home),
    `${watchdogLogPath(input.home)}.1`,
    notifyFilePath(input.home),
  ];
  const funnelCommand = settings.mode === "funnel" ? [input.tailscaleBin ?? "tailscale", ...funnelArguments(port, true)].join(" ") : null;
  if (input.dryRun) {
    return { dryRun: true, purge: input.purge, removed, hooks: { settingsPath: settingsPathFor(configRoot), installed: await hooksInstalled(configRoot) }, funnelCommand };
  }
  const domain = `gui/${input.uid}`;
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${HTTP_LABEL}`]);
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${TUNNEL_LABEL}`]);
  await hooks.run(input.launchctlBin, ["bootout", `${domain}/${WATCHDOG_LABEL}`]);
  if (settings.mode === "funnel" && input.tailscaleBin) await hooks.run(input.tailscaleBin, funnelArguments(port, true));
  for (const file of removed) await unlinkFile(file);
  await hooks.run(input.claudeBin, ["mcp", "remove", "--scope", "user", "claude-remote-channel"]);
  const settingsEdit = await uninstallHooks(configRoot, input.now);
  await removeHookScript(input.home);
  if (input.purge) {
    for (const name of ["attachments", "queue", "inbox", "launches", "c", "channel", "mcp", "http", "tunnel", "watchdog"]) {
      await rmTreeSafe(path.join(input.home, ".claude-remote", name));
    }
  }
  return { dryRun: false, purge: input.purge, removed, hooks: settingsEdit, funnelCommand };
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
  return resolveBinary("cloudflared", env.CLAUDE_REMOTE_CLOUDFLARED_BIN, env.PATH, extraDirs);
}

/** The tailscale CLI: the app bundle's binary on a Mac, or a PATH install. */
export async function resolveTailscale(
  env: NodeJS.ProcessEnv,
  extraDirs: readonly string[] = TAILSCALE_SEARCH_DIRS,
): Promise<{ bin: string; present: boolean }> {
  const found = await resolveBinary("tailscale", env.CLAUDE_REMOTE_TAILSCALE_BIN, env.PATH, extraDirs);
  if (found.present || env.CLAUDE_REMOTE_TAILSCALE_BIN) return found;
  for (const dir of extraDirs) {
    const candidate = path.join(dir, "Tailscale");
    if (await cloudflaredPresent(candidate)) return { bin: candidate, present: true };
  }
  return found;
}

async function resolveBinary(
  name: string,
  override: string | undefined,
  searchPath: string | undefined,
  extraDirs: readonly string[],
): Promise<{ bin: string; present: boolean }> {
  if (override) return { bin: override, present: await cloudflaredPresent(override) };
  const seen = new Set<string>();
  const dirs = [...(searchPath ?? "").split(path.delimiter).filter((dir) => dir.length > 0), ...extraDirs];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, name);
    if (await cloudflaredPresent(candidate)) return { bin: candidate, present: true };
  }
  return { bin: name, present: false };
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

/**
 * The live quick-tunnel URL is the last one in the log. The log is never rotated by cloudflared,
 * so this reads the tail; reading the head returned a hostname that died days ago once the file
 * passed a megabyte.
 */
async function readUrl(home: string): Promise<string | null> {
  try {
    return quickTunnelUrl(await readTail(tunnelLogPath(home), URL_TAIL_BYTES));
  } catch {
    return null;
  }
}

export async function readPort(home: string): Promise<number> {
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

async function rmTreeSafe(dir: string): Promise<void> {
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
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

export { HTTP_HOST };
