import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunState, WorktreeLaunch } from "./domain.js";
import { DeskError, assertNever } from "./domain.js";
import { sessionRecordName } from "./paths.js";
import { processAlive } from "./registry.js";

export type FollowupMode = "queue" | "steer";

export type QueueReason =
  | "running"
  | "sessions-dir-unreadable"
  | "sessions-file-unverified"
  | "busy"
  | "uncertain-writer";

export type TicketState = "queued" | "sending" | "sent" | "failed" | "uncertain";

export type TicketView = {
  ticketId: string;
  sessionId: string;
  state: TicketState;
  enqueuedAt: string;
  exitCode?: number;
};

export type FollowupOutcome =
  | {
      disposition: "sent";
      result: string;
      exitCode: number;
      sessionId: string | null;
      displayedInDesktop: false;
      notice: string;
      worktreeLaunch: WorktreeLaunch;
      ticketId: string;
      attachments?: StagedAttachmentView[];
    }
  | {
      disposition: "queued";
      ticketId: string;
      sessionId: string;
      reason: QueueReason;
      displayedInDesktop: false;
      notice: string;
      attachments?: StagedAttachmentView[];
    }
  | {
      disposition: "handed";
      sessionId: string;
      offerId: string;
      observedStatus: string | null;
      displayedInDesktop: false;
      notice: string;
      attachments?: StagedAttachmentView[];
    }
  | {
      disposition: "undelivered";
      sessionId: string;
      code: "no-listener";
      displayedInDesktop: false;
      notice: string;
    }
  | {
      disposition: "rejected";
      sessionId: string;
      code: "auth" | "session" | "malformed";
      displayedInDesktop: false;
      notice: string;
    }
  | {
      disposition: "unsupported";
      sessionId: string;
      code: "unsupported";
      displayedInDesktop: false;
      notice: string;
    };

type Ticket = {
  ticketId: string;
  sessionId: string;
  message: string;
  state: TicketState;
  enqueuedAt: string;
  exitCode?: number;
  writerPid?: number;
  writerExited?: boolean;
};

export type StagedAttachmentView = {
  path: string;
  mediaType: string;
  bytes: number;
};

export type DeliveredSend = {
  ticketId: string;
  exitCode: number;
  result: string;
  sessionId: string | null;
  worktreeLaunch: WorktreeLaunch;
};

export type DeliverResult =
  | { blocked: true }
  | { blocked: false; reason: QueueReason | null; delivered: DeliveredSend[] };

const TICKET_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i;
const MAX_TICKET_BYTES = 200_000;

export const QUEUE_NOTICE =
  "The message is stored as a ticket. This server will not resume it while a live process may still be writing the transcript. It is not injected into the open Code tab. Ask for delivery again only after that process is gone.";

export const STEER_NOTICE =
  "Steer is not available. No documented interface lets this server interrupt a live Code-tab session without signaling that process. Type the correction in the Code tab, or turn on Remote Control and send from claude.ai/code or the Claude mobile app. Remote Control sends the message through Anthropic servers. This server does not call it.";

export function queueDirectory(home: string, sessionId: string): string {
  return path.join(home, ".claude-remote", "queue", sessionId);
}

export function soleWriterAllowed(runState: RunState): boolean {
  switch (runState.kind) {
    case "finished":
      return true;
    case "running":
      return false;
    case "unknown":
      switch (runState.reason) {
        case "tail-open":
          return true;
        case "sessions-dir-unreadable":
        case "sessions-file-unverified":
          return false;
        default: {
          const _never: never = runState.reason;
          return assertNever(_never);
        }
      }
    default: {
      const _never: never = runState;
      return assertNever(_never);
    }
  }
}

export function blockReason(runState: RunState): QueueReason | null {
  switch (runState.kind) {
    case "finished":
      return null;
    case "running":
      return "running";
    case "unknown":
      switch (runState.reason) {
        case "tail-open":
          return null;
        case "sessions-dir-unreadable":
          return "sessions-dir-unreadable";
        case "sessions-file-unverified":
          return "sessions-file-unverified";
        default: {
          const _never: never = runState.reason;
          return assertNever(_never);
        }
      }
    default: {
      const _never: never = runState;
      return assertNever(_never);
    }
  }
}

export async function enqueueTicket(home: string, sessionId: string, message: string, ticketId?: string): Promise<TicketView> {
  const dir = queueDirectory(home, sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const ticket: Ticket = {
    ticketId: ticketId ?? randomUUID(),
    sessionId,
    message,
    state: "queued",
    enqueuedAt: new Date().toISOString(),
  };
  await writeTicket(dir, ticket);
  return viewOf(ticket);
}

export async function listTicketViews(home: string, sessionId: string): Promise<TicketView[]> {
  const tickets = await readTickets(queueDirectory(home, sessionId));
  return tickets.map(viewOf);
}

export async function deliverQueue(input: {
  home: string;
  sessionId: string;
  refresh: () => Promise<{ allowed: boolean; reason: QueueReason | null }>;
  send: (message: string, onChild: (pid: number) => Promise<void>) => Promise<{
    result: string;
    exitCode: number;
    sessionId: string | null;
    worktreeLaunch: WorktreeLaunch;
  }>;
}): Promise<DeliverResult> {
  const dir = queueDirectory(input.home, input.sessionId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return withLock(dir, async () => {
    const stopped = await settleInFlight(dir);
    if (stopped) return { blocked: false as const, reason: stopped, delivered: [] };
    const delivered: DeliveredSend[] = [];
    const tickets = await readTickets(dir);
    for (const ticket of tickets) {
      if (ticket.state !== "queued") continue;
      const gate = await input.refresh();
      if (!gate.allowed) {
        return { blocked: false as const, reason: gate.reason ?? "running", delivered };
      }
      await writeTicket(dir, { ...ticket, state: "sending" });
      try {
        const spawned = await input.send(ticket.message, async (pid) => {
          await writeTicket(dir, { ...ticket, state: "sending", writerPid: pid });
        });
        await writeTicket(dir, {
          ...ticket,
          state: "sent",
          exitCode: spawned.exitCode,
          writerPid: undefined,
          writerExited: undefined,
        });
        delivered.push({
          ticketId: ticket.ticketId,
          exitCode: spawned.exitCode,
          result: spawned.result,
          sessionId: spawned.sessionId,
          worktreeLaunch: spawned.worktreeLaunch,
        });
      } catch (error) {
        await writeTicket(dir, { ...ticket, state: "failed", writerPid: undefined });
        throw error;
      }
    }
    return { blocked: false as const, reason: null, delivered };
  });
}

async function settleInFlight(dir: string): Promise<QueueReason | null> {
  const tickets = await readTickets(dir);
  let unknownWriter = false;
  let liveWriter = false;
  for (const ticket of tickets) {
    if (ticket.state === "uncertain" && ticket.writerExited !== true) unknownWriter = true;
    if (ticket.state !== "sending") continue;
    if (ticket.writerPid != null && processAlive(ticket.writerPid)) {
      liveWriter = true;
      continue;
    }
    if (ticket.writerPid == null) {
      // No child pid was stored, so a detached claude may still be writing.
      await writeTicket(dir, { ...ticket, state: "uncertain", writerExited: false });
      unknownWriter = true;
      continue;
    }
    await writeTicket(dir, { ...ticket, state: "uncertain", writerExited: true });
  }
  if (liveWriter) return "busy";
  if (unknownWriter) return "uncertain-writer";
  return null;
}

async function withLock(dir: string, body: () => Promise<DeliverResult>): Promise<DeliverResult> {
  const lockPath = path.join(dir, "lock");
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code !== "EEXIST") throw error;
      const holder = await readLockPid(lockPath);
      if (holder != null && processAlive(holder)) return { blocked: true };
      if (holder == null && await lockIsFresh(lockPath)) return { blocked: true };
      await unlink(lockPath).catch(() => undefined);
    }
  }
  if (!handle) return { blocked: true };
  try {
    await handle.writeFile(String(process.pid));
    await chmod(lockPath, 0o600);
    return await body();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function lockIsFresh(lockPath: string): Promise<boolean> {
  try {
    const info = await lstat(lockPath);
    return Date.now() - info.mtimeMs < 2000;
  } catch {
    return false;
  }
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const text = await readFile(lockPath, "utf8");
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

async function readTickets(dir: string): Promise<Ticket[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return [];
    throw error;
  }
  const tickets: Ticket[] = [];
  for (const name of names) {
    if (sessionRecordName(name) === "key") continue;
    if (!TICKET_NAME.test(name)) continue;
    const full = path.join(dir, name);
    const info = await lstat(full);
    if (!info.isFile() || info.size > MAX_TICKET_BYTES) {
      throw new DeskError("invalid-ticket", "queue ticket is unreadable");
    }
    const text = await readFile(full, "utf8");
    tickets.push(parseTicket(name, text));
  }
  tickets.sort((a, b) => {
    if (a.enqueuedAt === b.enqueuedAt) return a.ticketId < b.ticketId ? -1 : 1;
    return a.enqueuedAt < b.enqueuedAt ? -1 : 1;
  });
  return tickets;
}

function parseTicket(name: string, text: string): Ticket {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeskError("invalid-ticket", "queue ticket is unreadable");
  }
  if (!parsed || typeof parsed !== "object") throw new DeskError("invalid-ticket", "queue ticket is unreadable");
  const record = parsed as Record<string, unknown>;
  const ticketId = typeof record.ticketId === "string" ? record.ticketId : "";
  if (`${ticketId}.json` !== name) throw new DeskError("invalid-ticket", "queue ticket is unreadable");
  if (typeof record.sessionId !== "string" || typeof record.message !== "string") {
    throw new DeskError("invalid-ticket", "queue ticket is unreadable");
  }
  if (typeof record.enqueuedAt !== "string" || record.enqueuedAt.length === 0) {
    throw new DeskError("invalid-ticket", "queue ticket is unreadable");
  }
  const state = parseState(record.state);
  const ticket: Ticket = {
    ticketId,
    sessionId: record.sessionId,
    message: record.message,
    state,
    enqueuedAt: record.enqueuedAt,
  };
  if (typeof record.exitCode === "number" && Number.isFinite(record.exitCode)) ticket.exitCode = record.exitCode;
  if (typeof record.writerPid === "number" && Number.isInteger(record.writerPid) && record.writerPid > 0) {
    ticket.writerPid = record.writerPid;
  }
  if (record.writerExited === true) ticket.writerExited = true;
  if (record.writerExited === false) ticket.writerExited = false;
  return ticket;
}

function parseState(value: unknown): TicketState {
  switch (value) {
    case "queued":
    case "sending":
    case "sent":
    case "failed":
    case "uncertain":
      return value;
    default:
      throw new DeskError("invalid-ticket", "queue ticket is unreadable");
  }
}

async function writeTicket(dir: string, ticket: Ticket): Promise<void> {
  const dest = path.join(dir, `${ticket.ticketId}.json`);
  const tmp = path.join(dir, `.${ticket.ticketId}.${process.pid}.tmp`);
  const body: Ticket = {
    ticketId: ticket.ticketId,
    sessionId: ticket.sessionId,
    message: ticket.message,
    state: ticket.state,
    enqueuedAt: ticket.enqueuedAt,
  };
  if (ticket.exitCode != null) body.exitCode = ticket.exitCode;
  if (ticket.writerPid != null) body.writerPid = ticket.writerPid;
  if (ticket.writerExited != null) body.writerExited = ticket.writerExited;
  await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, dest);
}

function viewOf(ticket: Ticket): TicketView {
  const view: TicketView = {
    ticketId: ticket.ticketId,
    sessionId: ticket.sessionId,
    state: ticket.state,
    enqueuedAt: ticket.enqueuedAt,
  };
  if (ticket.exitCode != null) view.exitCode = ticket.exitCode;
  return view;
}
