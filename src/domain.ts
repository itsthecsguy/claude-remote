import type { PendingView } from "./pending.js";
import type { RunRecord } from "./runs.js";
export type SessionId = string & { readonly __brand: "SessionId" };

export type DesktopSessionId = string & { readonly __brand: "DesktopSessionId" };

export type RunState =
  | { kind: "running"; evidence: "sessions-file" | "process-argv" }
  | { kind: "finished" }
  | { kind: "unknown"; reason: "tail-open" | "sessions-dir-unreadable" | "sessions-file-unverified" };

export type SessionCard = {
  sessionId: SessionId;
  desktopSessionId: DesktopSessionId | null;
  inDesktopSidebar: boolean;
  projectName: string;
  projectPath: string | null;
  cwd: string | null;
  title: string | null;
  liveOwner: LiveOwner;
  branch: string | null;
  worktreePath: string | null;
  lastActivity: string | null;
  runState: RunState;
  messageCount: number;
  command: string | null;
  warning: string | null;
  status: SessionStatus;
  process: ProcessDetailsView | null;
  subSessions: SubSessionRow[];
  subSessionCount: number;
  pending?: PendingView[];
};

export type WaitingFor =
  | "permission prompt"
  | "input needed"
  | "sandbox request"
  | "worker request"
  | "dialog open"
  | "other";

export type StatusValue = "working" | "needs-you" | "idle" | "failed" | "stopped" | "not-running" | "unknown";

export type StatusSource = "agents-json" | "sessions-file" | "fallback";

export type SessionStatus = {
  value: StatusValue;
  waitingFor: WaitingFor | null;
  source: StatusSource;
  kind: "interactive" | "background" | "other" | null;
};

/**
 * One subagent transcript under <project>/<sessionId>/subagents/, built from the file's stat and
 * its .meta.json sidecar. The transcript itself is never opened.
 */
export type SubSessionRow = {
  agentId: string;
  parentSessionId: SessionId;
  agentType: string | null;
  isFork: boolean;
  spawnDepth: number | null;
  finished: boolean | null;
  parentAgentId: string | null;
  worktree: boolean;
  sizeBytes: number;
  lastActivity: string | null;
  hasMeta: boolean;
};

export type Turn = {
  role: "user" | "assistant";
  text: string;
  toolNames: string[];
};

export type SummaryCoverage = "full" | "tail";

export type SessionSummary = {
  did: string;
  stuck: string | null;
  coverage: SummaryCoverage;
};

/** One tool call in the current turn, paired with its result by tool_use_id. */
export type TurnStep = {
  tool: string;
  /** The command, file path, pattern, or other main argument, clipped. */
  input: string;
  outcome: "ok" | "error" | "running";
  /** The start of the tool result, clipped. Empty while the call is running. */
  result: string;
};

/**
 * The newest prompt in the transcript and what has happened since, read from the whole file.
 * state is what the transcript shows on its own: replied when the last record of the turn is an
 * assistant message with no tool call. explicitEnd says that message carried an end stop_reason.
 */
export type TurnFacts = {
  state: "replied" | "in-progress";
  explicitEnd: boolean;
  prompt: string;
  startedAt: string | null;
  lastActivity: string | null;
  /** The final assistant text of this turn. null until the turn has replied. */
  reply: string | null;
  replyTruncated: boolean;
  /** The newest assistant text written between tool calls, clipped. */
  narration: string | null;
  toolCalls: number;
  toolErrors: number;
  /** Names of tool calls that have no result yet. */
  openTools: string[];
  /** The newest tool calls of this turn, oldest first. */
  steps: TurnStep[];
};

export type PhaseValue = "working" | "needs-input" | "done" | "interrupted" | "failed" | "stopped" | "idle" | "unknown";

/** One verdict that combines process status, pending prompts, and the transcript turn. */
export type SessionPhase = {
  value: PhaseValue;
  reason: string;
};

export type SessionDetail = {
  card: SessionCard;
  turns: Turn[];
  summary: SessionSummary;
  lastReply: string;
  phase: SessionPhase;
  turn: TurnFacts | null;
  /** The newest claude child this server started for the session, with its final result. */
  run: RunRecord | null;
  /** The state of the checkout the session works in, read with git at call time. */
  git: GitFacts | null;
};

export type GitFacts = {
  head: string | null;
  branch: string | null;
  upstream: string | null;
  /** Commits on the branch that its upstream does not have, as of the last fetch or push. */
  ahead: number | null;
  behind: number | null;
  /** Files with uncommitted changes, untracked files included. */
  dirtyFiles: number;
  /** true when the branch has an upstream and nothing to push. null without an upstream. */
  pushed: boolean | null;
};

/** What wait_session returns: the same facts as get_session without the turn list. */
export type WaitResult = {
  sessionId: SessionId;
  timedOut: boolean;
  waitedMs: number;
  phase: SessionPhase;
  status: SessionStatus;
  turn: TurnFacts | null;
  run: RunRecord | null;
  pending: PendingView[];
  git: GitFacts | null;
  next: string;
};

export type TailEnd =
  | { kind: "closed" }
  | { kind: "user-prompt" }
  | { kind: "tool-open" }
  | { kind: "tool-error"; text: string };

export type LiveOwner = "desktop" | "terminal" | "none" | "unknown";

export type EntrypointOwner = "desktop" | "terminal" | "other" | "absent";

export type SessionRegistry =
  | { status: "missing" }
  | { status: "unreadable" }
  | {
      status: "checked";
      live: readonly SessionId[];
      unverified: readonly SessionId[];
      owners: Readonly<Record<string, EntrypointOwner>>;
      tokens?: Readonly<Record<string, string>>;
      details?: Readonly<Record<string, ProcessDetailsView>>;
    };

export type ProcessDetailsView = {
  pid: number;
  entrypoint: EntrypointOwner;
  tmux: string | null;
  bridgeSessionId: string | null;
  messagingSocketPath: string | null;
};

export type WorktreeLaunch = "project" | "main-checkout" | "unchecked";

export class DeskError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeskError";
    this.code = code;
  }
}

export function assertNever(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`);
}
