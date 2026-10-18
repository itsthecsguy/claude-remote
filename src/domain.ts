import type { PendingView } from "./pending.js";
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

export type SessionDetail = {
  card: SessionCard;
  turns: Turn[];
  summary: SessionSummary;
  lastReply: string;
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
