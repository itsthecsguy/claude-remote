import type { RunState, SessionPhase, SessionStatus, SessionSummary, TailEnd, TurnFacts } from "./domain.js";
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
  pending: readonly { kind: string }[];
}): SessionPhase {
  const { status, run, turn } = input;
  const prompt = input.pending.find((entry) => entry.kind === "permission" || entry.kind === "question");
  if (prompt) return { value: "needs-input", reason: `a ${prompt.kind} is pending; see card.pending` };
  if (status.value === "needs-you") {
    return { value: "needs-input", reason: status.waitingFor ? `waiting for: ${status.waitingFor}` : "the session is waiting for its user" };
  }
  if (status.value === "working") return { value: "working", reason: `status is working (${status.source})` };
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
