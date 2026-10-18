import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Config } from "./config.js";
import { DeskError } from "./domain.js";
import { logEvent } from "./log.js";

/**
 * Pending attention reported by Claude Code hooks (see `claude-remote hook`).
 *
 * Entries live in this process's memory. The HTTP helper also saves them to a 0600 file in the
 * state dir (see pending-file.ts) so a restart keeps them. They are never written to the log,
 * because they carry question, notification and tool-input text. Authenticated MCP clients can
 * read them through list_sessions, get_session and list_pending.
 *
 * A PermissionRequest or an AskUserQuestion PreToolUse hook can wait for a remote answer. The
 * answer is one decision for one request: allow or deny, or the chosen answers. It never carries
 * permission rules, updated tool input, or a permission mode.
 */

export type PendingKind = "permission" | "question" | "notification";

export type PendingQuestion = {
  question: string;
  header: string | null;
  multiSelect: boolean;
  options: Array<{ label: string; description: string | null }>;
};

export type PendingView = {
  requestId: string;
  sessionId: string;
  agentId: string | null;
  projectName: string | null;
  kind: PendingKind;
  createdAt: string;
  expiresAt: string | null;
  answerable: boolean;
  toolName: string | null;
  notificationType: string | null;
  title: string | null;
  text: string;
  toolInput: Record<string, string> | null;
  questions: PendingQuestion[] | null;
};

export type PermissionAnswer = { behavior: "allow" | "deny"; message?: string };
export type QuestionAnswer = { answers: Record<string, string> };
export type HookDecision = { kind: "permission"; answer: PermissionAnswer } | { kind: "question"; answer: QuestionAnswer };

/** An entry was added to or removed from the store. */
export type PendingChange = { type: "added" | "removed"; view: PendingView };

export type WaitResult =
  | { state: "decided"; decision: HookDecision }
  | { state: "pending" }
  | { state: "gone" };

type Entry = {
  view: PendingView;
  createdMs: number;
  deadlineMs: number | null;
  matchKey: string | null;
  decision: HookDecision | null;
  waiters: Set<(result: WaitResult) => void>;
  lastSeenMs: number;
  delivered: boolean;
};

/** One entry as saved to disk. Waiters, decisions and answerability are not saved. */
export type SavedEntry = {
  view: PendingView;
  createdMs: number;
  matchKey: string | null;
};

const MAX_ENTRIES = 500;
const MAX_TEXT = 4000;
const MAX_VALUE = 2000;
const MAX_KEYS = 12;
const MAX_SLICE_MS = 25_000;
const SEEN_GRACE_MS = 30_000;
const PROMPT_TTL_MS = 30 * 60 * 1000;
const NOTIFICATION_TTL_MS = 2 * 60 * 60 * 1000;
const NOTIFICATION_STALE_MS = 5_000;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_RE = /^[A-Za-z0-9_-]{16,64}$/;

const CLEAR_ALL_EVENTS = new Set(["UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"]);
const CLEAR_MATCH_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);

export class PendingStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: PendingChange) => void>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Record one hook event. Returns what the hook should do next. */
  record(
    input: unknown,
    options: { allowApprove: boolean; waitMs: number },
  ): { requestId: string | null; wait: boolean; waitMs: number } {
    const none = { requestId: null, wait: false, waitMs: 0 };
    if (!input || typeof input !== "object" || Array.isArray(input)) return none;
    const event = input as Record<string, unknown>;
    const sessionId = safeId(event.session_id);
    const name = typeof event.hook_event_name === "string" ? event.hook_event_name : "";
    if (!sessionId) return none;
    const agentId = safeId(event.agent_id);
    const projectName = projectNameOf(event.cwd);
    const now = this.clock();
    this.sweep(now);
    if (CLEAR_ALL_EVENTS.has(name)) {
      this.clear((entry) => entry.view.sessionId === sessionId);
      return none;
    }
    if (CLEAR_MATCH_EVENTS.has(name)) {
      const keys = matchKeys(event);
      this.clear((entry) => entry.view.sessionId === sessionId
        && entry.view.agentId === agentId
        && entry.view.kind !== "notification"
        && entry.matchKey !== null
        && keys.includes(entry.matchKey));
      this.clear((entry) => entry.view.sessionId === sessionId && entry.view.kind === "notification");
      return none;
    }
    const toolName = typeof event.tool_name === "string" ? clip(event.tool_name, 128) : null;
    if (name === "Notification") {
      this.clear((entry) => entry.view.sessionId === sessionId && entry.view.kind === "notification");
      const text = typeof event.message === "string" ? clip(event.message, MAX_TEXT) : "";
      const requestId = this.add({
        sessionId,
        agentId,
        projectName,
        kind: "notification",
        toolName: null,
        notificationType: typeof event.notification_type === "string" ? clip(event.notification_type, 64) : null,
        title: typeof event.title === "string" ? clip(event.title, 200) : null,
        text,
        toolInput: null,
        questions: null,
      }, now, null, null);
      return { requestId, wait: false, waitMs: 0 };
    }
    if (name === "PermissionRequest" && toolName) {
      const toolInput = summarizeInput(event.tool_input, event.mcp_server);
      const waitMs = options.allowApprove ? options.waitMs : 0;
      const requestId = this.add({
        sessionId,
        agentId,
        projectName,
        kind: "permission",
        toolName,
        notificationType: null,
        title: null,
        text: permissionText(toolName, toolInput),
        toolInput,
        questions: null,
      }, now, options.allowApprove ? now + waitMs : null, inputKey(toolName, event.tool_input));
      return { requestId, wait: options.allowApprove, waitMs };
    }
    if (name === "PreToolUse" && toolName === "AskUserQuestion") {
      const questions = parseQuestions(event.tool_input);
      if (!questions) return none;
      const waitMs = options.allowApprove ? options.waitMs : 0;
      const useId = typeof event.tool_use_id === "string" ? clip(event.tool_use_id, 128) : null;
      const requestId = this.add({
        sessionId,
        agentId,
        projectName,
        kind: "question",
        toolName,
        notificationType: null,
        title: null,
        text: questions.map((q) => q.question).join("\n"),
        toolInput: null,
        questions,
      }, now, options.allowApprove ? now + waitMs : null, useId ? `use:${useId}` : inputKey(toolName, event.tool_input));
      return { requestId, wait: options.allowApprove, waitMs };
    }
    return none;
  }

  /** Long-poll for a decision. Resolves within sliceMs. */
  wait(requestId: string, sliceMs: number, signal?: AbortSignal): Promise<WaitResult> {
    const entry = REQUEST_RE.test(requestId) ? this.entries.get(requestId) : undefined;
    const now = this.clock();
    if (!entry || entry.deadlineMs === null) return Promise.resolve({ state: "gone" });
    entry.lastSeenMs = now;
    if (entry.decision) {
      entry.delivered = true;
      return Promise.resolve({ state: "decided", decision: entry.decision });
    }
    if (now >= entry.deadlineMs) {
      entry.deadlineMs = null;
      return Promise.resolve({ state: "gone" });
    }
    const slice = Math.max(0, Math.min(sliceMs, MAX_SLICE_MS, entry.deadlineMs - now));
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | null = null;
      const done = (result: WaitResult) => {
        if (timer) clearTimeout(timer);
        entry.waiters.delete(done);
        signal?.removeEventListener("abort", onAbort);
        entry.lastSeenMs = this.clock();
        if (result.state === "decided") entry.delivered = true;
        resolve(result);
      };
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        entry.waiters.delete(done);
      };
      entry.waiters.add(done);
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => done({ state: "pending" }), slice);
    });
  }

  /** Hand one decision to the waiting hook. */
  async decide(sessionId: string, requestId: string, decision: HookDecision, pickupMs = 3000): Promise<"delivered" | "accepted"> {
    const entry = this.entries.get(requestId);
    if (!entry || entry.view.sessionId !== sessionId) throw new DeskError("not-found", "no pending request with that id for this session");
    if (entry.view.kind !== decision.kind) throw new DeskError("usage", `request is a ${entry.view.kind}, not a ${decision.kind}`);
    if (entry.decision) throw new DeskError("already-answered", "this request already has an answer");
    if (!this.answerable(entry, this.clock())) {
      throw new DeskError("not-answerable", "no hook is waiting for this request any more; answer it in the app or terminal");
    }
    entry.decision = decision;
    entry.view = { ...entry.view, answerable: false };
    for (const waiter of [...entry.waiters]) waiter({ state: "decided", decision });
    const until = this.clock() + pickupMs;
    while (!entry.delivered && this.clock() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return entry.delivered ? "delivered" : "accepted";
  }

  list(filter?: { sessionId?: string }): PendingView[] {
    const now = this.clock();
    this.sweep(now);
    const out: PendingView[] = [];
    for (const entry of this.entries.values()) {
      if (filter?.sessionId && entry.view.sessionId !== filter.sessionId) continue;
      out.push({ ...entry.view, answerable: this.answerable(entry, now) });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return out;
  }

  /** Entries in a form that can be saved, oldest first. */
  snapshot(): SavedEntry[] {
    return [...this.entries.values()].map((entry) => ({ view: { ...entry.view }, createdMs: entry.createdMs, matchKey: entry.matchKey }));
  }

  /**
   * Put saved entries back after a restart. A restored entry is never answerable: the hook that
   * was waiting for it gave up when the helper went away, and the prompt fell back to the app or
   * terminal. Restoring does not notify observers. Returns how many entries were restored.
   */
  restore(saved: readonly SavedEntry[]): number {
    let count = 0;
    for (const item of saved) {
      const view = item.view;
      if (this.entries.has(view.requestId) || !REQUEST_RE.test(view.requestId)) continue;
      this.entries.set(view.requestId, {
        view: { ...view, answerable: false, expiresAt: null },
        createdMs: item.createdMs,
        deadlineMs: null,
        matchKey: item.matchKey,
        decision: null,
        waiters: new Set(),
        lastSeenMs: item.createdMs,
        delivered: false,
      });
      count += 1;
    }
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return count;
  }

  /** Drop entries a status change shows are over. */
  reconcile(sessionId: string, status: string): void {
    const now = this.clock();
    if (status === "not-running") {
      this.clear((entry) => entry.view.sessionId === sessionId);
      return;
    }
    if (status === "working") {
      this.clear((entry) => entry.view.sessionId === sessionId
        && entry.view.kind === "notification"
        && now - entry.createdMs > NOTIFICATION_STALE_MS);
    }
  }

  size(): number {
    return this.entries.size;
  }

  /** Observe entries being added and removed. A throwing listener is ignored. Returns an unsubscribe. */
  subscribe(listener: (change: PendingChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: PendingChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch {
        // a listener must never break hook handling
      }
    }
  }

  private answerable(entry: Entry, now: number): boolean {
    return entry.decision === null
      && entry.deadlineMs !== null
      && now < entry.deadlineMs
      && (entry.waiters.size > 0 || now - entry.lastSeenMs < SEEN_GRACE_MS);
  }

  private add(
    view: Omit<PendingView, "requestId" | "createdAt" | "expiresAt" | "answerable">,
    now: number,
    deadlineMs: number | null,
    matchKey: string | null,
  ): string {
    const requestId = randomBytes(16).toString("base64url");
    this.entries.set(requestId, {
      view: {
        ...view,
        requestId,
        createdAt: new Date(now).toISOString(),
        expiresAt: deadlineMs === null ? null : new Date(deadlineMs).toISOString(),
        answerable: deadlineMs !== null,
      },
      createdMs: now,
      deadlineMs,
      matchKey,
      decision: null,
      waiters: new Set(),
      lastSeenMs: now,
      delivered: false,
    });
    this.emit({ type: "added", view: { ...this.entries.get(requestId)!.view } });
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
    return requestId;
  }

  private clear(match: (entry: Entry) => boolean): void {
    for (const [id, entry] of [...this.entries]) {
      if (match(entry)) this.drop(id);
    }
  }

  private drop(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    for (const waiter of [...entry.waiters]) waiter({ state: "gone" });
    this.emit({ type: "removed", view: { ...entry.view } });
  }

  private sweep(now: number): void {
    this.clear((entry) => {
      const ttl = entry.view.kind === "notification" ? NOTIFICATION_TTL_MS : PROMPT_TTL_MS;
      return now - entry.createdMs > ttl && entry.waiters.size === 0;
    });
  }
}

export const pendingStore = new PendingStore();

function safeId(value: unknown): string | null {
  if (typeof value !== "string" || !ID_RE.test(value)) return null;
  return value.toLowerCase();
}

function projectNameOf(cwd: unknown): string | null {
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 4096) return null;
  const name = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  return name.length > 0 ? clip(name, 200) : null;
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function oneLine(value: unknown, max: number): string | null {
  if (typeof value === "string") return clip(value, max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return null;
  try {
    return clip(JSON.stringify(value), Math.min(max, 500));
  } catch {
    return null;
  }
}

export function summarizeInput(input: unknown, mcpServer?: unknown): Record<string, string> | null {
  const out: Record<string, string> = {};
  if (mcpServer && typeof mcpServer === "object") {
    const name = (mcpServer as { name?: unknown }).name;
    if (typeof name === "string") out.mcp_server = clip(name, 128);
  }
  if (input && typeof input === "object" && !Array.isArray(input)) {
    let count = 0;
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (count >= MAX_KEYS) break;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
      const text = oneLine(value, MAX_VALUE);
      if (text === null) continue;
      out[key] = text;
      count += 1;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function permissionText(toolName: string, input: Record<string, string> | null): string {
  const lead = input?.command ?? input?.file_path ?? input?.url ?? input?.path ?? input?.pattern ?? input?.description ?? null;
  return lead ? `${toolName}: ${clip(lead, MAX_TEXT)}` : toolName;
}

function inputKey(toolName: string, input: unknown): string {
  let text = "";
  try {
    text = JSON.stringify(input ?? null);
  } catch {
    text = "";
  }
  return `in:${createHash("sha256").update(toolName).update("\0").update(text).digest("base64url")}`;
}

function matchKeys(event: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof event.tool_use_id === "string") keys.push(`use:${clip(event.tool_use_id, 128)}`);
  if (typeof event.tool_name === "string") keys.push(inputKey(clip(event.tool_name, 128), event.tool_input));
  return keys;
}

export function parseQuestions(input: unknown): PendingQuestion[] | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { questions?: unknown }).questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: PendingQuestion[] = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    if (typeof q.question !== "string" || q.question.length === 0) continue;
    const options = Array.isArray(q.options) ? q.options.slice(0, 20).flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const o = option as Record<string, unknown>;
      if (typeof o.label !== "string") return [];
      return [{ label: clip(o.label, 200), description: typeof o.description === "string" ? clip(o.description, 500) : null }];
    }) : [];
    out.push({
      question: clip(q.question, MAX_VALUE),
      header: typeof q.header === "string" ? clip(q.header, 200) : null,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out.length > 0 ? out : null;
}

/** Validate answers against the pending entry's questions. */
export function checkAnswers(view: PendingView, answers: Record<string, string>): Record<string, string> {
  const questions = view.questions ?? [];
  const texts = new Set(questions.map((q) => q.question));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (!texts.has(key)) throw new DeskError("usage", "an answer names a question this request does not have");
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_VALUE) throw new DeskError("usage", "each answer must be 1 to 2000 characters");
    out[key] = trimmed;
  }
  for (const text of texts) {
    if (!(text in out)) throw new DeskError("usage", "answer every question in the request");
  }
  return out;
}

export function attachPending<T extends { sessionId: string; status: { value: string } }>(card: T, store: PendingStore = pendingStore): T & { pending: PendingView[] } {
  store.reconcile(card.sessionId, card.status.value);
  return { ...card, pending: store.list({ sessionId: card.sessionId }).slice(0, 10) };
}

const LIST_PENDING_DESCRIPTION = "List what live sessions are waiting on, as reported by the claude-remote Claude Code hooks: permission requests (tool name and a summary of the tool input), AskUserQuestion questions (question text and options), and notifications (message text and notification_type, such as idle_prompt or permission_prompt). Entries are kept in the helper's memory and in a private file in its state dir, so they survive a helper restart (restored entries are never answerable), and are cleared when the session moves on (the next prompt, tool result, or stop) or stops running. answerable is true while a hook is still waiting for a remote answer; answer it with answer_permission or answer_question when those tools are enabled, otherwise answer in the app or terminal. Empty when the hooks are not installed.";

const ANSWER_PERMISSION_DESCRIPTION = "Answer one pending permission request from list_pending. Requires CLAUDE_REMOTE_ALLOW_APPROVE=1 and confirm set to true. decision is allow or deny for this single request only: it never adds a permission rule, never changes the permission mode, and never edits the tool input. Deny and ask rules in the session's settings still apply after an allow. message is passed to Claude with a deny. Fails when no hook is waiting any more (the request timed out to the normal prompt, or was answered locally). The message is not logged.";

const ANSWER_QUESTION_DESCRIPTION = "Answer one pending AskUserQuestion request from list_pending. Requires CLAUDE_REMOTE_ALLOW_APPROVE=1 and confirm set to true. answers maps each question's exact text to the chosen option label (join several labels with commas for a multi-select question, or give free text). Every question in the request must be answered. Fails when no hook is waiting any more. Answers are not logged.";

export function registerPendingTools(server: McpServer, config: Config, store: PendingStore = pendingStore): void {
  server.registerTool(
    "list_pending",
    {
      description: LIST_PENDING_DESCRIPTION,
      inputSchema: z.object({ sessionId: z.string().optional() }),
    },
    async (args) => {
      const filter = args.sessionId ? { sessionId: args.sessionId.toLowerCase() } : undefined;
      const pending = store.list(filter);
      logEvent({ tool: "list_pending", evidence: `count-${pending.length}` });
      return { content: [{ type: "text", text: JSON.stringify({ pending, approveEnabled: config.allowApprove }) }] };
    },
  );
  if (!config.allowApprove) return;
  server.registerTool(
    "answer_permission",
    {
      description: ANSWER_PERMISSION_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
        requestId: z.string(),
        decision: z.enum(["allow", "deny"]),
        message: z.string().max(MAX_VALUE).optional(),
        confirm: z.literal(true),
      }),
    },
    async (args) => {
      try {
        const result = await answerPermission(config, args, store);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return answerError(error);
      }
    },
  );
  server.registerTool(
    "answer_question",
    {
      description: ANSWER_QUESTION_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
        requestId: z.string(),
        answers: z.record(z.string(), z.string()),
        confirm: z.literal(true),
      }),
    },
    async (args) => {
      try {
        const result = await answerQuestion(config, args, store);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return answerError(error);
      }
    },
  );
}

function answerError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const text = error instanceof DeskError ? error.message : "unexpected failure";
  return { isError: true, content: [{ type: "text", text }] };
}

function requireApprove(config: Config, confirm: unknown): void {
  if (!config.allowApprove) throw new DeskError("approve-disabled", "remote answers are off; set CLAUDE_REMOTE_ALLOW_APPROVE=1");
  if (confirm !== true) throw new DeskError("confirm-required", "confirm must be true");
}

export async function answerPermission(
  config: Config,
  input: { sessionId: string; requestId: string; decision: "allow" | "deny"; message?: string; confirm: unknown },
  store: PendingStore = pendingStore,
): Promise<{ disposition: "delivered" | "accepted"; requestId: string; decision: "allow" | "deny" }> {
  requireApprove(config, input.confirm);
  if (input.decision !== "allow" && input.decision !== "deny") throw new DeskError("usage", "decision must be allow or deny");
  const sessionId = input.sessionId.toLowerCase();
  const answer: PermissionAnswer = { behavior: input.decision };
  if (input.decision === "deny" && input.message && input.message.trim().length > 0) answer.message = input.message.trim().slice(0, MAX_VALUE);
  try {
    const disposition = await store.decide(sessionId, input.requestId, { kind: "permission", answer });
    logEvent({ tool: "answer_permission", sessionId: safeId(sessionId) ?? undefined, code: `${input.decision}-${disposition}` });
    return { disposition, requestId: input.requestId, decision: input.decision };
  } catch (error) {
    if (error instanceof DeskError) logEvent({ tool: "answer_permission", code: error.code });
    throw error;
  }
}

export async function answerQuestion(
  config: Config,
  input: { sessionId: string; requestId: string; answers: Record<string, string>; confirm: unknown },
  store: PendingStore = pendingStore,
): Promise<{ disposition: "delivered" | "accepted"; requestId: string }> {
  requireApprove(config, input.confirm);
  const sessionId = input.sessionId.toLowerCase();
  const view = store.list({ sessionId }).find((entry) => entry.requestId === input.requestId);
  if (!view) throw new DeskError("not-found", "no pending request with that id for this session");
  if (view.kind !== "question") throw new DeskError("usage", `request is a ${view.kind}, not a question`);
  const answers = checkAnswers(view, input.answers);
  try {
    const disposition = await store.decide(sessionId, input.requestId, { kind: "question", answer: { answers } });
    logEvent({ tool: "answer_question", sessionId: safeId(sessionId) ?? undefined, code: disposition });
    return { disposition, requestId: input.requestId };
  } catch (error) {
    if (error instanceof DeskError) logEvent({ tool: "answer_question", code: error.code });
    throw error;
  }
}
