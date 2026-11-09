import type { RunState, SessionPhase, SessionStatus, SessionSummary, TailEnd, TurnFacts } from "./domain.js";
import type { RunRecord } from "./runs.js";
import { assertNever } from "./domain.js";
import type { TranscriptFacts } from "./read.js";

export function summarize(facts: TranscriptFacts, run: RunState, status?: SessionStatus): SessionSummary {
  return {
    did: facts.did,
    stuck: stuckFromStatus(status) ?? stuckFor(run, facts.end),
    coverage: facts.coverage,
  };
}

/**
 * The stuck line from claude agents --json, when it reported this session. A session that the
 * command does not list, or a server without that command, keeps the transcript-tail heuristic.
 */
export function stuckFromStatus(status: SessionStatus | undefined): string | null {
  if (!status || status.source !== "agents-json") return null;
  switch (status.value) {
    case "working":
      return "session is working";
    case "needs-you":
      return status.waitingFor ? `needs you: ${status.waitingFor}` : "needs you";
    case "idle":
      return "session is idle and waiting for the next prompt";
    case "failed":
      return "background session failed";
    case "stopped":
      return "background session was stopped";
    case "not-running":
    case "unknown":
      return null;
    default: {
      const _never: never = status.value;
      return assertNever(_never);
    }
  }
}

function stuckFor(run: RunState, end: TailEnd): string | null {
  if (run.kind === "running") return "session is running";
  switch (end.kind) {
    case "tool-error":
      return `last tool result is an error: ${end.text}`;
    case "tool-open":
      return "last tool call has no result in the tail";
    case "user-prompt":
      return "waiting on a reply";
    case "closed":
      return null;
    default: {
      const _never: never = end;
      return assertNever(_never);
    }
  }
}

/**
 * One verdict for a remote reader. A waiting prompt wins, then a working process, then a failed or
 * stopped one. After that the transcript decides: a turn that has replied is done, and a turn that
 * has not, under a process that is idle or gone, was interrupted.
 */
export function phaseOf(input: {
  status: SessionStatus;
  run: RunState;
  turn: TurnFacts | null;
  pending: readonly { kind: string; answered?: boolean }[];
  /** The newest child this server started for the session, if any. */
  owned?: RunRecord | null;
  /** When a message was last handed to the live session, in epoch ms, if that was moments ago. */
  handoffAt?: number | null;
}): SessionPhase {
  const { status, run, turn } = input;
  const owned = currentRun(input.owned ?? null, turn);
  if (owned?.state === "exited") {
    const failed = owned.result ? owned.result.isError : owned.exitCode !== 0;
    // No result record and a signal exit (null, or 128 + the signal number, as after stop_session).
    if (!owned.result && (owned.exitCode == null || owned.exitCode >= 128)) {
      return { value: "stopped", reason: "the run this server started was ended by a signal before it printed a result" };
    }
    const denied = owned.result?.permissionDenials.length ?? 0;
    const tail = denied > 0 ? `; ${denied} tool call${denied === 1 ? " was" : "s were"} denied, see run.result.permissionDenials` : "";
    return failed
      ? { value: "failed", reason: `the run this server started ended in an error (exit ${owned.exitCode ?? "unknown"}); ${owned.result ? "read run.result" : "it printed no result, so read turn.steps"}${tail}` }
      : { value: "done", reason: `the run this server started has exited; read run.result.text${tail}` };
  }
  // An entry that already has its remote answer is no longer a reason to stop: after a deny no
  // tool result follows, so it stays listed until the turn ends.
  const prompt = input.pending.find((entry) => (entry.kind === "permission" || entry.kind === "question") && entry.answered !== true);
  if (prompt) return { value: "needs-input", reason: `a ${prompt.kind} is pending; see card.pending` };
  if (status.value === "needs-you") {
    return { value: "needs-input", reason: status.waitingFor ? `waiting for: ${status.waitingFor}` : "the session is waiting for its user" };
  }
  if (owned?.state === "running") return { value: "working", reason: "the run this server started has not exited" };
  if (status.value === "working") return { value: "working", reason: `status is working (${status.source})` };
  if (input.handoffAt != null && (!turn?.lastActivity || Date.parse(turn.lastActivity) < input.handoffAt)) {
    return { value: "working", reason: "a message was handed to the session moments ago and is not in the transcript yet" };
  }
  if (status.value === "failed" || status.value === "stopped") return { value: status.value, reason: `background session ${status.value}` };
  // tail-open means neither the sessions registry nor ps shows a process for this session.
  const gone = run.kind === "finished" || (run.kind === "unknown" && run.reason === "tail-open");
  const settled = status.value === "idle" || status.value === "not-running" || gone;
  if (!turn) return settled ? { value: "idle", reason: "no prompt in the transcript yet" } : { value: "unknown", reason: "no prompt in the transcript and no status" };
  if (turn.state === "replied" && (settled || turn.explicitEnd)) {
    return { value: "done", reason: "the newest turn ended with a reply; read turn.reply" };
  }
  if (turn.state === "in-progress" && settled) {
    return { value: "interrupted", reason: `the newest turn has no final reply and the process is ${status.value === "idle" ? "idle" : "not running"}` };
  }
  if (run.kind === "running") return { value: "working", reason: "the process is live and the newest turn has no final reply" };
  return { value: "unknown", reason: "the transcript tail is open and no process status is available" };
}

/**
 * A run record speaks for the session only while it is the newest thing in it. Once a later prompt
 * has started a turn (someone continued the session in a terminal), the transcript decides again.
 */
function currentRun(owned: RunRecord | null, turn: TurnFacts | null): RunRecord | null {
  if (!owned || owned.state === "lost") return null;
  if (owned.state === "running" || !owned.endedAt || !turn?.startedAt) return owned;
  return Date.parse(turn.startedAt) > Date.parse(owned.endedAt) ? null : owned;
}
