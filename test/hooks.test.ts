import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/server";
import { parseConfig, type Config } from "../src/config.js";
import { decisionOutput, REGISTER_TIMEOUT_MS, runHook } from "../src/hook.js";
import { listenHttp, type HttpListener } from "../src/http.js";
import { answerPermission, answerQuestion, PendingStore, pendingStore, registerPendingTools } from "../src/pending.js";
import { mintToken, writeToken } from "../src/token.js";
import { repoRoot, tempHome } from "./helpers.js";

const SESSION = "12121212-1212-4121-8121-121212121212";

function permissionEvent(session: string, command = "ls -la"): Record<string, unknown> {
  return {
    session_id: session,
    hook_event_name: "PermissionRequest",
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command, description: "List files" },
    permission_suggestions: [{ type: "setMode", mode: "bypassPermissions", destination: "session" }],
  };
}

function questionEvent(session: string): Record<string, unknown> {
  return {
    session_id: session,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_q1",
    tool_input: {
      questions: [{
        question: "Which colour?",
        header: "Colour",
        multiSelect: false,
        options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }],
      }],
    },
  };
}

function approveConfig(home: string, root: string, approve: boolean, waitMs = 3000): Config {
  const config = parseConfig({ CLAUDE_CONFIG_DIR: root, CLAUDE_REMOTE_ALLOW_APPROVE: approve ? "1" : "0" }, { home, platform: "linux" });
  return { ...config, approveTimeoutMs: waitMs };
}

async function helper(approve: boolean, waitMs = 3000): Promise<{ home: string; config: Config; listener: HttpListener; token: string }> {
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const config = approveConfig(home, root, approve, waitMs);
  const listener = await listenHttp(config, 0);
  await writeFile(path.join(home, ".claude-remote", "http", "port"), `${listener.port}\n`);
  return { home, config, listener, token };
}

async function until<T>(read: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting");
}

function rawPost(port: number, pathname: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({ host: "127.0.0.1", port, path: pathname, method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "application/json", ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk: Buffer) => { text += chunk.toString("utf8"); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

test("the store records permissions, questions and notifications, and clears them when the session moves on", () => {
  const store = new PendingStore();
  const off = store.record(permissionEvent(SESSION), { allowApprove: false, waitMs: 1000 });
  assert.equal(off.wait, false);
  const [permission] = store.list({ sessionId: SESSION });
  assert.equal(permission?.kind, "permission");
  assert.equal(permission?.text, "Bash: ls -la");
  assert.equal(permission?.toolInput?.description, "List files");
  assert.equal(permission?.answerable, false);
  store.record({ session_id: SESSION, hook_event_name: "Notification", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" }, { allowApprove: false, waitMs: 0 });
  store.record(questionEvent(SESSION), { allowApprove: false, waitMs: 0 });
  assert.equal(store.list({ sessionId: SESSION }).length, 3);
  // A different tool finishing does not clear this permission; the same call does.
  store.record({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "pwd" } }, { allowApprove: false, waitMs: 0 });
  assert.deepEqual(store.list({ sessionId: SESSION }).map((entry) => entry.kind).sort(), ["permission", "question"]);
  store.record({ session_id: SESSION, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls -la", description: "List files" } }, { allowApprove: false, waitMs: 0 });
  assert.deepEqual(store.list({ sessionId: SESSION }).map((entry) => entry.kind), ["question"]);
  store.record({ session_id: SESSION, hook_event_name: "Stop" }, { allowApprove: false, waitMs: 0 });
  assert.equal(store.list({ sessionId: SESSION }).length, 0);
  store.record(permissionEvent(SESSION), { allowApprove: false, waitMs: 0 });
  store.reconcile(SESSION, "not-running");
  assert.equal(store.size(), 0);
  assert.equal(store.record({ hook_event_name: "Stop" }, { allowApprove: true, waitMs: 1 }).wait, false);
  assert.equal(store.record({ session_id: "../bad", hook_event_name: "PermissionRequest", tool_name: "Bash" }, { allowApprove: true, waitMs: 1 }).wait, false);
});

test("a decision reaches the waiter once, and a request past its deadline is gone", async () => {
  let now = 1_000_000;
  const store = new PendingStore(() => now);
  const recorded = store.record(permissionEvent(SESSION), { allowApprove: true, waitMs: 60_000 });
  assert.equal(recorded.wait, true);
  assert.equal(recorded.waitMs, 60_000);
  const requestId = recorded.requestId ?? "";
  const waiting = store.wait(requestId, 10_000);
  const disposition = await store.decide(SESSION, requestId, { kind: "permission", answer: { behavior: "allow" } });
  assert.equal(disposition, "delivered");
  assert.deepEqual(await waiting, { state: "decided", decision: { kind: "permission", answer: { behavior: "allow" } } });
  await assert.rejects(() => store.decide(SESSION, requestId, { kind: "permission", answer: { behavior: "deny" } }), /already has an answer/);
  const late = store.record(permissionEvent(SESSION, "pwd"), { allowApprove: true, waitMs: 60_000 });
  now += 61_000;
  assert.deepEqual(await store.wait(late.requestId ?? "", 1000), { state: "gone" });
  await assert.rejects(() => store.decide(SESSION, late.requestId ?? "", { kind: "permission", answer: { behavior: "allow" } }), /no hook is waiting/);
  await assert.rejects(() => store.decide("34343434-3434-4343-8343-343434343434", late.requestId ?? "", { kind: "permission", answer: { behavior: "allow" } }), /no pending request/);
});

test("answer tools need ALLOW_APPROVE and confirm, and are not registered without the flag", async () => {
  const { home, root } = await tempHome();
  const store = new PendingStore();
  const recorded = store.record(permissionEvent(SESSION), { allowApprove: true, waitMs: 60_000 });
  const requestId = recorded.requestId ?? "";
  await assert.rejects(() => answerPermission(approveConfig(home, root, false), { sessionId: SESSION, requestId, decision: "allow", confirm: true }, store), /remote answers are off/);
  await assert.rejects(() => answerPermission(approveConfig(home, root, true), { sessionId: SESSION, requestId, decision: "allow", confirm: false }, store), /confirm must be true/);
  const names = (config: Config): string[] => {
    const server = new McpServer({ name: "t", version: "0" });
    const seen: string[] = [];
    const original = server.registerTool.bind(server);
    (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (name: unknown, ...rest: unknown[]) => {
      seen.push(String(name));
      return (original as (...args: unknown[]) => unknown)(name, ...rest);
    };
    registerPendingTools(server, config, store);
    return seen;
  };
  assert.deepEqual(names(approveConfig(home, root, false)), ["list_pending"]);
  assert.deepEqual(names(approveConfig(home, root, true)), ["list_pending", "answer_permission", "answer_question"]);
  const question = store.record(questionEvent(SESSION), { allowApprove: true, waitMs: 60_000 });
  const on = approveConfig(home, root, true);
  await assert.rejects(() => answerQuestion(on, { sessionId: SESSION, requestId: question.requestId ?? "", answers: { "Other?": "x" }, confirm: true }, store), /does not have/);
  await assert.rejects(() => answerQuestion(on, { sessionId: SESSION, requestId: question.requestId ?? "", answers: {}, confirm: true }, store), /answer every question/);
  await assert.rejects(() => answerQuestion(on, { sessionId: SESSION, requestId: requestId, answers: {}, confirm: true }, store), /not a question/);
});

test("hook output is a single allow or deny, never rules or a mode, and question answers merge into the input", () => {
  const allow = JSON.parse(decisionOutput(permissionEvent(SESSION), { kind: "permission", answer: { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "bypassPermissions" }] } }));
  assert.deepEqual(allow, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  const deny = JSON.parse(decisionOutput(permissionEvent(SESSION), { kind: "permission", answer: { behavior: "deny", message: "not now", interrupt: true } }));
  assert.deepEqual(deny, { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "not now" } } });
  assert.equal(decisionOutput(permissionEvent(SESSION), { kind: "permission", answer: { behavior: "ask" } }), "");
  assert.equal(decisionOutput(permissionEvent(SESSION), { kind: "question", answer: { answers: {} } }), "");
  const answered = JSON.parse(decisionOutput(questionEvent(SESSION), { kind: "question", answer: { answers: { "Which colour?": "Blue" } } }));
  assert.equal(answered.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(answered.hookSpecificOutput.updatedInput.answers, { "Which colour?": "Blue" });
  assert.equal(answered.hookSpecificOutput.updatedInput.questions.length, 1);
  assert.equal(decisionOutput(questionEvent(SESSION), { kind: "question", answer: { answers: { "Something else?": "Blue" } } }), "");
});

test("the hook fails open fast when the helper is down, silent, or the token is missing", async () => {
  const { home } = await tempHome();
  const event = JSON.stringify(permissionEvent(SESSION));
  let started = Date.now();
  assert.equal(await runHook({ stdinText: event, home, env: {} }), "");
  assert.ok(Date.now() - started < 500);
  await writeToken(home, mintToken());
  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", () => resolve()));
  const freePort = (closed.address() as AddressInfo).port;
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  started = Date.now();
  assert.equal(await runHook({ stdinText: event, home, env: { CLAUDE_REMOTE_HTTP_PORT: String(freePort) } }), "");
  assert.ok(Date.now() - started < 1000);
  const silent: Server = createServer(() => undefined);
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
  try {
    started = Date.now();
    assert.equal(await runHook({ stdinText: event, home, env: { CLAUDE_REMOTE_HTTP_PORT: String((silent.address() as AddressInfo).port) } }), "");
    const took = Date.now() - started;
    assert.ok(took >= REGISTER_TIMEOUT_MS - 50 && took < REGISTER_TIMEOUT_MS + 700, `took ${took}`);
  } finally {
    silent.closeAllConnections();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
  assert.equal(await runHook({ stdinText: "not json", home, env: {} }), "");
  assert.equal(await runHook({ stdinText: JSON.stringify({ hook_event_name: "Elicitation", session_id: SESSION }), home, env: {} }), "");
});

test("claude-remote hook exits 0 with no output within two seconds when the helper is down", async () => {
  const { home } = await tempHome();
  await writeToken(home, mintToken());
  await mkdir(path.join(home, ".claude-remote", "http"), { recursive: true });
  await writeFile(path.join(home, ".claude-remote", "http", "port"), "1\n");
  const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
  const started = Date.now();
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(tsx, [path.join(repoRoot, "src", "index.ts"), "hook"], { env: { ...process.env, HOME: home, CLAUDE_REMOTE_HTTP_PORT: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(permissionEvent(SESSION, "echo SECRET-CMD")));
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("SECRET-CMD"), false);
  assert.ok(Date.now() - started < 4000, "tsx start-up plus the hook budget");
});

test("hook endpoints need the token and refuse tunnel traffic", async () => {
  const { listener, token } = await helper(true);
  try {
    const event = permissionEvent("56565656-5656-4565-8565-565656565656");
    assert.equal((await rawPost(listener.port, "/hook/event", event, {})).status, 401);
    assert.equal((await rawPost(listener.port, "/hook/event", event, { authorization: `Bearer ${token}`, "cf-connecting-ip": "203.0.113.9" })).status, 403);
    const ok = await rawPost(listener.port, "/hook/event", { session_id: "56565656-5656-4565-8565-565656565656", hook_event_name: "Stop" }, { authorization: `Bearer ${token}` });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body), { requestId: null, wait: false, waitMs: 0 });
  } finally {
    await listener.close();
  }
});

test("a remote allow, a remote deny, and no answer all behave as documented through the real listener", async () => {
  const { home, config, listener } = await helper(true, 1500);
  const session = "78787878-7878-4787-8787-787878787878";
  try {
    const allowRun = runHook({ stdinText: JSON.stringify(permissionEvent(session, "echo one")), home, env: {} });
    const allowEntry = await until(() => pendingStore.list({ sessionId: session }).find((entry) => entry.kind === "permission" && entry.answerable));
    const allowed = await answerPermission(config, { sessionId: session, requestId: allowEntry.requestId, decision: "allow", confirm: true });
    assert.equal(allowed.disposition, "delivered");
    assert.deepEqual(JSON.parse(await allowRun).hookSpecificOutput.decision, { behavior: "allow" });

    pendingStore.record({ session_id: session, hook_event_name: "Stop" }, { allowApprove: false, waitMs: 0 });
    const denyRun = runHook({ stdinText: JSON.stringify(permissionEvent(session, "echo two")), home, env: {} });
    const denyEntry = await until(() => pendingStore.list({ sessionId: session }).find((entry) => entry.kind === "permission" && entry.answerable));
    await answerPermission(config, { sessionId: session, requestId: denyEntry.requestId, decision: "deny", message: "use a dry run", confirm: true });
    assert.deepEqual(JSON.parse(await denyRun).hookSpecificOutput.decision, { behavior: "deny", message: "use a dry run" });

    const questionRun = runHook({ stdinText: JSON.stringify(questionEvent(session)), home, env: {} });
    const questionEntry = await until(() => pendingStore.list({ sessionId: session }).find((entry) => entry.kind === "question" && entry.answerable));
    assert.equal(questionEntry.questions?.[0]?.options.length, 2);
    await answerQuestion(config, { sessionId: session, requestId: questionEntry.requestId, answers: { "Which colour?": "Red" }, confirm: true });
    assert.deepEqual(JSON.parse(await questionRun).hookSpecificOutput.updatedInput.answers, { "Which colour?": "Red" });

    pendingStore.record({ session_id: session, hook_event_name: "Stop" }, { allowApprove: false, waitMs: 0 });
    const started = Date.now();
    assert.equal(await runHook({ stdinText: JSON.stringify(permissionEvent(session, "echo three")), home, env: {} }), "");
    const took = Date.now() - started;
    assert.ok(took >= 1400 && took < 3000, `took ${took}`);
    const left = pendingStore.list({ sessionId: session });
    assert.equal(left.length, 1);
    assert.equal(left[0]?.answerable, false);

    // A local answer (the tool ran) releases a waiting hook with no decision.
    pendingStore.record({ session_id: session, hook_event_name: "Stop" }, { allowApprove: false, waitMs: 0 });
    const localRun = runHook({ stdinText: JSON.stringify(permissionEvent(session, "echo four")), home, env: {} });
    await until(() => pendingStore.list({ sessionId: session }).find((entry) => entry.answerable));
    pendingStore.record({ session_id: session, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo four", description: "List files" } }, { allowApprove: false, waitMs: 0 });
    assert.equal(await localRun, "");
  } finally {
    pendingStore.record({ session_id: session, hook_event_name: "SessionEnd" }, { allowApprove: false, waitMs: 0 });
    await listener.close();
  }
});

test("with approve off the hook only reports and returns at once", async () => {
  const { home, listener } = await helper(false);
  const session = "9a9a9a9a-9a9a-49a9-89a9-9a9a9a9a9a9a";
  try {
    const started = Date.now();
    assert.equal(await runHook({ stdinText: JSON.stringify(permissionEvent(session)), home, env: {} }), "");
    assert.ok(Date.now() - started < 1000);
    const [entry] = pendingStore.list({ sessionId: session });
    assert.equal(entry?.answerable, false);
    assert.equal(entry?.expiresAt, null);
  } finally {
    pendingStore.record({ session_id: session, hook_event_name: "SessionEnd" }, { allowApprove: false, waitMs: 0 });
    await listener.close();
  }
});

test("list_sessions and get_session cards carry the session's pending entries", async () => {
  const { fixtureConfig } = await import("./helpers.js");
  const { getSession, listSessions } = await import("../src/tools.js");
  const id = "11111111-1111-4111-8111-111111111111";
  const config = fixtureConfig();
  pendingStore.record({ session_id: id, hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "idle_prompt" }, { allowApprove: false, waitMs: 0 });
  try {
    const entry = { sessionId: id as never, pid: 41001, kind: "interactive" as const, status: "waiting" as const, state: null, waitingFor: "input needed" as const, shortId: null };
    const noAgents = async () => ({ available: true as const, entries: [entry], bySession: new Map([[id, entry]]) });
    const listed = await listSessions(config, {}, async () => [], undefined, noAgents);
    const card = listed.sessions.find((entry) => entry.sessionId === id);
    assert.equal(card?.pending?.[0]?.text, "Claude is waiting for your input");
    assert.equal(card?.pending?.[0]?.notificationType, "idle_prompt");
    const other = listed.sessions.find((entry) => entry.sessionId !== id);
    assert.deepEqual(other?.pending, []);
    // The same entry is dropped once the session is no longer running.
    const gone = async () => ({ available: true as const, entries: [], bySession: new Map() });
    const after = await listSessions(config, {}, async () => [], undefined, gone);
    assert.deepEqual(after.sessions.find((row) => row.sessionId === id)?.pending, []);
    pendingStore.record({ session_id: id, hook_event_name: "Notification", message: "Claude is waiting for your input", notification_type: "idle_prompt" }, { allowApprove: false, waitMs: 0 });
    const detail = await getSession(config, { sessionId: id }, async () => [], undefined, noAgents);
    assert.equal(detail.card.pending?.length, 1);
  } finally {
    pendingStore.record({ session_id: id, hook_event_name: "SessionEnd" }, { allowApprove: false, waitMs: 0 });
  }
});
