import { spawn } from "node:child_process";
import type { RunState, SessionId, SessionStatus, StatusSource, StatusValue, WaitingFor } from "./domain.js";
import { assertNever } from "./domain.js";
import { parseSessionId } from "./paths.js";

/**
 * Session state from `claude agents --json --all`, the documented way to read session state from
 * outside Claude Code. Only the fields below are kept. cwd and name are dropped because the
 * transcript and the sessions file already give this server what it shows, and a name can be
 * free text.
 */
export type AgentEntry = {
  sessionId: SessionId | null;
  pid: number | null;
  kind: "interactive" | "background" | "other";
  status: "busy" | "waiting" | "idle" | null;
  state: "working" | "blocked" | "done" | "failed" | "stopped" | null;
  waitingFor: WaitingFor | null;
  shortId: string | null;
};

export type { SessionStatus, StatusSource, StatusValue, WaitingFor };

export type AgentsSnapshot =
  | { available: true; entries: AgentEntry[]; bySession: ReadonlyMap<string, AgentEntry> }
  | { available: false; reason: AgentsUnavailable };

export type AgentsUnavailable = "missing" | "failed" | "timeout" | "unparseable" | "disabled";

export type AgentsLoader = () => Promise<AgentsSnapshot>;

const WAITING_FOR: ReadonlySet<string> = new Set([
  "permission prompt",
  "input needed",
  "sandbox request",
  "worker request",
  "dialog open",
]);

const SHORT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_OUTPUT = 4 * 1024 * 1024;
const AGENTS_TIMEOUT_MS = 4000;

export function parseAgentsJson(text: string): AgentEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: AgentEntry[] = [];
  for (const item of parsed) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseEntry(item: unknown): AgentEntry | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const raw = item as Record<string, unknown>;
  const sessionId = typeof raw.sessionId === "string" ? parseSessionId(raw.sessionId) : null;
  const pid = typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : null;
  const shortId = typeof raw.id === "string" && SHORT_ID.test(raw.id) ? raw.id : null;
  if (!sessionId && pid == null && !shortId) return null;
  return {
    sessionId,
    pid,
    kind: raw.kind === "interactive" || raw.kind === "background" ? raw.kind : "other",
    status: raw.status === "busy" || raw.status === "waiting" || raw.status === "idle" ? raw.status : null,
    state: stateOf(raw.state),
    waitingFor: waitingForOf(raw.waitingFor),
    shortId,
  };
}

function stateOf(value: unknown): AgentEntry["state"] {
  switch (value) {
    case "working":
    case "blocked":
    case "done":
    case "failed":
    case "stopped":
      return value;
    default:
      return null;
  }
}

function waitingForOf(value: unknown): WaitingFor | null {
  if (typeof value !== "string" || value.length === 0) return null;
  return WAITING_FOR.has(value) ? (value as WaitingFor) : "other";
}

/**
 * busy is working, waiting is needs-you (with waitingFor), idle is idle. A background session
 * reports `state`, which wins: working, blocked (needs-you), done (idle), failed, or stopped.
 */
export function statusFromEntry(entry: AgentEntry): SessionStatus {
  const base = { source: "agents-json" as const, kind: entry.kind };
  if (entry.kind === "background" && entry.state) {
    switch (entry.state) {
      case "working":
        return { ...base, value: "working", waitingFor: null };
      case "blocked":
        return { ...base, value: "needs-you", waitingFor: entry.waitingFor };
      case "done":
        return { ...base, value: "idle", waitingFor: null };
      case "failed":
        return { ...base, value: "failed", waitingFor: null };
      case "stopped":
        return { ...base, value: "stopped", waitingFor: null };
      default: {
        const _never: never = entry.state;
        return assertNever(_never);
      }
    }
  }
  const fromToken = statusFromToken(entry.status);
  return { ...base, value: fromToken ?? "unknown", waitingFor: fromToken === "needs-you" ? entry.waitingFor : null };
}

/** Map a busy, waiting, or idle token. Anything else is null. */
export function statusFromToken(token: string | null | undefined): "working" | "needs-you" | "idle" | null {
  switch (token) {
    case "busy":
      return "working";
    case "waiting":
      return "needs-you";
    case "idle":
      return "idle";
    default:
      return null;
  }
}

/**
 * The status for one session. With an agents snapshot, a listed session uses its entry, and an
 * unlisted one is not-running unless the registry or ps still says it runs (then unknown). Without
 * one (older CLI or a failed command), the sessions/<pid>.json status token is mapped the same way,
 * and otherwise the run state decides.
 */
export function resolveStatus(input: {
  snapshot: AgentsSnapshot;
  sessionId: string;
  runState: RunState;
  registryToken: string | null;
}): SessionStatus {
  if (input.snapshot.available) {
    const entry = input.snapshot.bySession.get(input.sessionId.toLowerCase());
    if (entry) return statusFromEntry(entry);
    if (input.runState.kind === "finished") {
      return { value: "not-running", waitingFor: null, source: "agents-json", kind: null };
    }
    return { value: "unknown", waitingFor: null, source: "agents-json", kind: null };
  }
  if (input.runState.kind === "running") {
    const mapped = statusFromToken(input.registryToken);
    if (mapped) return { value: mapped, waitingFor: null, source: "sessions-file", kind: null };
    return { value: "unknown", waitingFor: null, source: "fallback", kind: null };
  }
  if (input.runState.kind === "finished") return { value: "not-running", waitingFor: null, source: "fallback", kind: null };
  return { value: "unknown", waitingFor: null, source: "fallback", kind: null };
}

export function snapshotFrom(entries: AgentEntry[]): AgentsSnapshot {
  const bySession = new Map<string, AgentEntry>();
  for (const entry of entries) {
    if (!entry.sessionId) continue;
    const prior = bySession.get(entry.sessionId);
    // A live process row says more than a background row whose process has exited.
    if (!prior || (prior.pid == null && entry.pid != null)) bySession.set(entry.sessionId, entry);
  }
  return { available: true, entries, bySession };
}

export type AgentsRunner = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; stdout: string; spawnError: string | null }>;

/**
 * Run `claude agents --json --all`. Any failure (missing binary, older CLI without the
 * subcommand, timeout, bad JSON) returns available=false so callers fall back. stderr is dropped,
 * and nothing from stdout is logged.
 */
export async function loadAgents(
  bin: string,
  options: { disabled?: boolean; cwd?: string; run?: AgentsRunner } = {},
): Promise<AgentsSnapshot> {
  if (options.disabled) return { available: false, reason: "disabled" };
  const run = options.run ?? ((b, a, t) => runAgents(b, a, t, options.cwd));
  let outcome;
  try {
    outcome = await run(bin, ["agents", "--json", "--all"], AGENTS_TIMEOUT_MS);
  } catch {
    return { available: false, reason: "failed" };
  }
  if (outcome.spawnError === "ENOENT") return { available: false, reason: "missing" };
  if (outcome.spawnError === "timeout") return { available: false, reason: "timeout" };
  if (outcome.spawnError || outcome.code !== 0) return { available: false, reason: "failed" };
  const entries = parseAgentsJson(outcome.stdout.trim());
  if (!entries) return { available: false, reason: "unparseable" };
  return snapshotFrom(entries);
}

function runAgents(bin: string, args: string[], timeoutMs: number, cwd?: string): Promise<{ code: number | null; stdout: string; spawnError: string | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "spawn";
      resolve({ code: null, stdout: "", spawnError: code === "ENOENT" ? "ENOENT" : "spawn" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: { code: number | null; stdout: string; spawnError: string | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout: "", spawnError: "timeout" });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish({ code: null, stdout: "", spawnError: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout: "", spawnError: error.code === "ENOENT" ? "ENOENT" : "spawn" });
    });
    child.on("close", (code) => {
      finish({ code, stdout: Buffer.concat(chunks).toString("utf8"), spawnError: null });
    });
  });
}
