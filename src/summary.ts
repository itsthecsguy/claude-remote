import type { RunState, SessionStatus, SessionSummary, TailEnd } from "./domain.js";
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
