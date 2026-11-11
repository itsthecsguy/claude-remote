import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { AgentsSnapshot } from "../src/agents.js";
import type { RunState, SessionStatus, TurnFacts } from "../src/domain.js";
import { phaseOf } from "../src/summary.js";
import { getSession } from "../src/tools.js";
import { configAt, tempHome } from "./helpers.js";

const NO_AGENTS = async (): Promise<AgentsSnapshot> => ({ available: false, reason: "disabled" });

let clock = 0;
function stamp(): string {
  clock += 1000;
  return new Date(Date.UTC(2026, 0, 1) + clock).toISOString();
}

function prompt(id: string, text: string): string {
  return JSON.stringify({ type: "user", sessionId: id, timestamp: stamp(), cwd: "/tmp/fixture/turn", message: { role: "user", content: text } });
}

function call(id: string, toolId: string, name: string, input: Record<string, unknown>, text?: string): string {
  const content: unknown[] = [];
  if (text) content.push({ type: "text", text });
  content.push({ type: "tool_use", id: toolId, name, input });
  return JSON.stringify({ type: "assistant", sessionId: id, timestamp: stamp(), message: { role: "assistant", stop_reason: "tool_use", content } });
}

function result(id: string, toolId: string, text: string, isError = false): string {
  return JSON.stringify({
    type: "user",
    sessionId: id,
    timestamp: stamp(),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolId, is_error: isError, content: [{ type: "text", text }] }] },
  });
}

function reply(id: string, text: string, stopReason: string | null = "end_turn"): string {
  return JSON.stringify({ type: "assistant", sessionId: id, timestamp: stamp(), message: { role: "assistant", stop_reason: stopReason, content: [{ type: "text", text }] } });
}

/** A bookkeeping record of the kind current transcripts carry between messages. */
function bulk(bytes: number): string {
  return JSON.stringify({ type: "api-request-blob", data: "x".repeat(bytes) });
}

async function sessionFile(lines: string[], id: string): Promise<{ home: string; root: string }> {
  const { home, root } = await tempHome();
  const dir = path.join(root, "projects", "-tmp-fixture-turn");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  return { home, root };
}

test("get_session reports a tool-heavy turn in progress even when the tail window holds no text", async () => {
  const id = "c1111111-1111-4111-8111-111111111111";
  const lines = [
    prompt(id, "rebase onto main, build, test, and push"),
    call(id, "t1", "Bash", { command: "git rebase origin/main" }, "Rebasing first."),
    result(id, "t1", "Successfully rebased and updated refs/heads/feature."),
    bulk(40_000),
    call(id, "t2", "Bash", { command: "npm test" }),
    result(id, "t2", "3 failing", true),
    bulk(40_000),
    call(id, "t3", "Edit", { file_path: "/tmp/fixture/turn/src/a.ts", old_string: "a", new_string: "b" }),
    result(id, "t3", "updated"),
    bulk(80_000),
    call(id, "t4", "Bash", { command: "npm test" }),
  ];
  const { home, root } = await sessionFile(lines, id);
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [], undefined, NO_AGENTS);

  assert.equal(detail.turns.length, 5, "every message record with text or a tool call, not just the last 64 KB");
  assert.equal(detail.summary.did, "Rebasing first. Tools: Bash, Edit.");
  const turn = detail.turn;
  assert.ok(turn);
  assert.equal(turn.state, "in-progress");
  assert.equal(turn.prompt, "rebase onto main, build, test, and push");
  assert.equal(turn.reply, null);
  assert.equal(turn.narration, "Rebasing first.");
  assert.equal(turn.toolCalls, 4);
  assert.equal(turn.toolErrors, 1);
  assert.deepEqual(turn.openTools, ["Bash"]);
  assert.deepEqual(turn.steps.map((step) => [step.tool, step.input, step.outcome]), [
    ["Bash", "git rebase origin/main", "ok"],
    ["Bash", "npm test", "error"],
    ["Edit", "/tmp/fixture/turn/src/a.ts", "ok"],
    ["Bash", "npm test", "running"],
  ]);
  assert.equal(turn.steps[1]?.result, "", "tool-result text stays on the machine unless CLAUDE_REMOTE_STEP_RESULTS=1");
  const open = await getSession({ ...configAt(home, root), stepResults: true }, { sessionId: id }, async () => [], undefined, NO_AGENTS);
  assert.equal(open.turn?.steps[1]?.result, "3 failing");
  // No process owns this transcript, so an unfinished turn was interrupted, not still working.
  assert.equal(detail.phase.value, "interrupted");
});

test("a filler reply to a later notification does not hide the result of the work", async () => {
  const id = "c2222222-2222-4222-8222-222222222222";
  const lines = [
    prompt(id, "push the branch"),
    call(id, "t1", "Bash", { command: "git push" }),
    result(id, "t1", "To github.com:example/repo.git"),
    reply(id, "Pushed feature at abc1234."),
    prompt(id, "<task-notification>background task finished</task-notification>"),
    reply(id, "No response requested."),
  ];
  const { home, root } = await sessionFile(lines, id);
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [], undefined, NO_AGENTS);

  assert.equal(detail.lastReply, "Pushed feature at abc1234.");
  assert.equal(detail.turn?.prompt, "push the branch");
  assert.equal(detail.turn?.reply, "Pushed feature at abc1234.");
  assert.equal(detail.turn?.state, "replied");
  assert.equal(detail.phase.value, "done");
  assert.equal(detail.summary.did.startsWith("Pushed feature at abc1234."), true);
});

test("a new prompt resets the turn, so the earlier reply is not reported as this turn's answer", async () => {
  const id = "c3333333-3333-4333-8333-333333333333";
  const lines = [
    prompt(id, "first task"),
    reply(id, "First task is finished."),
    prompt(id, "second task"),
    call(id, "t1", "Read", { file_path: "/tmp/fixture/turn/b.ts" }),
  ];
  const { home, root } = await sessionFile(lines, id);
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [], undefined, NO_AGENTS);

  assert.equal(detail.lastReply, "First task is finished.", "lastReply keeps its meaning: the newest assistant text in the file");
  assert.equal(detail.turn?.prompt, "second task");
  assert.equal(detail.turn?.reply, null);
  assert.equal(detail.turn?.state, "in-progress");
});

test("phase puts a waiting prompt first, then the process, then the transcript", () => {
  const status = (value: SessionStatus["value"], waitingFor: SessionStatus["waitingFor"] = null): SessionStatus => ({ value, waitingFor, source: "agents-json", kind: "interactive" });
  const running: RunState = { kind: "running", evidence: "sessions-file" };
  const finished: RunState = { kind: "finished" };
  const base: TurnFacts = {
    state: "in-progress", explicitEnd: false, prompt: "p", startedAt: null, lastActivity: null, reply: null, replyTruncated: false,
    narration: null, toolCalls: 1, toolErrors: 0, openTools: ["Bash"], steps: [],
  };
  const replied: TurnFacts = { ...base, state: "replied", explicitEnd: true, reply: "ok", openTools: [] };

  assert.equal(phaseOf({ status: status("working"), run: running, turn: base, pending: [{ kind: "permission" }] }).value, "needs-input");
  assert.equal(phaseOf({ status: status("needs-you", "permission prompt"), run: running, turn: base, pending: [] }).value, "needs-input");
  assert.equal(phaseOf({ status: status("working"), run: running, turn: base, pending: [{ kind: "notification" }] }).value, "working");
  // A reply already written while the process is still busy (a stop hook, a queued message) is not done yet.
  assert.equal(phaseOf({ status: status("working"), run: running, turn: replied, pending: [] }).value, "working");
  assert.equal(phaseOf({ status: status("idle"), run: running, turn: replied, pending: [] }).value, "done");
  assert.equal(phaseOf({ status: status("not-running"), run: finished, turn: replied, pending: [] }).value, "done");
  assert.equal(phaseOf({ status: status("idle"), run: running, turn: base, pending: [] }).value, "interrupted");
  assert.equal(phaseOf({ status: status("failed"), run: finished, turn: base, pending: [] }).value, "failed");
  assert.equal(phaseOf({ status: status("idle"), run: running, turn: null, pending: [] }).value, "idle");
  // No agents output and a live process: the transcript alone cannot say more than working.
  const fallback: SessionStatus = { value: "unknown", waitingFor: null, source: "fallback", kind: null };
  assert.equal(phaseOf({ status: fallback, run: running, turn: base, pending: [] }).value, "working");
  assert.equal(phaseOf({ status: fallback, run: running, turn: replied, pending: [] }).value, "done");
  assert.equal(phaseOf({ status: fallback, run: { kind: "unknown", reason: "sessions-dir-unreadable" }, turn: base, pending: [] }).value, "unknown");
});
