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
