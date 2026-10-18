import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { DeskError } from "../src/domain.js";
import { keepEntry, MAX_AGE_MS, pendingFilePath, readPending, savePending, startPendingPersistence } from "../src/pending-file.js";
import { answerPermission, PendingStore, type PendingChange, type SavedEntry } from "../src/pending.js";
import { mintToken, writeToken } from "../src/token.js";
import { repoRoot, tempHome } from "./helpers.js";

const SESSION = "90909090-9090-4909-8909-909090909090";
const OTHER = "91919191-9191-4919-8919-919191919191";
const APPROVE = { allowApprove: true, waitMs: 120_000 };
const QUIET = { allowApprove: false, waitMs: 0 };
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");

function permission(session = SESSION, command = "make deploy"): Record<string, unknown> {
  return { session_id: session, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command } };
}

function quietLogs(): () => void {
  const original = console.error;
  console.error = () => undefined;
  return () => {
    console.error = original;
  };
}

test("the saved file is private, written atomically, and refuses a symlink", async () => {
  const { home } = await tempHome();
  await writeToken(home, mintToken());
  const file = pendingFilePath(home);
  const store = new PendingStore();
  store.record(permission(), QUIET);
  await savePending(file, store.snapshot());
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.includes(".tmp")), []);
  const loaded = await readPending(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.view.text, "Bash: make deploy");
  await writeFile(file, "{not json");
  const restore = quietLogs();
  assert.deepEqual(await readPending(file), []);
  const elsewhere = path.join(home, "elsewhere.json");
  await writeFile(elsewhere, "{}");
  const linked = path.join(home, "linked.json");
  await symlink(elsewhere, linked);
  await savePending(linked, store.snapshot());
  restore();
  assert.equal(await readFile(elsewhere, "utf8"), "{}");
});

test("on load, stale prompts, very old entries and entries of sessions that are no longer live are dropped", () => {
  const now = 10 * MAX_AGE_MS;
  const store = new PendingStore(() => now - 1000);
  store.record(permission(), QUIET);
  store.record({ session_id: SESSION, hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }, QUIET);
  const [prompt, note] = store.snapshot() as [SavedEntry, SavedEntry];
  const at = (item: SavedEntry, ageMs: number): SavedEntry => ({ ...item, createdMs: now - ageMs });
  assert.equal(keepEntry(at(prompt, 60_000), now, 120_000, null), true);
  assert.equal(keepEntry(at(prompt, 121_000), now, 120_000, null), false, "older than the approve timeout");
  assert.equal(keepEntry(at(note, 30 * 60_000), now, 120_000, null), true);
  assert.equal(keepEntry(at(note, MAX_AGE_MS + 1), now, 120_000, null), false, "older than the maximum");
  assert.equal(keepEntry(at(note, 1000), now, 120_000, new Set([OTHER])), false, "session not live");
  assert.equal(keepEntry(at(note, 1000), now, 120_000, new Set([SESSION])), true);
  assert.equal(keepEntry(at(note, -5000), now, 120_000, null), false, "from the future");
});

test("a restored permission request is listed but can never be answered, and still clears normally", async () => {
  const { home, root } = await tempHome();
  const config = parseConfig({ CLAUDE_CONFIG_DIR: root, CLAUDE_REMOTE_ALLOW_APPROVE: "1" }, { home, platform: "linux" });
  const before = new PendingStore();
  const waiting = before.record(permission(), APPROVE);
  assert.equal(before.list()[0]!.answerable, true);
  const restored = new PendingStore();
  const seen: PendingChange[] = [];
  restored.subscribe((change) => seen.push(change));
  assert.equal(restored.restore(before.snapshot()), 1);
  assert.deepEqual(seen, [], "restoring does not raise added events");
  const [view] = restored.list();
  assert.equal(view!.requestId, waiting.requestId);
  assert.equal(view!.answerable, false);
  assert.equal(view!.expiresAt, null);
  assert.deepEqual(await restored.wait(waiting.requestId ?? "", 100), { state: "gone" });
  const restore = quietLogs();
  await assert.rejects(
    () => answerPermission(config, { sessionId: SESSION, requestId: waiting.requestId ?? "", decision: "allow", confirm: true }, restored),
    (error: unknown) => error instanceof DeskError && error.code === "not-answerable",
  );
  restore();
  restored.record({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "make deploy" } }, QUIET);
  assert.equal(restored.size(), 0, "the saved match key still clears it");
});

test("persistence loads what is left, saves after each change, and flushes on stop", async () => {
  const { home } = await tempHome();
  await writeToken(home, mintToken());
  const file = pendingFilePath(home);
  let now = 1_000_000;
  const first = new PendingStore(() => now);
  const one = await startPendingPersistence(first, { file, approveTimeoutMs: 120_000, liveness: async () => new Set([SESSION]), clock: () => now, delayMs: 10 });
  assert.equal(one.restored, 0);
  first.record(permission(), APPROVE);
  first.record(permission(OTHER, "ls"), APPROVE);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await readPending(file)).length, 2);
  first.record({ session_id: SESSION, hook_event_name: "Notification", notification_type: "idle_prompt", message: "idle" }, QUIET);
  await one.stop();
  assert.equal((await readPending(file)).length, 3);
  now += 30_000;
  const restore = quietLogs();
  const second = new PendingStore(() => now);
  const two = await startPendingPersistence(second, { file, approveTimeoutMs: 120_000, liveness: async () => new Set([SESSION]), clock: () => now, delayMs: 10 });
  restore();
  assert.equal(two.restored, 2);
  assert.equal(two.dropped, 1, "the other session is not live");
  assert.ok(second.list().every((entry) => entry.sessionId === SESSION && !entry.answerable));
  assert.equal((await readPending(file)).length, 2, "the pruned set is saved straight away");
  second.record({ session_id: SESSION, hook_event_name: "Stop" }, QUIET);
  await two.stop();
  assert.deepEqual(await readPending(file), []);
});

test("a helper restart keeps pending entries, and none of them is answerable", async () => {
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  await mkdir(root, { recursive: true });
  const port = await freePort();
  const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: root, CLAUDE_REMOTE_ALLOW_APPROVE: "1", CLAUDE_REMOTE_HTTP_PORT: String(port) };
  let helper = await startHelper(env);
  try {
    const reply = JSON.parse((await post(port, token, "/hook/event", permission(SESSION, "terraform apply"))).body) as { requestId: string; wait: boolean };
    assert.equal(reply.wait, true);
    await post(port, token, "/hook/event", { session_id: SESSION, hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" });
    const live = await listPending(port, token);
    assert.equal(live.find((entry) => entry.requestId === reply.requestId)?.answerable, true, "answerable before the restart");
    await stopHelper(helper);
    assert.equal((await stat(pendingFilePath(home))).mode & 0o777, 0o600);
    helper = await startHelper(env);
    const after = await listPending(port, token);
    assert.deepEqual(after.map((entry) => entry.kind).sort(), ["notification", "permission"]);
    assert.ok(after.every((entry) => entry.answerable === false));
    const answer = await mcpCall(port, token, "answer_permission", { sessionId: SESSION, requestId: reply.requestId, decision: "allow", confirm: true });
    assert.equal(answer.isError, true);
    assert.match(answer.text, /no hook is waiting/);
  } finally {
    await stopHelper(helper);
  }
});

function startHelper(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, [path.join(repoRoot, "src", "index.ts"), "http"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timer = setTimeout(() => reject(new Error("helper did not start")), 20_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("listening=")) {
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr!.on("data", () => undefined);
    child.on("exit", () => reject(new Error("helper exited")));
  });
}

function stopHelper(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function listPending(port: number, token: string): Promise<Array<{ requestId: string; kind: string; answerable: boolean }>> {
  const result = await mcpCall(port, token, "list_pending", { sessionId: SESSION });
  return (JSON.parse(result.text) as { pending: Array<{ requestId: string; kind: string; answerable: boolean }> }).pending;
}

async function mcpCall(port: number, token: string, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  await post(port, token, "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "persist-test", version: "0.1.0" } } });
  const called = await post(port, token, "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } });
  const message = JSON.parse(called.body) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };
  return { isError: message.result?.isError === true, text: message.result?.content?.[0]?.text ?? "" };
}

function post(port: number, token: string, pathname: string, body: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: "POST",
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
