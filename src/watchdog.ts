import path from "node:path";
import { readPlainFile, readTail, trimLog, writePrivate, type TrimResult } from "./files.js";
import { localProbeUrl, looksOffline, probeUrl, quickTunnelUrl, summarizeTunnelLog, type Probe, type ProbeFn } from "./health.js";
import { HTTP_LABEL, TUNNEL_LABEL, httpPlistPath, restartJob, tunnelPlistPath, type CommandRunner } from "./launchd.js";
import { logEvent } from "./log.js";
import { fetchSend, loadNotifySettings, notifyHeaders, type NotifySend } from "./notify.js";
import { tokenDirectory } from "./token.js";
import { fixedPublicUrl, managesTunnelProcess, tunnelDirectory, type TunnelSettings } from "./tunnel.js";

/**
 * The watchdog runs every couple of minutes from its own LaunchAgent and answers one question: can
 * a client reach the helper through the public URL right now? launchd's KeepAlive only restarts a
 * process that exits, and the failure seen in practice is a cloudflared that stays alive while the
 * edge has forgotten its quick tunnel, retrying a dead registration every 64 seconds for days. The
 * watchdog restarts the helper when 127.0.0.1 stops answering, and restarts the tunnel when the
 * public URL fails twice in a row while the helper is fine. A launchd interval job also fires once
 * after the Mac wakes, which covers sleep and network changes without any sleep-notification code.
 */

export const DEFAULT_WATCHDOG_INTERVAL_S = 120;
export const MIN_WATCHDOG_INTERVAL_S = 30;
export const MAX_WATCHDOG_INTERVAL_S = 3600;
const DEFAULT_FAILURES_BEFORE_RESTART = 2;
const DEFAULT_RESTART_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_URL_WAIT_MS = 15_000;
const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_LOG_BYTES = 512 * 1024;
const TAIL_BYTES = 1024 * 1024;

export function watchdogDirectory(home: string): string {
  return path.join(home, ".claude-remote", "watchdog");
}

export function watchdogStatePath(home: string): string {
  return path.join(watchdogDirectory(home), "state.json");
}

export function watchdogLogPath(home: string): string {
  return path.join(watchdogDirectory(home), "watchdog.log");
}

export function tunnelLogPath(home: string): string {
  return path.join(tunnelDirectory(home), "cloudflared.log");
}

export function helperLogPath(home: string): string {
  return path.join(tokenDirectory(home), "helper.log");
}

export type WatchdogState = {
  lastRunAt: string | null;
  lastVerdict: WatchdogVerdict | null;
  publicFailures: number;
  lastUrl: string | null;
  lastHelperRestartAt: string | null;
  lastTunnelRestartAt: string | null;
  helperRestarts: number;
  tunnelRestarts: number;
};

export type WatchdogVerdict =
  | "ok"
  | "helper-restarted"
  | "helper-down"
  | "tunnel-restarted"
  | "tunnel-failing"
  | "offline"
  | "no-url"
  | "no-tunnel"
  | "funnel-failing";

export type WatchdogReport = {
  at: string;
  helper: Probe;
  helperRestarted: boolean;
  url: string | null;
  public: Probe | null;
  publicFailures: number;
  tunnelRestarted: boolean;
  skipped: "offline" | "cooldown" | "no-process" | null;
  newUrl: string | null;
  urlChanged: boolean;
  trimmed: string[];
  verdict: WatchdogVerdict;
};

export type TunnelEvent = { type: "claude-remote.tunnel"; event: "url-changed" | "tunnel-restarted"; url: string | null; previousUrl: string | null; at: string };

export type WatchdogInput = {
  home: string;
  uid: number;
  port: number;
  launchctlBin: string;
  settings: TunnelSettings;
  run: CommandRunner;
  probe?: ProbeFn;
  notify?: (event: TunnelEvent) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  failuresBeforeRestart?: number;
  restartCooldownMs?: number;
  urlWaitMs?: number;
  maxLogBytes?: number;
  keepLogBytes?: number;
};

const EMPTY_STATE: WatchdogState = {
  lastRunAt: null,
  lastVerdict: null,
  publicFailures: 0,
  lastUrl: null,
  lastHelperRestartAt: null,
  lastTunnelRestartAt: null,
  helperRestarts: 0,
  tunnelRestarts: 0,
};

export async function readWatchdogState(home: string): Promise<WatchdogState> {
  const text = await readPlainFile(watchdogStatePath(home));
  if (text == null) return { ...EMPTY_STATE };
  try {
    const parsed = JSON.parse(text) as Partial<WatchdogState>;
    return {
      lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
      lastVerdict: typeof parsed.lastVerdict === "string" ? parsed.lastVerdict as WatchdogVerdict : null,
      publicFailures: typeof parsed.publicFailures === "number" ? parsed.publicFailures : 0,
      lastUrl: typeof parsed.lastUrl === "string" ? parsed.lastUrl : null,
      lastHelperRestartAt: typeof parsed.lastHelperRestartAt === "string" ? parsed.lastHelperRestartAt : null,
      lastTunnelRestartAt: typeof parsed.lastTunnelRestartAt === "string" ? parsed.lastTunnelRestartAt : null,
      helperRestarts: typeof parsed.helperRestarts === "number" ? parsed.helperRestarts : 0,
      tunnelRestarts: typeof parsed.tunnelRestarts === "number" ? parsed.tunnelRestarts : 0,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function runWatchdog(input: WatchdogInput): Promise<WatchdogReport> {
  const now = input.now ?? (() => Date.now());
  const probe = input.probe ?? ((url) => probeUrl(url));
  const sleep = input.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const failuresBeforeRestart = input.failuresBeforeRestart ?? DEFAULT_FAILURES_BEFORE_RESTART;
  const cooldownMs = input.restartCooldownMs ?? DEFAULT_RESTART_COOLDOWN_MS;
  const domain = `gui/${input.uid}`;
  const startedAt = now();
  const state = await readWatchdogState(input.home);
  const report: WatchdogReport = {
    at: new Date(startedAt).toISOString(),
    helper: { state: "unreachable", status: null, detail: null },
    helperRestarted: false,
    url: null,
    public: null,
    publicFailures: state.publicFailures,
    tunnelRestarted: false,
    skipped: null,
    newUrl: null,
    urlChanged: false,
    trimmed: [],
    verdict: "ok",
  };
  state.lastRunAt = report.at;

  report.helper = await probe(localProbeUrl(input.port));
  if (report.helper.state !== "answers") {
    const outcome = await restartJob(input.run, input.launchctlBin, domain, HTTP_LABEL, httpPlistPath(input.home));
    report.helperRestarted = outcome !== "failed";
    report.verdict = report.helperRestarted ? "helper-restarted" : "helper-down";
    if (report.helperRestarted) {
      state.helperRestarts += 1;
      state.lastHelperRestartAt = report.at;
    }
    // The public check would only repeat the local failure; the next run judges the tunnel.
    return finish(input, state, report, now);
  }

  const tail = await readTail(tunnelLogPath(input.home), TAIL_BYTES);
  report.url = fixedPublicUrl(input.settings) ?? (input.settings.mode === "quick" ? quickTunnelUrl(tail) : null);
  if (input.settings.mode === "none") {
    report.verdict = "no-tunnel";
    state.publicFailures = 0;
    return finish(input, state, report, now);
  }

  report.public = report.url ? await probe(report.url) : null;
  if (report.public?.state === "answers") {
    state.publicFailures = 0;
    state.lastUrl = report.url;
    report.publicFailures = 0;
    report.verdict = "ok";
    return finish(input, state, report, now);
  }

  state.publicFailures += 1;
  report.publicFailures = state.publicFailures;
  if (report.public && looksOffline(report.public)) {
    report.skipped = "offline";
    report.verdict = "offline";
    return finish(input, state, report, now);
  }
  if (!managesTunnelProcess(input.settings)) {
    report.skipped = "no-process";
    report.verdict = input.settings.mode === "funnel" ? "funnel-failing" : "no-tunnel";
    return finish(input, state, report, now);
  }
  if (!report.url) report.verdict = "no-url";
  else report.verdict = "tunnel-failing";
  if (state.publicFailures < failuresBeforeRestart) return finish(input, state, report, now);
  const lastRestart = state.lastTunnelRestartAt ? Date.parse(state.lastTunnelRestartAt) : NaN;
  if (Number.isFinite(lastRestart) && startedAt - lastRestart < cooldownMs) {
    report.skipped = "cooldown";
    return finish(input, state, report, now);
  }

  const outcome = await restartJob(input.run, input.launchctlBin, domain, TUNNEL_LABEL, tunnelPlistPath(input.home));
  if (outcome === "failed") return finish(input, state, report, now);
  report.tunnelRestarted = true;
  report.verdict = "tunnel-restarted";
  state.tunnelRestarts += 1;
  state.lastTunnelRestartAt = report.at;
  state.publicFailures = 0;
  report.publicFailures = 0;
  const previousUrl = report.url;
  if (input.settings.mode === "quick") {
    report.newUrl = await waitForNewUrl(input.home, previousUrl, startedAt, input.urlWaitMs ?? DEFAULT_URL_WAIT_MS, now, sleep);
    report.urlChanged = report.newUrl != null && report.newUrl !== previousUrl;
    if (report.newUrl) state.lastUrl = report.newUrl;
  } else {
    report.newUrl = previousUrl;
  }
  const notify = input.notify ?? ((event) => sendTunnelEvent(input.home, event));
  await notify({
    type: "claude-remote.tunnel",
    event: report.urlChanged ? "url-changed" : "tunnel-restarted",
    url: report.newUrl,
    previousUrl,
    at: report.at,
  }).catch(() => undefined);
  return finish(input, state, report, now);
}

async function finish(input: WatchdogInput, state: WatchdogState, report: WatchdogReport, now: () => number): Promise<WatchdogReport> {
  state.lastVerdict = report.verdict;
  await writePrivate(watchdogStatePath(input.home), `${JSON.stringify(state)}\n`);
  const maxBytes = input.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
  const keepBytes = input.keepLogBytes ?? DEFAULT_KEEP_LOG_BYTES;
  for (const file of [tunnelLogPath(input.home), helperLogPath(input.home), watchdogLogPath(input.home)]) {
    const trimmed: TrimResult = await trimLog(file, maxBytes, keepBytes).catch(() => null);
    if (trimmed) report.trimmed.push(path.basename(file));
  }
  logEvent({
    tool: "watchdog",
    code: report.verdict,
    durationMs: now() - Date.parse(report.at),
    evidence: [
      `helper=${report.helper.state}`,
      `public=${report.public ? report.public.state + (report.public.detail ? `:${report.public.detail}` : "") : "-"}`,
      `failures=${report.publicFailures}`,
      report.skipped ? `skipped=${report.skipped}` : null,
      report.urlChanged ? "url=changed" : null,
      report.trimmed.length ? `trimmed=${report.trimmed.join(",")}` : null,
    ].filter((part) => part !== null).join(" "),
  });
  return report;
}

/** After a quick-tunnel restart, wait for cloudflared to print its new hostname. */
async function waitForNewUrl(
  home: string,
  previousUrl: string | null,
  restartedAt: number,
  waitMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<string | null> {
  const deadline = restartedAt + waitMs;
  let seen: string | null = null;
  do {
    const tail = await readTail(tunnelLogPath(home), TAIL_BYTES);
    const summary = summarizeTunnelLog(tail, now());
    seen = summary.url;
    const startedAfter = summary.lastStart ? Date.parse(summary.lastStart) >= restartedAt - 1000 : false;
    if (seen && seen !== previousUrl && startedAfter) return seen;
    if (now() >= deadline) break;
    await sleep(Math.min(500, Math.max(1, deadline - now())));
  } while (now() < deadline);
  return seen;
}

/** POST a tunnel event to the alert URL from install --notify-url, signed the same way as pending alerts. */
export async function sendTunnelEvent(home: string, event: TunnelEvent, send: NotifySend = fetchSend, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const settings = await loadNotifySettings(env, home);
  if (!settings) return false;
  const body = JSON.stringify(event);
  const eventId = `tunnel.${event.at}`;
  try {
    const status = await send(settings.url, { headers: notifyHeaders(body, settings, eventId, Date.now()), body, timeoutMs: 3000 });
    logEvent({ tool: "watchdog", code: status >= 200 && status < 300 ? "notify-sent" : `notify-failed-${status}` });
    return status >= 200 && status < 300;
  } catch {
    logEvent({ tool: "watchdog", code: "notify-failed" });
    return false;
  }
}
