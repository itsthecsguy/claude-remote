import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionId } from "./paths.js";

/**
 * What this server knows about the claude children it started itself: a headless new_session and a
 * send_followup that resumes a closed session. Both print stream-json, and the last record of that
 * stream is the one place Claude Code states how the run ended: the final text, whether it was an
 * error, how many turns it took, and which tool calls were denied. The record is kept in memory and
 * in ~/.claude-remote/runs/<sessionId>.json (mode 0600), so get_session and wait_session can report
 * it after the child has exited.
 */

const RESULT_TEXT = 8000;
const DENIAL_TEXT = 200;
const MAX_DENIALS = 20;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_RUNS = 200;
/** How long a handed message may stay invisible in the transcript before the session counts as settled. */
export const HANDOFF_GRACE_MS = 15_000;

export type RunResult = {
  isError: boolean;
  /** success, error_max_turns, error_during_execution, and so on. */
  subtype: string | null;
  text: string;
  textTruncated: boolean;
  numTurns: number | null;
  durationMs: number | null;
  /** Tool calls that were refused because nobody could approve them. */
  permissionDenials: { tool: string; input: string }[];
};

export type RunRecord = {
  sessionId: string;
  kind: "launch" | "followup";
  /**
   * running while this server holds the child, exited once it has ended, and lost when the record
   * says running but this server process did not start it (the helper restarted mid-run).
   */
  state: "running" | "exited" | "lost";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  result: RunResult | null;
};

export type SessionSignal = {
  sessionId: string;
  event: "turn-finished" | "turn-failed" | "session-ended" | "run-started" | "run-finished" | "pending";
  projectName?: string | null;
  exitCode?: number | null;
  isError?: boolean | null;
};

/** In-process fan-out of things that can end a wait: a Stop hook, a run exit, a new prompt. */
export class SessionSignals {
  private readonly listeners = new Set<(signal: SessionSignal) => void>();

  emit(signal: SessionSignal): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(signal);
      } catch {
        // A throwing listener must not stop the others.
      }
    }
  }

  subscribe(listener: (signal: SessionSignal) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const sessionSignals = new SessionSignals();

export function runsRoot(home: string): string {
  return path.join(path.resolve(home), ".claude-remote", "runs");
}

/** The fields of a stream-json `result` record this server keeps. Anything else is null. */
export function resultFromRecord(msg: unknown): RunResult | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const record = msg as Record<string, unknown>;
  if (record.type !== "result") return null;
  const text = typeof record.result === "string" ? record.result : "";
  const denials: RunResult["permissionDenials"] = [];
  if (Array.isArray(record.permission_denials)) {
    for (const item of record.permission_denials.slice(0, MAX_DENIALS)) {
      if (!item || typeof item !== "object") continue;
      const denial = item as { tool_name?: unknown; tool_input?: unknown };
      if (typeof denial.tool_name !== "string") continue;
      denials.push({ tool: denial.tool_name.slice(0, 128), input: denialInput(denial.tool_input) });
    }
  }
  return {
    isError: record.is_error === true,
    subtype: typeof record.subtype === "string" ? record.subtype.slice(0, 64) : null,
    text: text.slice(0, RESULT_TEXT),
    textTruncated: text.length > RESULT_TEXT,
    numTurns: typeof record.num_turns === "number" ? record.num_turns : null,
    durationMs: typeof record.duration_ms === "number" ? record.duration_ms : null,
    permissionDenials: denials,
  };
}

function denialInput(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const fields = input as Record<string, unknown>;
  for (const key of ["command", "file_path", "path", "pattern", "url"]) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) {
      const flat = value.replace(/\s+/g, " ").trim();
      return flat.length > DENIAL_TEXT ? `${flat.slice(0, DENIAL_TEXT)}...` : flat;
    }
  }
  return "";
}

/**
 * Splits a stream-json stdout into records. A line longer than the cap is skipped to its newline,
 * so one huge record cannot stop the reader from seeing the result record after it.
 */
export class StreamReader {
  private buffer = "";
  private skipping = false;

  constructor(private readonly onRecord: (record: unknown) => void) {}

  feed(chunk: Buffer | string): void {
    let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      if (this.skipping) {
        if (newline === -1) return;
        this.skipping = false;
        text = text.slice(newline + 1);
        continue;
      }
      if (newline === -1) {
        this.buffer += text;
        if (this.buffer.length > MAX_LINE) {
          this.buffer = "";
          this.skipping = true;
        }
        return;
      }
      const line = this.buffer + text.slice(0, newline);
      this.buffer = "";
      text = text.slice(newline + 1);
      if (line.length > MAX_LINE || line.trim().length === 0) continue;
      try {
        this.onRecord(JSON.parse(line));
      } catch {
        // Not JSON. stream-json prints one object per line, so anything else is noise.
      }
    }
  }
}

export class RunStore {
  private readonly runs = new Map<string, RunRecord>();
  private readonly handoffs = new Map<string, number>();

  constructor(
    private readonly signals: SessionSignals = sessionSignals,
    private readonly clock: () => number = Date.now,
  ) {}

  /** A child for this session has started. Replaces any earlier record for the session. */
  async begin(home: string, sessionId: string, kind: RunRecord["kind"]): Promise<void> {
    const id = parseSessionId(sessionId);
    if (!id) return;
    const record: RunRecord = {
      sessionId: id,
      kind,
      state: "running",
      startedAt: new Date(this.clock()).toISOString(),
      endedAt: null,
      exitCode: null,
      result: null,
    };
    this.remember(record);
    await this.save(home, record);
    this.signals.emit({ sessionId: id, event: "run-started" });
  }

  /** The child printed its result record. The exit code arrives separately, through end. */
  setResult(sessionId: string, result: RunResult): void {
    const record = this.runs.get(sessionId.toLowerCase());
    if (record && record.state === "running") record.result = result;
  }

  async end(home: string, sessionId: string, exitCode: number | null, result?: RunResult | null): Promise<void> {
    const record = this.runs.get(sessionId.toLowerCase());
    if (!record || record.state !== "running") return;
    record.state = "exited";
    record.endedAt = new Date(this.clock()).toISOString();
    record.exitCode = exitCode;
    if (result) record.result = result;
    await this.save(home, record);
    this.signals.emit({
      sessionId: record.sessionId,
      event: "run-finished",
      exitCode,
      isError: record.result ? record.result.isError : exitCode !== 0,
    });
  }

  /** The newest run for a session: from memory, or from the file a previous helper process left. */
  async get(home: string, sessionId: string): Promise<RunRecord | null> {
    const id = parseSessionId(sessionId);
    if (!id) return null;
    const live = this.runs.get(id);
    if (live) return { ...live };
    const saved = await readRun(home, id);
    if (!saved) return null;
    // This process did not start it, so nothing here is reading that child's output.
    return saved.state === "running" ? { ...saved, state: "lost" } : saved;
  }

  /** A message was handed to a live session at this moment. See handoffAt. */
  noteHandoff(sessionId: string): void {
    this.handoffs.set(sessionId.toLowerCase(), this.clock());
    while (this.handoffs.size > MAX_RUNS) {
      const oldest = this.handoffs.keys().next().value;
      if (oldest === undefined) break;
      this.handoffs.delete(oldest);
    }
  }

  /** When a message was last handed to this session, if that is recent enough to matter. */
  handoffAt(sessionId: string): number | null {
    const at = this.handoffs.get(sessionId.toLowerCase());
    if (at == null) return null;
    if (this.clock() - at > HANDOFF_GRACE_MS) {
      this.handoffs.delete(sessionId.toLowerCase());
      return null;
    }
    return at;
  }

  private remember(record: RunRecord): void {
    this.runs.delete(record.sessionId);
    this.runs.set(record.sessionId, record);
    for (const [key, value] of this.runs) {
      if (this.runs.size <= MAX_RUNS) break;
      if (value.state !== "running") this.runs.delete(key);
    }
  }

  private async save(home: string, record: RunRecord): Promise<void> {
    try {
      const dir = runsRoot(home);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const dest = path.join(dir, `${record.sessionId}.json`);
      const tmp = path.join(dir, `.part-${process.pid}-${record.sessionId}.tmp`);
      await writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, dest);
    } catch {
      // The record still lives in memory. A read-only home must not fail the run.
    }
  }
}

async function readRun(home: string, sessionId: string): Promise<RunRecord | null> {
  let text: string;
  try {
    text = await readFile(path.join(runsRoot(home), `${sessionId}.json`), "utf8");
  } catch {
    return null;
  }
  if (text.length > 200_000) return null;
  try {
    const parsed = JSON.parse(text) as Partial<RunRecord> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.sessionId !== sessionId) return null;
    if (parsed.kind !== "launch" && parsed.kind !== "followup") return null;
    if (parsed.state !== "running" && parsed.state !== "exited") return null;
    if (typeof parsed.startedAt !== "string") return null;
    return {
      sessionId,
      kind: parsed.kind,
      state: parsed.state,
      startedAt: parsed.startedAt,
      endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : null,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : null,
      result: parsed.result && typeof parsed.result === "object" ? parsed.result as RunResult : null,
    };
  } catch {
    return null;
  }
}

export const runStore = new RunStore();
