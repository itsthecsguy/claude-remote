import type { RunState, SessionSummary, TailEnd } from "./domain.js";
import { assertNever } from "./domain.js";
import type { TranscriptFacts } from "./read.js";

export function summarize(facts: TranscriptFacts, run: RunState): SessionSummary {
  return {
    did: facts.did,
    stuck: stuckFor(run, facts.end),
    coverage: facts.coverage,
  };
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
