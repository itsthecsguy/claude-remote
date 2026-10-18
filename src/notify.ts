import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { logEvent } from "./log.js";
import type { PendingChange, PendingStore, PendingView } from "./pending.js";
import { tokenDirectory } from "./token.js";

/**
 * Optional push alerts for new pending entries.
 *
 * When CLAUDE_REMOTE_NOTIFY_URL (or the notify.json the installer writes) names an endpoint, the
 * HTTP helper POSTs one small JSON event for each new pending permission request, question, or
 * notification. Delivery is fire-and-forget on a short timeout with a small retry, and never
 * blocks the hook that created the entry. By default the body carries ids and names only; the
 * question, message, or tool-input text is added only with CLAUDE_REMOTE_NOTIFY_INCLUDE_TEXT=1.
 *
 * With a secret the body is signed: X-Claude-Remote-Signature is
 * "sha256=" + hex(HMAC-SHA256(secret, timestamp + "." + body)) and X-Claude-Remote-Timestamp is
 * the Unix time in seconds. CLAUDE_REMOTE_NOTIFY_AUTH=bearer sends the secret as a bearer token
 * instead. Logs never carry the URL, the secret, or any text.
 */

export type NotifyAuth = "hmac" | "bearer";

export type NotifySettings = {
  url: string;
  secret: string | null;
  auth: NotifyAuth;
  includeText: boolean;
  cleared: boolean;
};

export type NotifyFile = {
  url: string;
  secret?: string;
  auth?: NotifyAuth;
  includeText?: boolean;
  cleared?: boolean;
};

export type NotifyPayload = {
  type: "claude-remote.pending";
  event: "pending" | "cleared";
  eventId: string;
  requestId: string;
  sessionId: string;
  projectName: string | null;
  kind: PendingView["kind"];
  toolName: string | null;
  notificationType: string | null;
  createdAt: string;
  sentAt: string;
  answerable: boolean;
  text?: string;
  title?: string | null;
  questions?: PendingView["questions"];
};

export type NotifySend = (url: string, init: { headers: Record<string, string>; body: string; timeoutMs: number }) => Promise<number>;

const MAX_FILE = 16 * 1024;
const MAX_SECRET = 512;
const TIMEOUT_MS = 3000;
const RETRY_DELAYS_MS = [500, 2000];
const MAX_QUEUE = 100;
const MAX_IN_FLIGHT = 4;
const MAX_REMEMBERED = 1000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function notifyFilePath(home: string): string {
  return path.join(tokenDirectory(home), "notify.json");
}

/** Accept https anywhere, and plain http only for a receiver on this machine. */
export function checkNotifyUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === "https:") return url.toString();
  if (url.protocol === "http:" && LOOPBACK.has(url.hostname)) return url.toString();
  return null;
}

/** The URL without its query string or fragment, for reports. */
export function describeNotifyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid";
  }
}

function checkSecret(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length < 16 || trimmed.length > MAX_SECRET || /[\s"\\]/.test(trimmed)) return null;
  return trimmed;
}

export function secretUsable(raw: string): boolean {
  return checkSecret(raw) !== null;
}

/** Environment first, then ~/.claude-remote/http/notify.json. Null when alerts are off. */
export async function loadNotifySettings(env: NodeJS.ProcessEnv, home: string): Promise<NotifySettings | null> {
  const file = await readNotifyFile(home);
  const rawUrl = env.CLAUDE_REMOTE_NOTIFY_URL || file?.url;
  if (!rawUrl) return null;
  const url = checkNotifyUrl(rawUrl);
  if (!url) {
    logEvent({ tool: "notify", code: "url-refused" });
    return null;
  }
  const rawSecret = env.CLAUDE_REMOTE_NOTIFY_SECRET || file?.secret;
  const secret = rawSecret ? checkSecret(rawSecret) : null;
  if (rawSecret && !secret) {
    logEvent({ tool: "notify", code: "secret-refused" });
    return null;
  }
  const authRaw = env.CLAUDE_REMOTE_NOTIFY_AUTH || file?.auth || "hmac";
  return {
    url,
    secret,
    auth: authRaw === "bearer" ? "bearer" : "hmac",
    includeText: env.CLAUDE_REMOTE_NOTIFY_INCLUDE_TEXT === "1" || (env.CLAUDE_REMOTE_NOTIFY_INCLUDE_TEXT === undefined && file?.includeText === true),
    cleared: env.CLAUDE_REMOTE_NOTIFY_CLEARED === "1" || (env.CLAUDE_REMOTE_NOTIFY_CLEARED === undefined && file?.cleared === true),
  };
}

async function readNotifyFile(home: string): Promise<NotifyFile | null> {
  const file = notifyFilePath(home);
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE) return null;
    if ((info.mode & 0o077) !== 0) {
      logEvent({ tool: "notify", code: "file-mode-refused" });
      return null;
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      if (!parsed || typeof parsed !== "object" || typeof (parsed as { url?: unknown }).url !== "string") return null;
      return parsed as NotifyFile;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

export function notifyPayload(view: PendingView, event: "pending" | "cleared", settings: Pick<NotifySettings, "includeText">, now: number): NotifyPayload {
  const payload: NotifyPayload = {
    type: "claude-remote.pending",
    event,
    eventId: `${view.requestId}.${event}`,
    requestId: view.requestId,
    sessionId: view.sessionId,
    projectName: view.projectName ?? null,
    kind: view.kind,
    toolName: view.toolName,
    notificationType: view.notificationType,
    createdAt: view.createdAt,
    sentAt: new Date(now).toISOString(),
    answerable: event === "pending" ? view.answerable : false,
  };
  if (settings.includeText && event === "pending") {
    payload.text = view.text;
    payload.title = view.title;
    if (view.questions) payload.questions = view.questions;
  }
  return payload;
}

export function notifyHeaders(body: string, settings: Pick<NotifySettings, "secret" | "auth">, eventId: string, nowMs: number): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "claude-remote/0.1.0",
    "x-claude-remote-delivery": eventId,
  };
  if (!settings.secret) return headers;
  if (settings.auth === "bearer") {
    headers.authorization = `Bearer ${settings.secret}`;
    return headers;
  }
  const timestamp = String(Math.floor(nowMs / 1000));
  headers["x-claude-remote-timestamp"] = timestamp;
  headers["x-claude-remote-signature"] = `sha256=${signBody(settings.secret, timestamp, body)}`;
  return headers;
}

export function signBody(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export const fetchSend: NotifySend = async (url, init) => {
  const response = await fetch(url, {
    method: "POST",
    headers: init.headers,
    body: init.body,
    redirect: "error",
    signal: AbortSignal.timeout(init.timeoutMs),
  });
  await response.arrayBuffer().catch(() => undefined);
  return response.status;
};

type Job = { body: string; eventId: string; attempt: number };

export class Notifier {
  private readonly alerted = new Set<string>();
  private readonly queue: Job[] = [];
  private inFlight = 0;
  private closed = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private idleWaiters: Array<() => void> = [];

  constructor(
    private readonly settings: NotifySettings,
    private readonly store: Pick<PendingStore, "list">,
    private readonly options: { send?: NotifySend; clock?: () => number; retryDelaysMs?: number[]; timeoutMs?: number } = {},
  ) {}

  /** Called synchronously from the store. Only queues work. */
  handle(change: PendingChange): void {
    if (this.closed) return;
    const view = change.view;
    if (change.type === "added") {
      if (this.alerted.has(view.requestId)) return;
      if (this.duplicatePrompt(view)) return;
      this.remember(view.requestId);
      this.enqueue(view, "pending");
      return;
    }
    if (!this.alerted.delete(view.requestId)) return;
    if (this.settings.cleared) this.enqueue(view, "cleared");
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  /** Resolves when nothing is queued, waiting, or in flight. For tests. */
  idle(): Promise<void> {
    if (this.inFlight === 0 && this.queue.length === 0 && this.timers.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  // Claude Code sends a permission_prompt notification a few seconds after the permission
  // request it is about. That request already produced an alert.
  private duplicatePrompt(view: PendingView): boolean {
    if (view.kind !== "notification" || view.notificationType !== "permission_prompt") return false;
    return this.store.list({ sessionId: view.sessionId }).some((entry) => entry.kind !== "notification" && this.alerted.has(entry.requestId));
  }

  private remember(requestId: string): void {
    this.alerted.add(requestId);
    while (this.alerted.size > MAX_REMEMBERED) {
      const oldest = this.alerted.values().next().value;
      if (oldest === undefined) break;
      this.alerted.delete(oldest);
    }
  }

  private enqueue(view: PendingView, event: "pending" | "cleared"): void {
    const now = (this.options.clock ?? Date.now)();
    const payload = notifyPayload(view, event, this.settings, now);
    this.queue.push({ body: JSON.stringify(payload), eventId: payload.eventId, attempt: 0 });
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift();
      logEvent({ tool: "notify", code: "dropped" });
    }
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.inFlight < MAX_IN_FLIGHT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.inFlight += 1;
      void this.deliver(job).finally(() => {
        this.inFlight -= 1;
        this.pump();
        this.checkIdle();
      });
    }
    this.checkIdle();
  }

  private async deliver(job: Job): Promise<void> {
    const send = this.options.send ?? fetchSend;
    const now = (this.options.clock ?? Date.now)();
    let status = 0;
    try {
      status = await send(this.settings.url, {
        headers: notifyHeaders(job.body, this.settings, job.eventId, now),
        body: job.body,
        timeoutMs: this.options.timeoutMs ?? TIMEOUT_MS,
      });
    } catch {
      status = 0;
    }
    if (status >= 200 && status < 300) {
      logEvent({ tool: "notify", code: "sent" });
      return;
    }
    const retryable = status === 0 || status === 429 || status >= 500;
    const delays = this.options.retryDelaysMs ?? RETRY_DELAYS_MS;
    if (!retryable || job.attempt >= delays.length || this.closed) {
      logEvent({ tool: "notify", code: status === 0 ? "failed-network" : `failed-${status}` });
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.closed) return;
      this.queue.unshift({ ...job, attempt: job.attempt + 1 });
      this.pump();
    }, delays[job.attempt]);
    this.timers.add(timer);
  }

  private checkIdle(): void {
    if (this.inFlight !== 0 || this.queue.length !== 0 || this.timers.size !== 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

/** Subscribe a notifier to the store. Returns a stop function. */
export function startNotifier(store: PendingStore, settings: NotifySettings, options?: ConstructorParameters<typeof Notifier>[2]): { notifier: Notifier; stop: () => void } {
  const notifier = new Notifier(settings, store, options);
  const unsubscribe = store.subscribe((change) => notifier.handle(change));
  logEvent({ tool: "notify", code: settings.includeText ? "on-with-text" : "on" });
  return {
    notifier,
    stop: () => {
      unsubscribe();
      notifier.close();
    },
  };
}

export function newNotifySecret(): string {
  return randomBytes(32).toString("base64url");
}
