import type { GitFacts, SessionCard, SessionPhase, TurnFacts, TurnStep } from "./domain.js";
import type { RunRecord } from "./runs.js";
import type { PendingView } from "./pending.js";
import type { FollowupOutcome } from "./queue.js";
import { currentRun } from "./summary.js";

/**
 * The compact view of every tool answer. A remote caller is a language model that pays for each
 * character it reads, on every later turn of its conversation, so the default answer carries only
 * what the caller acts on: the verdict, the final text, what needs an answer, and the checkout
 * state. Nulls, empty lists, and facts the caller already has (the session id it sent) are left
 * out. The full records are still there with detail set to full.
 */

export type Detail = "brief" | "full";

const STEP_INPUT = 80;
const PROMPT_TEXT = 160;
const PENDING_TEXT = 300;
const TITLE_TEXT = 60;
const LAST_STEPS = 3;

export type BriefPending = {
  requestId: string;
  kind: PendingView["kind"];
  sessionId?: string;
  tool?: string;
  text?: string;
  questions?: { question: string; options: string[]; multiSelect?: true }[];
  /** true when no hook is waiting, so only the app or terminal on the machine can answer. */
  local?: true;
};

export type BriefGit = {
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  dirty?: number;
  pushed?: boolean;
};

export type BriefSession = {
  title?: string;
  project?: string;
  prompt?: string;
  phase: string;
  /** Only for a phase the caller cannot act on without knowing why. */
  reason?: string;
  timedOut?: true;
  /** The final text of the newest turn, or of the run this server started. */
  reply?: string;
  replyTruncated?: true;
  exitCode?: number;
  toolCalls?: number;
  toolErrors?: number;
  /** While working: the tool call in flight, or the newest one. */
  now?: string;
  /** After a turn that did not end well: its newest tool calls. */
  lastSteps?: string[];
  pending?: BriefPending[];
  denied?: string[];
  git?: BriefGit;
};

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

function stepLine(step: TurnStep): string {
  const input = clip(step.input, STEP_INPUT);
  const head = input.length > 0 ? `${step.tool}: ${input}` : step.tool;
  return step.outcome === "error" ? `${head} (error)` : head;
}

export function briefPending(views: readonly PendingView[], withSession = false): BriefPending[] {
  const out: BriefPending[] = [];
  for (const view of views) {
    if (view.answered) continue;
    const entry: BriefPending = { requestId: view.requestId, kind: view.kind };
    if (withSession) entry.sessionId = view.sessionId;
    // The hook summary usually starts with the tool name already.
    if (view.toolName && view.kind === "permission" && !view.text.startsWith(`${view.toolName}:`)) entry.tool = view.toolName;
    if (view.questions && view.questions.length > 0) {
      entry.questions = view.questions.map((question) => ({
        question: question.question,
        options: question.options.map((option) => option.label),
        ...(question.multiSelect ? { multiSelect: true as const } : {}),
      }));
    } else if (view.text.length > 0) {
      entry.text = clip(view.text, PENDING_TEXT);
    }
    if (!view.answerable && view.kind !== "notification") entry.local = true;
    out.push(entry);
  }
  return out;
}

export function briefGit(git: GitFacts | null): BriefGit | undefined {
  if (!git) return undefined;
  const out: BriefGit = {};
  if (git.branch) out.branch = git.branch;
  if (git.head) out.head = git.head.slice(0, 7);
  if (git.ahead) out.ahead = git.ahead;
  if (git.behind) out.behind = git.behind;
  if (git.dirtyFiles > 0) out.dirty = git.dirtyFiles;
  if (git.pushed != null) out.pushed = git.pushed;
  return out;
}

const NEEDS_REASON = new Set(["interrupted", "failed", "stopped", "unknown"]);

export type BriefInput = {
  phase: SessionPhase;
  turn: TurnFacts | null;
  run: RunRecord | null;
  git: GitFacts | null;
  pending: readonly PendingView[];
  title?: string | null;
  project?: string | null;
};

/**
 * One session, for get_session and wait_session. identity adds the title, project, and prompt,
 * which a caller that has just sent the prompt does not need back.
 */
export function briefSession(
  detail: BriefInput,
  options: { replyChars: number; timedOut?: boolean; identity?: boolean },
): BriefSession {
  const { turn } = detail;
  const phase = detail.phase.value;
  const out: BriefSession = { phase };
  if (options.identity) {
    if (detail.title) out.title = clip(detail.title, TITLE_TEXT);
    if (detail.project) out.project = detail.project;
    // A session nobody named is titled with the start of its first prompt; do not send that twice.
    const prompt = turn?.prompt ? clip(turn.prompt, PROMPT_TEXT) : "";
    const titled = (out.title ?? "").replace(/\.\.\.$/, "");
    if (prompt.length > 0 && (titled.length === 0 || !prompt.startsWith(titled))) out.prompt = prompt;
    else if (prompt.length > 0) {
      delete out.title;
      out.prompt = prompt;
    }
  }
  if (options.timedOut) out.timedOut = true;
  const pending = briefPending(detail.pending).filter((entry) => entry.kind !== "notification" || phase === "needs-input");
  if (NEEDS_REASON.has(phase) || (phase === "needs-input" && pending.length === 0)) out.reason = detail.phase.reason;

  const run = currentRun(detail.run, turn);
  const finished = run?.state === "exited" ? run : null;
  if (phase !== "working") {
    const text = finished?.result ? finished.result.text : turn?.reply ?? null;
    if (text != null && text.length > 0) {
      out.reply = text.length > options.replyChars ? text.slice(0, options.replyChars) : text;
      if (text.length > options.replyChars || finished?.result?.textTruncated || (!finished?.result && turn?.replyTruncated)) out.replyTruncated = true;
    }
    if (finished && finished.exitCode != null && finished.exitCode !== 0) out.exitCode = finished.exitCode;
    const denied = finished?.result?.permissionDenials ?? [];
    if (denied.length > 0) out.denied = denied.map((item) => (item.input ? `${item.tool}: ${clip(item.input, STEP_INPUT)}` : item.tool));
  }
  if (turn) {
    if (turn.toolCalls > 0) out.toolCalls = turn.toolCalls;
    if (turn.toolErrors > 0) out.toolErrors = turn.toolErrors;
    const newest = turn.steps[turn.steps.length - 1];
    if (phase === "working" && newest) out.now = stepLine(newest);
    if ((phase === "interrupted" || phase === "failed" || phase === "stopped") && turn.steps.length > 0) {
      out.lastSteps = turn.steps.slice(-LAST_STEPS).map(stepLine);
    }
  }
  if (pending.length > 0) out.pending = pending;
  const git = briefGit(detail.git);
  if (git && phase !== "working" && Object.keys(git).length > 0) out.git = git;
  return out;
}

export type BriefRow = {
  id: string;
  title?: string;
  project?: string;
  status: string;
  branch?: string;
  /** Last activity, UTC, to the minute. */
  at?: string;
  pending?: number;
};

export function briefList(cards: readonly SessionCard[], scanned: number): { sessions: BriefRow[]; more?: number } {
  const sessions = cards.map((card) => {
    const row: BriefRow = { id: card.sessionId, status: card.status.value };
    if (card.title) row.title = clip(card.title, TITLE_TEXT);
    if (card.projectName) row.project = card.projectName;
    if (card.branch) row.branch = card.branch;
    if (card.lastActivity) row.at = `${card.lastActivity.slice(0, 16)}Z`;
    const waiting = (card.pending ?? []).filter((entry) => !entry.answered && entry.kind !== "notification").length;
    if (waiting > 0) row.pending = waiting;
    return row;
  });
  const more = scanned - cards.length;
  return more > 0 ? { sessions, more } : { sessions };
}

const SEND_DROPPED = new Set(["notice", "displayedInDesktop", "ticketId", "offerId", "worktreeLaunch", "attachments"]);

/**
 * A send_followup outcome without the fixed notice text, ticket ids, and nulls. sessionId stays
 * only when the resume produced a different id than the one the caller sent.
 */
export function briefSend(outcome: FollowupOutcome, sentId: string, replyChars: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outcome)) {
    if (SEND_DROPPED.has(key) || value == null) continue;
    if (key === "sessionId" && typeof value === "string" && value.toLowerCase() === sentId.toLowerCase()) continue;
    if (key === "exitCode" && value === 0) continue;
    if (key === "result" && typeof value === "string" && value.length > replyChars) {
      out.result = value.slice(0, replyChars);
      out.resultTruncated = true;
      continue;
    }
    out[key] = value;
  }
  if (outcome.disposition === "unsupported") out.notice = outcome.notice;
  if (outcome.disposition === "started" || outcome.disposition === "handed") out.next = "wait_session";
  if ("attachments" in outcome && outcome.attachments && outcome.attachments.length > 0) out.attachments = outcome.attachments.length;
  return out;
}

const START_DROPPED = new Set(["recordId", "claudePid", "prepared"]);

/** A launch result without nulls, process ids, and a fastMode report nobody asked for. */
export function briefStart(started: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(started)) {
    if (START_DROPPED.has(key) || value == null) continue;
    if (key === "fastMode") {
      const report = value as { requested?: unknown; state?: unknown };
      if (report.requested === true) out.fastMode = report.state ?? "unknown";
      continue;
    }
    out[key] = value;
  }
  return out;
}
