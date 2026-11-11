import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { briefGit, briefList, briefPending, briefSend, briefSession, briefStart, type BriefInput } from "../src/brief.js";
import { parseConfig } from "../src/config.js";
import type { SessionCard, TurnFacts } from "../src/domain.js";
import type { PendingView } from "../src/pending.js";
import type { RunRecord } from "../src/runs.js";
import { startServer } from "../scripts/stdio-client.js";
import { tempHome } from "./helpers.js";

const ID = "d1111111-1111-4111-8111-111111111111";

function turn(over: Partial<TurnFacts> = {}): TurnFacts {
  return {
    state: "in-progress",
    explicitEnd: false,
    prompt: "rebase onto main, build, test, and push",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastActivity: "2026-01-01T00:05:00.000Z",
    reply: null,
    replyTruncated: false,
    narration: "Running the tests now.",
    toolCalls: 12,
    toolErrors: 0,
    openTools: ["Bash"],
    steps: [
      { tool: "Bash", input: "git rebase origin/main", outcome: "ok", result: "" },
      { tool: "Edit", input: "src/a.ts", outcome: "error", result: "" },
      { tool: "Bash", input: "npm run build", outcome: "ok", result: "" },
      { tool: "Bash", input: "npm test", outcome: "running", result: "" },
    ],
    ...over,
  };
}

function pendingView(over: Partial<PendingView> = {}): PendingView {
  return {
    requestId: "r1",
    sessionId: ID,
    agentId: null,
    projectName: "proj",
    kind: "permission",
    createdAt: "2026-01-01T00:05:00.000Z",
    expiresAt: null,
    answerable: true,
    answered: false,
    toolName: "Bash",
    notificationType: null,
    title: null,
    text: "git push origin main",
    toolInput: { command: "git push origin main" },
    questions: null,
    ...over,
  };
}

function input(over: Partial<BriefInput>): BriefInput {
  return { phase: { value: "working", reason: "status is working (agents-json)" }, turn: turn(), run: null, git: null, pending: [], ...over };
}

const GIT = { head: "9db560e1a2b3", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, dirtyFiles: 0, pushed: true };

test("a wait that timed out costs a few dozen tokens, not the whole turn again", () => {
  const view = briefSession(input({ git: GIT }), { replyChars: 4000, timedOut: true });
  assert.deepEqual(view, { phase: "working", timedOut: true, toolCalls: 12, now: "Bash: npm test" });
  assert.ok(JSON.stringify(view).length < 120);
});

test("a finished run carries the result text, the denials, and the checkout, and nothing empty", () => {
  const run: RunRecord = {
    sessionId: ID,
    kind: "launch",
    state: "exited",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:06:00.000Z",
    exitCode: 0,
    result: { isError: false, subtype: "success", text: "Rebased, built, tested, pushed 9db560e.", textTruncated: false, numTurns: 9, durationMs: 1, permissionDenials: [{ tool: "Bash", input: "git push --force" }] },
  };
  const view = briefSession(
    input({ phase: { value: "done", reason: "the run this server started has exited" }, turn: turn({ state: "replied", reply: "transcript reply", openTools: [] }), run, git: GIT }),
    { replyChars: 4000 },
  );
  assert.deepEqual(view, {
    phase: "done",
    reply: "Rebased, built, tested, pushed 9db560e.",
    denied: ["Bash: git push --force"],
    toolCalls: 12,
    git: { branch: "main", head: "9db560e", pushed: true },
  });

  // A run older than the newest turn no longer speaks for the session: the transcript reply does.
  const later = briefSession(
    input({ phase: { value: "done", reason: "" }, turn: turn({ state: "replied", reply: "transcript reply", startedAt: "2026-01-01T01:00:00.000Z" }), run }),
    { replyChars: 4000 },
  );
  assert.equal(later.reply, "transcript reply");
  assert.equal(later.denied, undefined);
});

test("a long reply is clipped to the configured length and says so", () => {
  const view = briefSession(input({ phase: { value: "done", reason: "" }, turn: turn({ state: "replied", reply: "x".repeat(900) }) }), { replyChars: 500 });
  assert.equal(view.reply?.length, 500);
  assert.equal(view.replyTruncated, true);
});

test("needs-input lists what to answer and marks what only the machine can answer", () => {
  const question = pendingView({
    requestId: "r2",
    kind: "question",
    toolName: "AskUserQuestion",
    text: "Ship it?",
    questions: [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "y" }, { label: "No", description: null }] }],
  });
  const view = briefSession(
    input({ phase: { value: "needs-input", reason: "a permission is pending; see card.pending" }, pending: [pendingView(), question, pendingView({ requestId: "r0", answered: true })] }),
    { replyChars: 4000 },
  );
  assert.deepEqual(view.pending, [
    { requestId: "r1", kind: "permission", tool: "Bash", text: "git push origin main" },
    { requestId: "r2", kind: "question", questions: [{ question: "Ship it?", options: ["Yes", "No"] }] },
  ]);
  assert.equal(view.reason, undefined, "the pending list is the reason");
  assert.deepEqual(briefPending([pendingView({ answerable: false })]), [{ requestId: "r1", kind: "permission", tool: "Bash", text: "git push origin main", local: true }]);
  assert.deepEqual(briefPending([pendingView({ text: "Bash: git push origin main" })]), [{ requestId: "r1", kind: "permission", text: "Bash: git push origin main" }], "the tool name is not sent twice");

  // Nothing the hooks reported: the reason is the only thing the caller has.
  const bare = briefSession(input({ phase: { value: "needs-input", reason: "waiting for: dialog open" } }), { replyChars: 4000 });
  assert.equal(bare.reason, "waiting for: dialog open");
});

test("a turn that did not end well shows why and its newest steps", () => {
  const view = briefSession(
    input({ phase: { value: "interrupted", reason: "the newest turn has no final reply and the process is not running" }, git: { ...GIT, ahead: 1, dirtyFiles: 3, pushed: false } }),
    { replyChars: 4000 },
  );
  assert.deepEqual(view.lastSteps, ["Edit: src/a.ts (error)", "Bash: npm run build", "Bash: npm test"]);
  assert.match(view.reason ?? "", /no final reply/);
  assert.deepEqual(view.git, { branch: "main", head: "9db560e", ahead: 1, dirty: 3, pushed: false });
  assert.equal(briefGit(null), undefined);
});

test("get_session adds the title, project, and a clipped prompt", () => {
  const view = briefSession(input({ title: "Rebase work", project: "proj", turn: turn({ prompt: "p".repeat(400) }) }), { replyChars: 4000, identity: true });
  assert.equal(view.title, "Rebase work");
  assert.equal(view.project, "proj");
  assert.equal(view.prompt?.length, 163);
});

test("list rows keep the id, title, project, status, branch, and minute of last activity", () => {
  const card = {
    sessionId: ID,
    title: "Rebase work",
    projectName: "proj",
    branch: "main",
    lastActivity: "2026-01-01T00:05:07.123Z",
    status: { value: "needs-you", waitingFor: "permission prompt", source: "agents-json", kind: "interactive" },
    pending: [pendingView(), pendingView({ requestId: "n", kind: "notification" })],
    command: "cd /x && claude --resume",
    warning: "Stop the live process",
  } as unknown as SessionCard;
  assert.deepEqual(briefList([card], 7), {
    sessions: [{ id: ID, status: "needs-you", title: "Rebase work", project: "proj", branch: "main", at: "2026-01-01T00:05Z", pending: 1 }],
    more: 6,
  });
  assert.deepEqual(briefList([], 0), { sessions: [] });
});

test("a send outcome drops the fixed notice and ids, and a launch result drops nulls", () => {
  assert.deepEqual(
    briefSend({ disposition: "sent", result: "done", exitCode: 0, sessionId: ID, displayedInDesktop: false, notice: "long text", worktreeLaunch: "project", ticketId: "t" }, ID.toUpperCase(), 4000),
    { disposition: "sent", result: "done" },
  );
  assert.deepEqual(
    briefSend({ disposition: "started", ticketId: "t", sessionId: ID, displayedInDesktop: false, notice: "long text" }, ID, 4000),
    { disposition: "started", next: "wait_session" },
  );
  const long = briefSend({ disposition: "sent", result: "y".repeat(50), exitCode: 2, sessionId: "e2222222-2222-4222-8222-222222222222", displayedInDesktop: false, notice: "n", worktreeLaunch: "project", ticketId: "t" }, ID, 10);
  assert.deepEqual(long, { disposition: "sent", result: "y".repeat(10), resultTruncated: true, exitCode: 2, sessionId: "e2222222-2222-4222-8222-222222222222" });
  assert.deepEqual(
    briefStart({ sessionId: null, tmuxTarget: "desk-1", kind: "tmux", recordId: "rec", prepared: null, claudePid: 12, fastMode: { requested: false, state: null } }),
    { tmuxTarget: "desk-1", kind: "tmux" },
  );
});

test("the detail, reply length, toolset, and call deadline come from the environment", () => {
  const base = parseConfig({});
  assert.equal(base.detail, "brief");
  assert.equal(base.replyChars, 4000);
  assert.equal(base.toolset, "all");
  const set = parseConfig({ CLAUDE_REMOTE_DETAIL: "full", CLAUDE_REMOTE_REPLY_CHARS: "1500", CLAUDE_REMOTE_TOOLS: "core", CLAUDE_REMOTE_CALL_TIMEOUT_MS: "95000" });
  assert.equal(set.detail, "full");
  assert.equal(set.replyChars, 1500);
  assert.equal(set.toolset, "core");
  assert.equal(set.waitMaxMs, 90_000);
  assert.equal(parseConfig({ CLAUDE_REMOTE_CALL_TIMEOUT_MS: "120000" }).waitMaxMs, 25_000, "past the tunnel limit the default applies");
});

type Tool = { name: string; description: string };

async function withServer<T>(env: Record<string, string>, run: (call: (name: string, args: Record<string, unknown>) => Promise<string>, tools: Tool[]) => Promise<T>): Promise<T> {
  const client = startServer(env);
  try {
    await client.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, 1);
    client.notify("notifications/initialized");
    const listed = await client.request("tools/list", {}, 2);
    const tools = (listed.result as { tools: Tool[] }).tools;
    let id = 3;
    const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
      const reply = await client.request("tools/call", { name, arguments: args }, id++);
      return (reply.result as { content: Array<{ text: string }> }).content[0]!.text;
    };
    return await run(call, tools);
  } finally {
    client.close();
  }
}

test("over MCP the default answers are brief, detail full restores every record, and core trims the tool list", async () => {
  const { home, root } = await tempHome();
  const dir = path.join(root, "projects", "-tmp-fixture-brief");
  await mkdir(dir, { recursive: true });
  const at = (second: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const lines = [
    { type: "user", sessionId: ID, timestamp: at(1), cwd: "/tmp/fixture/brief", message: { role: "user", content: "say hello" } },
    { type: "assistant", sessionId: ID, timestamp: at(2), message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hello" } }] } },
    { type: "user", sessionId: ID, timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "hello" }] }] } },
    { type: "assistant", sessionId: ID, timestamp: at(4), message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Said hello." }] } },
  ];
  await writeFile(path.join(dir, `${ID}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: root,
    CLAUDE_REMOTE_AGENTS_JSON: "0",
    CLAUDE_REMOTE_ALLOW_SEND: "1",
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    CLAUDE_REMOTE_ALLOW_APPROVE: "1",
  };

  const all = await withServer(env, async (call, tools) => {
    const brief = await call("get_session", { sessionId: ID });
    assert.deepEqual(JSON.parse(brief), { phase: "done", project: "brief", prompt: "say hello", reply: "Said hello.", toolCalls: 1 });
    const full = await call("get_session", { sessionId: ID, detail: "full" });
    const parsed = JSON.parse(full) as { card: { sessionId: string }; turns: unknown[]; turn: { reply: string } };
    assert.equal(parsed.card.sessionId, ID);
    assert.equal(parsed.turn.reply, "Said hello.");
    assert.ok(full.length > brief.length * 5, "the full record is several times the brief one");

    assert.deepEqual(JSON.parse(await call("wait_session", { sessionId: ID, timeoutMs: 0 })), { phase: "done", reply: "Said hello.", toolCalls: 1 });
    const rows = JSON.parse(await call("list_sessions", {})) as { sessions: Array<Record<string, unknown>> };
    assert.deepEqual(rows.sessions, [{ id: ID, status: "not-running", title: "say hello", project: "brief", at: "2026-01-01T00:00Z" }]);
    assert.deepEqual(JSON.parse(await call("list_pending", {})), { pending: [] });
    return tools;
  });
  assert.equal(all.length, 14);
  const size = (tools: Tool[]): number => tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0);
  assert.ok(size(all) < 9500, `the tool list is ${size(all)} characters`);
  assert.ok(all.every((tool) => tool.description.length <= 700), "no description is longer than 700 characters");

  const core = await withServer({ ...env, CLAUDE_REMOTE_TOOLS: "core" }, async (_call, tools) => tools);
  assert.deepEqual(core.map((tool) => tool.name), ["list_sessions", "get_session", "wait_session", "send_followup", "new_session", "stop_session", "list_pending", "answer_permission", "answer_question"]);
  assert.ok(size(core) < 7300, `the core tool list is ${size(core)} characters`);

  const fullMode = await withServer({ ...env, CLAUDE_REMOTE_DETAIL: "full" }, async (call) => JSON.parse(await call("list_sessions", {})) as { scannedFileCount: number });
  assert.equal(fullMode.scannedFileCount, 1);
});
