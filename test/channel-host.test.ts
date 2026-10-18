import assert from "node:assert/strict";
import { lstat, mkdir, readFile, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { listenerSocket, listenerToken, submitOffer } from "../src/channel.js";
import {
  PINNED_PROTOCOL_VERSION,
  SKIPPED_PROTOCOL_VERSION,
  resolveChannelSessionId,
  runChannelMode,
  startChannelHost,
  type ChannelHost,
} from "../src/channel-host.js";
import { DeskError } from "../src/domain.js";
import { parseSessionId } from "../src/paths.js";
import { queueDirectory } from "../src/queue.js";
import type { ProcessIdentityLookup } from "../src/registry.js";
import { queueStatus, sendFollowup } from "../src/tools.js";
import { captureError, configAt, tempDir, tempHome } from "./helpers.js";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SENTINEL = "channel-sentinel-do-not-log";

test("initialize answers with the pinned revision, not 2026-07-28", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  const started = await boot(home, ID);
  try {
    assert.equal(started.init.id, 7);
    assert.equal(started.init.result.protocolVersion, PINNED_PROTOCOL_VERSION);
    assert.equal(started.text().includes(SKIPPED_PROTOCOL_VERSION), false);
    assert.deepEqual(started.init.result.capabilities.experimental["claude/channel"], {});
    assert.equal("claude/channel/permission" in started.init.result.capabilities.experimental, false);
    assert.equal(started.init.result.serverInfo.name, "claude-remote-channel");
  } finally {
    await started.host.close();
  }
});

test("an idle session emits now and the fake host runs the turn immediately", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  await writeLive(root, ID, "idle");
  const started = await boot(home, ID);
  const fake = new FakeClaudeHost();
  try {
    const config = configAt(home, root, { allowSend: true });
    let outcome: Awaited<ReturnType<typeof sendFollowup>> | undefined;
    const logs = await captureError(async () => {
      outcome = await sendFollowup(config, { sessionId: ID, message: SENTINEL, confirm: true }, async () => [], live4242);
    });
    const notes = channelNotes(started.text());
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.ok(note);
    fake.take(note);
    assert.equal(fake.busy, false);
    assert.deepEqual(fake.turns, [{ content: SENTINEL, when: "now" }]);
    assert.equal(fake.queued.length, 0);
    assert.ok(outcome);
    assert.equal(outcome.disposition, "handed");
    if (outcome.disposition !== "handed") return;
    assert.equal(outcome.observedStatus, "idle");
    assert.equal(outcome.displayedInDesktop, false);
    assert.equal(JSON.stringify(outcome).includes(SENTINEL), false);
    assert.equal(logs.includes(SENTINEL), false);
    const token = await readFile(listenerToken(started.host.socketPath), "utf8");
    assert.equal(logs.includes(token), false);
    assert.equal(started.text().includes(token), false);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
    await assert.rejects(() => stat(queueDirectory(home, ID)));
  } finally {
    await started.host.close();
  }
});

test("a busy session queues the event behind the current turn", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  await writeLive(root, ID, "busy");
  const started = await boot(home, ID);
  const fake = new FakeClaudeHost();
  fake.begin("sleep 20");
  try {
    const config = configAt(home, root, { allowSend: true });
    const outcome = await sendFollowup(config, { sessionId: ID, message: SENTINEL, confirm: true }, async () => [], live4242);
    const notes = channelNotes(started.text());
    assert.equal(notes.length, 1);
    const note = notes[0];
    assert.ok(note);
    fake.take(note);
    assert.equal(fake.current, "sleep 20");
    assert.deepEqual(fake.queued, [SENTINEL]);
    assert.deepEqual(fake.turns, [{ content: "sleep 20", when: "now" }]);
    fake.finish();
    assert.equal(fake.current, "");
    assert.deepEqual(fake.turns, [
      { content: "sleep 20", when: "now" },
      { content: SENTINEL, when: "after-current" },
    ]);
    assert.equal(outcome.disposition, "handed");
    if (outcome.disposition !== "handed") return;
    assert.equal(outcome.observedStatus, "working");
    assert.equal(outcome.displayedInDesktop, false);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    await started.host.close();
  }
});

test("steer does not write a channel notification or spawn", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  await writeLive(root, ID, "busy");
  const started = await boot(home, ID);
  try {
    const outcome = await sendFollowup(
      configAt(home, root, { allowSend: true }),
      { sessionId: ID, message: SENTINEL, confirm: true, mode: "steer" },
      async () => [],
      live4242,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(outcome.disposition, "unsupported");
    assert.equal(channelNotes(started.text()).length, 0);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
    await assert.rejects(() => stat(queueDirectory(home, ID)));
  } finally {
    await started.host.close();
  }
});

test("a bad token is rejected and does not emit", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  const started = await boot(home, ID);
  try {
    const offer = await submitOffer(started.host.socketPath, {
      sessionId: ID,
      token: "f".repeat(64),
      content: SENTINEL,
    }, 1000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(offer, { accepted: false, code: "auth" });
    assert.equal(channelNotes(started.text()).length, 0);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    await started.host.close();
  }
});

test("a mismatched session id is rejected and a different session is not resumed", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  await writeSession(root, project, OTHER);
  await writeLive(root, OTHER, "idle", 5252);
  const started = await boot(home, ID);
  try {
    const token = (await readFile(listenerToken(started.host.socketPath), "utf8")).trim();
    const offer = await submitOffer(started.host.socketPath, {
      sessionId: OTHER,
      token,
      content: SENTINEL,
    }, 1000);
    assert.deepEqual(offer, { accepted: false, code: "session" });
    const outcome = await sendFollowup(
      configAt(home, root, { allowSend: true }),
      { sessionId: OTHER, message: SENTINEL, confirm: true },
      async () => [],
      liveBoth,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(outcome.disposition, "undelivered");
    assert.equal(channelNotes(started.text()).length, 0);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    await started.host.close();
  }
});

test("a live channel is not resumed beside itself", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  const started = await boot(home, ID);
  const ticketId = "66666666-6666-4666-8666-666666666666";
  await plant(home, ID, ticketId);
  try {
    const config = configAt(home, root, { allowSend: true });
    const outcome = await sendFollowup(config, { sessionId: ID, message: SENTINEL, confirm: true }, async () => []);
    assert.equal(outcome.disposition, "handed");
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
    const held = await queueStatus(config, { sessionId: ID, deliver: true, confirm: true }, async () => []);
    assert.equal(held.delivered.length, 0);
    assert.equal(held.reason, "running");
    assert.equal(held.tickets.find((ticket) => ticket.ticketId === ticketId)?.state, "queued");
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    await started.host.close();
  }
  const config = configAt(home, root, { allowSend: true });
  const sent = await queueStatus(config, { sessionId: ID, deliver: true, confirm: true }, async () => []);
  assert.equal(sent.delivered.length, 1);
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as { argv: string[] };
  assert.equal(record.argv.at(-1), SENTINEL);
});

test("the channel socket and token are private, and symlinks are refused", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  await writeSession(root, project, ID);
  const started = await boot(home, ID);
  try {
    const dirInfo = await lstat(path.dirname(started.host.socketPath));
    assert.equal(dirInfo.isSymbolicLink(), false);
    assert.equal(dirInfo.mode & 0o777, 0o700);
    const parentInfo = await lstat(path.join(home, ".claude-remote"));
    assert.equal(parentInfo.mode & 0o777, 0o700);
    const socketInfo = await lstat(started.host.socketPath);
    assert.equal(socketInfo.isSocket(), true);
    assert.equal(socketInfo.mode & 0o777, 0o600);
    const tokenInfo = await lstat(listenerToken(started.host.socketPath));
    assert.equal(tokenInfo.isFile(), true);
    assert.equal(tokenInfo.mode & 0o777, 0o600);
  } finally {
    await started.host.close();
  }

  const key = path.join(root, "sessions", "9.secret.key");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  const socketPath = listenerSocket(home, ID);
  await symlink(key, socketPath);
  await assert.rejects(() => boot(home, ID), (error: unknown) => error instanceof DeskError);
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
  await unlink(socketPath).catch(() => undefined);

  const tokenPath = listenerToken(socketPath);
  await symlink(key, tokenPath);
  await assert.rejects(() => boot(home, ID), (error: unknown) => error instanceof DeskError);
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
});

test("the channel session id comes from the env var, then the parent pid record", async () => {
  const { home, root } = await tempHome();
  const missing = await resolveChannelSessionId({
    envSessionId: undefined,
    ppid: 4242,
    configRoot: root,
    home,
  });
  assert.equal(missing, null);
  const code = await runChannelMode({
    input: new PassThrough(),
    output: new PassThrough(),
    env: {},
    ppid: 4242,
    home,
  });
  assert.equal(code, 1);

  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "sessions", "4242.json"), JSON.stringify({
    pid: 4242,
    sessionId: OTHER,
    procStart: "100",
  }));
  const fromParent = await resolveChannelSessionId({
    envSessionId: "not-a-uuid",
    ppid: 4242,
    configRoot: root,
    home,
  });
  assert.equal(fromParent, OTHER);
  const fromEnv = await resolveChannelSessionId({
    envSessionId: ID,
    ppid: 4242,
    configRoot: root,
    home,
  });
  assert.equal(fromEnv, ID);

  const key = path.join(root, "sessions", "8.secret.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  await unlink(path.join(root, "sessions", "4242.json")).catch(() => undefined);
  await symlink(key, path.join(root, "sessions", "4242.json"));
  const blocked = await resolveChannelSessionId({
    envSessionId: undefined,
    ppid: 4242,
    configRoot: root,
    home,
  });
  assert.equal(blocked, null);
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
});

class FakeClaudeHost {
  busy = false;
  current = "";
  queued: string[] = [];
  turns: { content: string; when: "now" | "after-current" }[] = [];

  begin(work: string): void {
    this.busy = true;
    this.current = work;
    this.turns.push({ content: work, when: "now" });
  }

  take(content: string): void {
    if (this.busy) {
      this.queued.push(content);
      return;
    }
    this.turns.push({ content, when: "now" });
  }

  finish(): void {
    this.busy = false;
    this.current = "";
    const queued = this.queued.splice(0);
    for (const content of queued) this.turns.push({ content, when: "after-current" });
  }
}

type Started = {
  host: ChannelHost;
  text: () => string;
  init: {
    id: number;
    result: {
      protocolVersion: string;
      capabilities: { experimental: Record<string, unknown> };
      serverInfo: { name: string };
    };
  };
};

async function boot(home: string, sessionId: string): Promise<Started> {
  const id = parseSessionId(sessionId);
  if (!id) throw new Error("session id");
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    text += chunk;
  });
  const host = await startChannelHost({
    sessionId: id,
    io: { input, output, env: {}, ppid: 1, home },
  });
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: {
      protocolVersion: SKIPPED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "fake-claude", version: "0" },
    },
  })}\n`);
  await waitFor(() => text.includes("protocolVersion"));
  const line = text.split("\n").find((item) => item.includes("protocolVersion"));
  if (!line) throw new Error("initialize");
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { host, text: () => text, init: JSON.parse(line) as Started["init"] };
}

function channelNotes(text: string): string[] {
  const notes: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("notifications/claude/channel")) continue;
    const parsed = JSON.parse(line) as { params?: { content?: unknown } };
    if (typeof parsed.params?.content === "string") notes.push(parsed.params.content);
  }
  return notes;
}

async function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  while (!ready()) {
    if (Date.now() - start > 1000) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeSession(root: string, cwd: string, id: string): Promise<void> {
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
}

async function writeLive(root: string, id: string, status: string, pid = 4242): Promise<void> {
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "sessions", `${pid}.json`), JSON.stringify({
    pid,
    sessionId: id,
    procStart: "100",
    status,
  }));
}

async function plant(home: string, sessionId: string, ticketId: string): Promise<void> {
  const dir = queueDirectory(home, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${ticketId}.json`), `${JSON.stringify({
    ticketId,
    sessionId,
    message: SENTINEL,
    state: "queued",
    enqueuedAt: "2020-01-01T00:00:00.000Z",
  })}\n`, { mode: 0o600 });
}

const live4242: ProcessIdentityLookup = async (pid) => pid === 4242
  ? { alive: true, startToken: "100" }
  : { alive: false };

const liveBoth: ProcessIdentityLookup = async (pid) => pid === 4242 || pid === 5252
  ? { alive: true, startToken: "100" }
  : { alive: false };
