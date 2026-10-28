/**
 * Health checks shared by `status` and the watchdog.
 *
 * A probe is a GET of /mcp with no credentials. The helper answers 401 with
 * `WWW-Authenticate: Bearer realm="claude-remote"`, so that exact reply proves the request reached
 * the helper, through the tunnel or on 127.0.0.1, without the probe ever reading the bearer token.
 * Anything else says which part is broken: 403 is the helper refusing a public Host header, a 5xx
 * is the tunnel edge answering for a connector that is gone, and a transport error is the network.
 */

export const PROBE_REALM = "claude-remote";

export type ProbeState = "answers" | "host-rejected" | "tunnel-error" | "unexpected" | "unreachable";

export type Probe = {
  state: ProbeState;
  status: number | null;
  /** A short token such as http-530, ENOTFOUND, or timeout. Never a URL or a header value. */
  detail: string | null;
};

export type ProbeResponse = { status: number; headers: { get(name: string): string | null } };

export type Fetcher = (url: string, init: { method: "GET"; redirect: "manual"; signal: AbortSignal; headers: Record<string, string> }) => Promise<ProbeResponse>;

export type ProbeFn = (url: string) => Promise<Probe>;

const DEFAULT_PROBE_TIMEOUT_MS = 8000;

export function localProbeUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

export async function probeUrl(url: string, options: { timeoutMs?: number; fetcher?: Fetcher } = {}): Promise<Probe> {
  const fetcher = options.fetcher ?? defaultFetcher;
  let response: ProbeResponse;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "claude-remote-probe" },
    });
  } catch (error) {
    return { state: "unreachable", status: null, detail: errorToken(error) };
  }
  return classify(response);
}

export function classify(response: ProbeResponse): Probe {
  const status = response.status;
  if (status === 401) {
    const challenge = response.headers.get("www-authenticate") ?? "";
    if (challenge.includes(`realm="${PROBE_REALM}"`)) return { state: "answers", status, detail: null };
    return { state: "unexpected", status, detail: "foreign-401" };
  }
  if (status === 403) return { state: "host-rejected", status, detail: "http-403" };
  if (status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 530)) {
    return { state: "tunnel-error", status, detail: `http-${status}` };
  }
  return { state: "unexpected", status, detail: `http-${status}` };
}

/** Transport errors that mean this Mac has no usable network, as opposed to a dead tunnel. */
export function looksOffline(probe: Probe): boolean {
  if (probe.state !== "unreachable") return false;
  return probe.detail === "ENOTFOUND" || probe.detail === "EAI_AGAIN" || probe.detail === "ENETUNREACH" || probe.detail === "ENETDOWN";
}

function errorToken(error: unknown): string {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (typeof record.code === "string" && /^[A-Z_]{3,32}$/.test(record.code)) return record.code;
    if (record.name === "TimeoutError" || record.name === "AbortError") return "timeout";
    current = record.cause;
  }
  return "error";
}

const defaultFetcher: Fetcher = async (url, init) => {
  const response = await fetch(url, init);
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, headers: response.headers };
};

/** The newest quick-tunnel URL in a piece of the cloudflared log, with the /mcp path. */
export function quickTunnelUrl(text: string): string | null {
  const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  const last = found?.[found.length - 1];
  return last ? `${last}/mcp` : null;
}

export type TunnelLogSummary = {
  /** When cloudflared last registered a connection with the edge. */
  lastRegistered: string | null;
  /** When it last scheduled a reconnect attempt. */
  lastRetry: string | null;
  /** When the process last started (a quick tunnel gets a new hostname here). */
  lastStart: string | null;
  /** Reconnect attempts in the ten minutes before `now`. */
  retriesLast10m: number;
  /** True when the newest event is a successful registration. */
  connected: boolean | null;
  url: string | null;
};

const RAW_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z) (?:INF|WRN|ERR|DBG) (.*)$/;

/**
 * Summarize the tail of a cloudflared log. cloudflared writes JSON lines to --logfile, and launchd
 * appends the same events in text form from stderr, so both shapes are read.
 */
export function summarizeTunnelLog(text: string, nowMs = Date.now()): TunnelLogSummary {
  const summary: TunnelLogSummary = { lastRegistered: null, lastRetry: null, lastStart: null, retriesLast10m: 0, connected: null, url: null };
  let newest: "registered" | "retry" | null = null;
  let newestAt = 0;
  for (const line of text.split("\n")) {
    const event = parseLine(line);
    if (!event) continue;
    const at = Date.parse(event.time);
    if (!Number.isFinite(at)) continue;
    if (/^Registered tunnel connection/.test(event.message)) {
      summary.lastRegistered = event.time;
      if (at >= newestAt) {
        newest = "registered";
        newestAt = at;
      }
    } else if (/^Retrying connection/.test(event.message)) {
      summary.lastRetry = event.time;
      if (nowMs - at <= 10 * 60 * 1000) summary.retriesLast10m += 1;
      if (at >= newestAt) {
        newest = "retry";
        newestAt = at;
      }
    } else if (/^Requesting new quick Tunnel|^Generated Connector ID/.test(event.message)) {
      summary.lastStart = event.time;
    }
  }
  summary.connected = newest === null ? null : newest === "registered";
  summary.url = quickTunnelUrl(text);
  return summary;
}

function parseLine(line: string): { time: string; message: string } | null {
  if (line.startsWith("{")) {
    try {
      const parsed = JSON.parse(line) as { time?: unknown; message?: unknown };
      if (typeof parsed.time === "string" && typeof parsed.message === "string") return { time: parsed.time, message: parsed.message };
    } catch {
      return null;
    }
    return null;
  }
  const raw = RAW_LINE.exec(line);
  if (raw?.[1] && raw[2] !== undefined) return { time: raw[1], message: raw[2] };
  return null;
}

export type LaunchdJob = {
  loaded: boolean;
  state: string | null;
  pid: number | null;
  /** The last exit code, or null while the job has never exited. */
  lastExitCode: number | null;
  runs: number | null;
};

/** The few facts `status` needs from `launchctl print gui/<uid>/<label>`. */
export function parseLaunchctlPrint(code: number, text: string): LaunchdJob {
  if (code !== 0) return { loaded: false, state: null, pid: null, lastExitCode: null, runs: null };
  const field = (name: string): string | null => {
    const match = new RegExp(`^\\s*${name} = (.+?)\\s*$`, "m").exec(text);
    return match?.[1] ?? null;
  };
  const number = (value: string | null): number | null => {
    if (value == null) return null;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
  };
  const exit = field("last exit code");
  return {
    loaded: true,
    state: field("state"),
    pid: number(field("pid")),
    lastExitCode: exit == null || exit.includes("never") ? null : number(exit.split(" ")[0] ?? null),
    runs: number(field("runs")),
  };
}
