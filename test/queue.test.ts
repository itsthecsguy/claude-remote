import assert from "node:assert/strict";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listenerSocket, serveChannel } from "../src/channel.js";
import { DeskError } from "../src/domain.js";
import { queueDirectory } from "../src/queue.js";
import type { ProcessIdentityLookup } from "../src/registry.js";
import { queueStatus, sendFollowup } from "../src/tools.js";
import { captureError, configAt, tempDir, tempHome } from "./helpers.js";

const SENTINEL = "queue-sentinel-do-not-log";

test("a running session is undelivered and does not spawn or store a ticket", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const config = configAt(home, root, { allowSend: true });
  let outcome: Awaited<ReturnType<typeof sendFollowup>> | undefined;
  const logs = await captureError(async () => {
    outcome = await sendFollowup(config, { sessionId: id, message: SENTINEL, confirm: true }, async () => [], live4242);
  });
  assert.ok(outcome);
  assert.equal(outcome.disposition, "undelivered");
  if (outcome.disposition !== "undelivered") return;
  assert.equal(outcome.code, "no-listener");
  assert.equal(outcome.sessionId, id);
  assert.equal(outcome.displayedInDesktop, false);
  assert.equal(JSON.stringify(outcome).includes(SENTINEL), false);
  assert.equal(logs.includes(SENTINEL), false);
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  await assert.rejects(() => stat(queueDirectory(home, id)));
});

test("a running session hands the frame to a listener and does not spawn", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const server = await serveChannel(listenerSocket(home, id));
  try {
    const config = configAt(home, root, { allowSend: true });
    let outcome: Awaited<ReturnType<typeof sendFollowup>> | undefined;
    const logs = await captureError(async () => {
      outcome = await sendFollowup(config, { sessionId: id, message: SENTINEL, confirm: true }, async () => [], live4242);
    });
    assert.ok(outcome);
    assert.equal(outcome.disposition, "handed");
    if (outcome.disposition !== "handed") return;
    assert.equal(outcome.displayedInDesktop, false);
    assert.equal(outcome.observedStatus, null);
    assert.equal(outcome.sessionId, id);
    assert.equal(server.received.length, 1);
    assert.equal(server.received[0], SENTINEL);
    assert.equal(JSON.stringify(outcome).includes(SENTINEL), false);
    assert.equal(logs.includes(SENTINEL), false);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
    await assert.rejects(() => stat(queueDirectory(home, id)));
  } finally {
    await server.close();
  }
});

test("steer returns unsupported and does not queue or spawn", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  const idle = await sendFollowup(config, { sessionId: id, message: SENTINEL, confirm: true, mode: "steer" }, async () => []);
  assert.equal(idle.disposition, "unsupported");
  if (idle.disposition !== "unsupported") return;
  assert.equal(idle.code, "unsupported");
  assert.equal(JSON.stringify(idle).includes(SENTINEL), false);
  await assert.rejects(() => stat(queueDirectory(home, id)));
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));

  await writeLiveSession(root, id);
  const running = await sendFollowup(config, { sessionId: id, message: SENTINEL, confirm: true, mode: "steer" }, async () => [], live4242);
  assert.equal(running.disposition, "unsupported");
  await assert.rejects(() => stat(queueDirectory(home, id)));
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
});

test("a missing session is not found and creates no ticket", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await mkdir(path.join(root, "projects", "slug"), { recursive: true });
  await assert.rejects(
    () => sendFollowup(configAt(home, root, { allowSend: true }), { sessionId: id, message: SENTINEL, confirm: true }),
    (error: unknown) => error instanceof DeskError && error.code === "not-found",
  );
  await assert.rejects(() => stat(queueDirectory(home, id)));
});

test("a missing session directory does not enqueue", async () => {
  const { home, root } = await tempHome();
  const missing = path.join(root, "gone");
  const id = await writeSession(root, missing);
  await assert.rejects(
    () => sendFollowup(configAt(home, root, { allowSend: true }), { sessionId: id, message: SENTINEL, confirm: true }),
    (error: unknown) => error instanceof DeskError && error.code === "missing-cwd",
  );
  await assert.rejects(() => stat(queueDirectory(home, id)));
});

test("queue status shows a persisted ticket and hides the message", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const ticketId = "33333333-3333-4333-8333-333333333333";
  await plant(home, id, {
    ticketId,
    sessionId: id,
    message: SENTINEL,
    state: "queued",
    enqueuedAt: "2020-01-01T00:00:00.000Z",
  });
  const config = configAt(home, root, { allowSend: true });
  const status = await queueStatus(config, { sessionId: id }, async () => [], live4242);
  assert.equal(status.tickets.length, 1);
  const ticket = status.tickets[0];
  assert.ok(ticket);
  assert.equal(ticket.ticketId, ticketId);
  assert.equal(ticket.sessionId, id);
  assert.equal(ticket.state, "queued");
  assert.equal(ticket.enqueuedAt, "2020-01-01T00:00:00.000Z");
  assert.equal(status.delivered.length, 0);
  assert.equal(status.blocked, false);
  assert.equal(JSON.stringify(status).includes(SENTINEL), false);
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  const info = await stat(path.join(queueDirectory(home, id), `${ticketId}.json`));
  assert.equal(info.mode & 0o777, 0o600);
});

test("an existing ticket stays queued while the session is live and is sent once it is not", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const ticketId = "44444444-4444-4444-8444-444444444444";
  await plant(home, id, {
    ticketId,
    sessionId: id,
    message: SENTINEL,
    state: "queued",
    enqueuedAt: "2020-01-01T00:00:00.000Z",
  });
  const config = configAt(home, root, { allowSend: true });
  let live = true;
  const identity: ProcessIdentityLookup = async (pid) => live && pid === 4242
    ? { alive: true, startToken: "100" }
    : { alive: false };
  const fresh = await sendFollowup(config, { sessionId: id, message: "fresh-sentinel", confirm: true }, async () => [], identity);
  assert.equal(fresh.disposition, "undelivered");
  await assert.rejects(
    () => queueStatus(config, { sessionId: id, deliver: true, confirm: false }, async () => [], identity),
    (error: unknown) => error instanceof DeskError && error.code === "confirm-required",
  );
  const held = await queueStatus(config, { sessionId: id, deliver: true, confirm: true }, async () => [], identity);
  assert.equal(held.delivered.length, 0);
  assert.equal(held.reason, "running");
  assert.equal(held.tickets.find((ticket) => ticket.ticketId === ticketId)?.state, "queued");
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  live = false;
  const status = await queueStatus(config, { sessionId: id, deliver: true, confirm: true }, async () => [], identity);
  assert.equal(status.blocked, false);
  assert.equal(status.reason, null);
  assert.equal(status.delivered.length, 1);
  assert.equal(status.delivered[0]?.ticketId, ticketId);
  assert.equal(status.delivered[0]?.state, "sent");
  const view = status.tickets.find((ticket) => ticket.ticketId === ticketId);
  assert.equal(view?.state, "sent");
  assert.equal(JSON.stringify(status).includes(SENTINEL), false);
  assert.equal(JSON.stringify(status).includes("fresh-sentinel"), false);
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as { argv: string[] };
  assert.equal(record.argv.at(-1), SENTINEL);
  assert.equal(record.argv.includes("fresh-sentinel"), false);
  const again = await queueStatus(config, { sessionId: id, deliver: true, confirm: true }, async () => [], identity);
  assert.equal(again.delivered.length, 0);
  const lines = (await readFile(path.join(project, "fake-claude-log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
});

test("a ticket left in sending is not spawned, and it blocks a later ticket", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const older = "11111111-1111-4111-8111-111111111111";
  await plant(home, id, {
    ticketId: older,
    sessionId: id,
    message: "older-sentinel",
    state: "sending",
    enqueuedAt: "2020-01-01T00:00:00.000Z",
  });
  const newer = "55555555-5555-4555-8555-555555555555";
  await plant(home, id, {
    ticketId: newer,
    sessionId: id,
    message: SENTINEL,
    state: "queued",
    enqueuedAt: "2020-01-02T00:00:00.000Z",
  });
  const config = configAt(home, root, { allowSend: true });
  const identity: ProcessIdentityLookup = async () => ({ alive: false });
  const status = await queueStatus(config, { sessionId: id, deliver: true, confirm: true }, async () => [], identity);
  assert.equal(status.reason, "uncertain-writer");
  assert.equal(status.delivered.length, 0);
  assert.equal(status.tickets.find((ticket) => ticket.ticketId === older)?.state, "uncertain");
  assert.equal(status.tickets.find((ticket) => ticket.ticketId === newer)?.state, "queued");
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  assert.equal(JSON.stringify(status).includes(SENTINEL), false);
  assert.equal(JSON.stringify(status).includes("older-sentinel"), false);
});

test("a dead writer is not resent, and the next ticket is sent once", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const older = "22222222-2222-4222-8222-222222222222";
  await plant(home, id, {
    ticketId: older,
    sessionId: id,
    message: "older-sentinel",
    state: "sending",
    enqueuedAt: "2020-01-01T00:00:00.000Z",
    writerPid: 2147483646,
  });
  const newer = "66666666-6666-4666-8666-666666666666";
  await plant(home, id, {
    ticketId: newer,
    sessionId: id,
    message: SENTINEL,
    state: "queued",
    enqueuedAt: "2020-01-02T00:00:00.000Z",
  });
  const config = configAt(home, root, { allowSend: true });
  const identity: ProcessIdentityLookup = async () => ({ alive: false });
  const status = await queueStatus(config, { sessionId: id, deliver: true, confirm: true }, async () => [], identity);
  assert.equal(status.delivered.length, 1);
  assert.equal(status.delivered[0]?.ticketId, newer);
  assert.equal(status.tickets.find((ticket) => ticket.ticketId === older)?.state, "uncertain");
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as { argv: string[]; stdin: string };
  assert.equal(record.argv.includes("older-sentinel"), false);
  assert.equal(record.stdin.includes("older-sentinel"), false);
  assert.equal(record.argv.at(-1), SENTINEL);
  const lines = (await readFile(path.join(project, "fake-claude-log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
});

test("a live delivery lock keeps a second writer from spawning", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeFile(path.join(project, "fake-claude-sleep-ms"), "1500");
  const config = configAt(home, root, { allowSend: true });
  const pending = sendFollowup(config, { sessionId: id, message: SENTINEL, confirm: true });
  const lockPath = path.join(queueDirectory(home, id), "lock");
  const deadline = Date.now() + 4000;
  let sawLock = false;
  while (Date.now() < deadline) {
    try {
      await stat(lockPath);
      sawLock = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
  assert.equal(sawLock, true);
  const status = await queueStatus(config, { sessionId: id, deliver: true, confirm: true });
  assert.equal(status.blocked, true);
  assert.equal(status.reason, "busy");
  assert.equal(status.delivered.length, 0);
  const first = await pending;
  assert.equal(first.disposition, "sent");
  const lines = (await readFile(path.join(project, "fake-claude-log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
});

test("an unverified or unreadable sessions directory is undelivered and does not spawn", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const unverified: ProcessIdentityLookup = async (pid) => pid === 4242 ? { alive: true } : { alive: false };
  const config = configAt(home, root, { allowSend: true });
  const first = await sendFollowup(config, { sessionId: id, message: SENTINEL, confirm: true }, async () => [], unverified);
  assert.equal(first.disposition, "undelivered");
  if (first.disposition === "undelivered") assert.equal(first.code, "no-listener");
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  await assert.rejects(() => stat(queueDirectory(home, id)));

  const other = await tempDir("claude-remote-proj-");
  const secondHome = await tempHome();
  const otherId = await writeSession(secondHome.root, other, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  await writeFile(path.join(secondHome.root, "sessions"), "not-a-directory");
  const second = await sendFollowup(
    configAt(secondHome.home, secondHome.root, { allowSend: true }),
    { sessionId: otherId, message: SENTINEL, confirm: true },
    async () => [],
  );
  assert.equal(second.disposition, "undelivered");
  await assert.rejects(() => stat(path.join(other, "fake-claude-record.json")));
  await assert.rejects(() => stat(queueDirectory(secondHome.home, otherId)));
});

test("a key file in the queue directory is not opened", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const config = configAt(home, root, { allowSend: true });
  await mkdir(queueDirectory(home, id), { recursive: true });
  const key = path.join(queueDirectory(home, id), "4242.secret.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  const status = await queueStatus(config, { sessionId: id }, async () => [], live4242);
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
  assert.equal(JSON.stringify(status).includes("SECRET-KEY-BODY"), false);
});

async function writeSession(root: string, cwd: string, id = "abcdefab-cdef-4def-8aaa-abcdefabcdef"): Promise<string> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const user = "a1111111-1111-4111-8111-111111111101";
  const assistant = "a1111111-1111-4111-8111-111111111102";
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: user,
      parentUuid: null,
      sessionId: id,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd,
      message: { role: "user", content: "hello session" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: assistant,
      parentUuid: user,
      sessionId: id,
      timestamp: "2024-01-01T00:00:01.000Z",
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "ready" }] },
    }),
  ];
  await writeFile(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  return id;
}

async function writeLiveSession(root: string, id: string): Promise<void> {
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "sessions", "4242.json"), JSON.stringify({
    pid: 4242,
    sessionId: id,
    procStart: "100",
  }));
}

const live4242: ProcessIdentityLookup = async (pid) => pid === 4242
  ? { alive: true, startToken: "100" }
  : { alive: false };

async function plant(home: string, sessionId: string, ticket: Record<string, string | number | boolean>): Promise<void> {
  const ticketId = ticket.ticketId;
  if (typeof ticketId !== "string") throw new Error("ticket id");
  const dir = queueDirectory(home, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${ticketId}.json`), `${JSON.stringify(ticket)}\n`, { mode: 0o600 });
}
