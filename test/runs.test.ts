import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { RunState, SessionDetail, SessionStatus, TurnFacts } from "../src/domain.js";
import { gitFacts, parseGitStatus } from "../src/gitfacts.js";
import { startNew } from "../src/launch.js";
import { Notifier } from "../src/notify.js";
import { PendingStore, pendingStore } from "../src/pending.js";
import { RunStore, SessionSignals, StreamReader, resultFromRecord, runStore, runsRoot, sessionSignals, type RunRecord } from "../src/runs.js";
import { phaseOf } from "../src/summary.js";
import { getSession, sendFollowup, waitSession } from "../src/tools.js";
import { captureError, configAt, tempDir, tempHome } from "./helpers.js";

const ID = "d1111111-1111-4111-8111-111111111111";

function until(check: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async (): Promise<void> => {
      if (await check()) return resolve();
      if (Date.now() - started > ms) return reject(new Error("condition was not met in time"));
      setTimeout(() => void tick(), 25);
    };
    void tick();
  });
}

async function writeSession(root: string, cwd: string, id: string): Promise<void> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "user", sessionId: id, timestamp: "2024-01-01T00:00:00.000Z", cwd, message: { role: "user", content: "hello session" } }),
    JSON.stringify({ type: "assistant", sessionId: id, timestamp: "2024-01-01T00:00:01.000Z", cwd, message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "ready" }] } }),
  ];
  await writeFile(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
}

test("the result record keeps the final text, the error flag, and the denied tool calls", () => {
  const result = resultFromRecord({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Pushed.",
    num_turns: 7,
    duration_ms: 1234,
    permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push   origin main" } }, { tool_name: "Write", tool_input: { file_path: "/tmp/a", content: "SECRET-BODY" } }, "junk"],
  });
  assert.deepEqual(result, {
    isError: false,
    subtype: "success",
    text: "Pushed.",
    textTruncated: false,
    numTurns: 7,
    durationMs: 1234,
    permissionDenials: [{ tool: "Bash", input: "git push origin main" }, { tool: "Write", input: "/tmp/a" }],
  });
  assert.equal(resultFromRecord({ type: "assistant" }), null);
  assert.equal(resultFromRecord({ type: "result", result: "x".repeat(9000) })?.textTruncated, true);
});

test("the stream reader survives split chunks, noise, and a line over the cap", () => {
  const seen: unknown[] = [];
  const reader = new StreamReader((record) => seen.push(record));
  reader.feed('{"a":1}\n{"b"');
  reader.feed(':2}\nnot json\n');
  reader.feed(`{"big":"${"x".repeat(3 * 1024 * 1024)}`);
  reader.feed(`${"x".repeat(2 * 1024 * 1024)}"}\n{"c":3}\n`);
  assert.deepEqual(seen, [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test("a run is kept across a helper restart, and one that was still running is reported as lost", async () => {
  const { home } = await tempHome();
  const signals = new SessionSignals();
  const events: string[] = [];
  signals.subscribe((signal) => events.push(signal.event));
  const store = new RunStore(signals);
  await store.begin(home, ID, "launch");
  assert.equal((await store.get(home, ID))?.state, "running");
  assert.equal((await stat(path.join(runsRoot(home), `${ID}.json`))).mode & 0o777, 0o600);
  assert.equal((await new RunStore(signals).get(home, ID))?.state, "lost");

  await store.end(home, ID, 0, resultFromRecord({ type: "result", result: "done text", is_error: false }));
  const restarted = await new RunStore(signals).get(home, ID);
  assert.equal(restarted?.state, "exited");
  assert.equal(restarted?.exitCode, 0);
  assert.equal(restarted?.result?.text, "done text");
  assert.deepEqual(events, ["run-started", "run-finished"]);
  assert.equal(await store.get(home, "not-a-uuid"), null);
});

test("phase follows a run this server owns until a later prompt takes over", () => {
  const idle: SessionStatus = { value: "unknown", waitingFor: null, source: "fallback", kind: null };
  const running: RunState = { kind: "running", evidence: "process-argv" };
  const gone: RunState = { kind: "finished" };
  const turn: TurnFacts = {
    state: "in-progress", explicitEnd: false, prompt: "p", startedAt: "2026-01-01T00:00:10.000Z", lastActivity: "2026-01-01T00:00:20.000Z",
    reply: null, replyTruncated: false, narration: null, toolCalls: 1, toolErrors: 0, openTools: [], steps: [],
  };
  const run = (over: Partial<RunRecord>): RunRecord => ({ sessionId: ID, kind: "launch", state: "exited", startedAt: "2026-01-01T00:00:09.000Z", endedAt: "2026-01-01T00:00:30.000Z", exitCode: 0, result: null, ...over });
  const ok = resultFromRecord({ type: "result", result: "fine", is_error: false });
  const bad = resultFromRecord({ type: "result", result: "boom", is_error: true, permission_denials: [{ tool_name: "Bash", tool_input: { command: "x" } }] });

  assert.equal(phaseOf({ status: idle, run: running, turn, pending: [], owned: run({ state: "running", endedAt: null, exitCode: null }) }).value, "working");
  // A headless run that is waiting on a remote answer needs input, even though its process is live.
  assert.equal(phaseOf({ status: idle, run: running, turn, pending: [{ kind: "permission" }], owned: run({ state: "running", endedAt: null, exitCode: null }) }).value, "needs-input");
  // Once the prompt has its remote answer it stays listed until the turn ends, but it is not a reason to stop.
  assert.equal(phaseOf({ status: idle, run: running, turn, pending: [{ kind: "permission", answered: true }], owned: run({ state: "running", endedAt: null, exitCode: null }) }).value, "working");
  assert.equal(phaseOf({ status: idle, run: gone, turn, pending: [], owned: run({ result: ok }) }).value, "done");
  const failed = phaseOf({ status: idle, run: gone, turn, pending: [], owned: run({ exitCode: 1, result: bad }) });
  assert.equal(failed.value, "failed");
  assert.match(failed.reason, /1 tool call was denied/);
  assert.equal(phaseOf({ status: idle, run: gone, turn, pending: [], owned: run({ exitCode: 1 }) }).value, "failed");
  assert.equal(phaseOf({ status: idle, run: gone, turn, pending: [], owned: run({ exitCode: null }) }).value, "stopped");
  assert.equal(phaseOf({ status: idle, run: gone, turn, pending: [], owned: run({ exitCode: 143 }) }).value, "stopped", "what stop_session leaves: SIGTERM, no result");
  // Someone continued the session after the run ended: the transcript decides again.
  const later = { ...turn, startedAt: "2026-01-01T00:01:00.000Z" };
  assert.equal(phaseOf({ status: idle, run: gone, turn: later, pending: [], owned: run({ result: ok }) }).value, "interrupted");
  assert.equal(phaseOf({ status: idle, run: gone, turn, pending: [], owned: run({ state: "lost" }) }).value, "interrupted");

  // A handed message that has not reached the transcript keeps an idle session from reading as done.
  const settled: SessionStatus = { value: "idle", waitingFor: null, source: "agents-json", kind: "interactive" };
  const replied = { ...turn, state: "replied" as const, explicitEnd: true, reply: "old answer" };
  const at = Date.parse("2026-01-01T00:00:25.000Z");
  assert.equal(phaseOf({ status: settled, run: running, turn: replied, pending: [], handoffAt: at }).value, "working");
  assert.equal(phaseOf({ status: settled, run: running, turn: { ...replied, lastActivity: "2026-01-01T00:00:26.000Z" }, pending: [], handoffAt: at }).value, "done");
  assert.equal(phaseOf({ status: settled, run: running, turn: replied, pending: [], handoffAt: null }).value, "done");
});

test("a handoff note expires on its own", () => {
  let now = 1_000_000;
  const store = new RunStore(new SessionSignals(), () => now);
  store.noteHandoff(ID);
  assert.equal(store.handoffAt(ID), 1_000_000);
  now += 16_000;
  assert.equal(store.handoffAt(ID), null);
});

function detailWith(phase: SessionDetail["phase"]["value"]): SessionDetail {
  return {
    card: { sessionId: ID, status: { value: "working", waitingFor: null, source: "agents-json", kind: "interactive" }, pending: [] } as unknown as SessionDetail["card"],
    turns: [],
    summary: { did: "", stuck: null, coverage: "full" },
    lastReply: "",
    phase: { value: phase, reason: "test" },
    turn: null,
    run: null,
    git: null,
  };
}

test("wait_session returns when the session stops working, and a signal ends the wait early", async () => {
  const { home, root } = await tempHome();
  const config = configAt(home, root);
  let phase: SessionDetail["phase"]["value"] = "working";
  let reads = 0;
  const read = async (): Promise<SessionDetail> => {
    reads += 1;
    return detailWith(phase);
  };

  // Not working: one read, no waiting.
  phase = "done";
  const at0 = Date.now();
  const now = await waitSession(config, { sessionId: ID, timeoutMs: 5000 }, { read, pollMs: 60_000 });
  assert.equal(now.timedOut, false);
  assert.equal(now.phase.value, "done");
  assert.ok(Date.now() - at0 < 1000);

  // Working, then a signal for this session: the wait re-reads at once instead of sleeping out the poll.
  phase = "working";
  reads = 0;
  const at1 = Date.now();
  setTimeout(() => {
    sessionSignals.emit({ sessionId: "e2222222-2222-4222-8222-222222222222", event: "turn-finished" });
  }, 50);
  setTimeout(() => {
    phase = "needs-input";
    sessionSignals.emit({ sessionId: ID, event: "pending" });
  }, 150);
  const woken = await waitSession(config, { sessionId: ID, timeoutMs: 20_000 }, { read, pollMs: 60_000 });
  assert.equal(woken.phase.value, "needs-input");
  assert.equal(woken.timedOut, false);
  assert.ok(Date.now() - at1 < 5000, "ended by the signal, not by the 60 s poll or the timeout");
  assert.equal(reads, 2, "a signal for another session does not cause a read");

  // Working past the timeout: timedOut, and next says to call again.
  phase = "working";
  const late = await waitSession(config, { sessionId: ID, timeoutMs: 120 }, { read, pollMs: 40 });
  assert.equal(late.timedOut, true);
  assert.equal(late.phase.value, "working");
  assert.match(late.next, /wait_session again/);
  assert.ok(late.waitedMs >= 100);

  // The cap sits under the call deadline whatever the caller asks for.
  assert.equal(config.waitMaxMs, 25_000);
  assert.equal(configAt(home, root).sendInlineMs, 20_000);
  await assert.rejects(waitSession(config, { sessionId: "nope" }, { read }), /UUID/);
});

test("a headless launch keeps reading the stream and records how the run ended", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const id = "d3333333-3333-4333-8333-333333333333";
  await writeFile(path.join(folder, "fake-claude-sleep-ms"), "400");
  await writeFile(path.join(folder, "fake-claude-noise-bytes"), String(3_000_000));
  await writeFile(path.join(folder, "fake-claude-result.json"), JSON.stringify({
    result: "All four steps finished.", is_error: false, subtype: "success", num_turns: 12,
    permission_denials: [{ tool_name: "Bash", tool_input: { command: "git push" } }],
  }));
  const config = { ...configAt(home, root), allowLaunch: true, launchWaitMs: 5000 };
  const previous = process.env.FAKE_CLAUDE_SESSION;
  process.env.FAKE_CLAUDE_SESSION = id;
  try {
    const logs = await captureError(async () => {
      const started = await startNew(config, { folder, acceptDevChannelPrompt: false, options: { prompt: "do four steps" } });
      assert.equal(started.sessionId, id);
      assert.equal((await runStore.get(home, id))?.state, "running");
      const running = await getSession(config, { sessionId: id }).catch(() => null);
      assert.equal(running, null, "the shim writes no transcript, so there is no card yet; the run record is what speaks");
      await until(async () => (await runStore.get(home, id))?.state === "exited");
    });
    const run = await runStore.get(home, id);
    assert.equal(run?.exitCode, 0);
    assert.equal(run?.result?.text, "All four steps finished.");
    assert.equal(run?.result?.numTurns, 12);
    assert.deepEqual(run?.result?.permissionDenials, [{ tool: "Bash", input: "git push" }]);
    assert.equal(logs.includes("All four steps"), false, "the result text is never logged");
    // The record is marked exited in memory first and written to disk a moment later.
    const savedState = async (): Promise<string> => (JSON.parse(await readFile(path.join(runsRoot(home), `${id}.json`), "utf8")) as RunRecord).state;
    await until(async () => (await savedState()) === "exited");
  } finally {
    if (previous == null) delete process.env.FAKE_CLAUDE_SESSION;
    else process.env.FAKE_CLAUDE_SESSION = previous;
  }
});

test("a follow-up that outlives the inline wait returns started, keeps running, and wait_session reports its result", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = "d4444444-4444-4444-8444-444444444444";
  await writeSession(root, project, id);
  await writeFile(path.join(project, "fake-claude-sleep-ms"), "1200");
  // More stream output than the old 2 MB capture limit, which used to get the child killed.
  await writeFile(path.join(project, "fake-claude-noise-bytes"), String(3_000_000));
  await writeFile(path.join(project, "fake-claude-result.json"), JSON.stringify({ result: "Rebased, built, tested, pushed.", is_error: false, num_turns: 30 }));
  const config = { ...configAt(home, root, { allowSend: true }), sendInlineMs: 200, agentsJson: false };

  const outcome = await sendFollowup(config, { sessionId: id, message: "rebase, build, test, push", confirm: true });
  assert.equal(outcome.disposition, "started");
  assert.ok(outcome.disposition === "started" && outcome.ticketId.length > 0);
  assert.equal((await runStore.get(home, id))?.state, "running");

  const first = await waitSession(config, { sessionId: id, timeoutMs: 150 }, { pollMs: 50 });
  assert.equal(first.timedOut, true);
  assert.equal(first.phase.value, "working");
  assert.equal(first.run?.state, "running");

  const done = await waitSession(config, { sessionId: id, timeoutMs: 10_000 }, { pollMs: 5000 });
  assert.equal(done.timedOut, false, "the run exit ended the wait, not the poll");
  assert.equal(done.phase.value, "done");
  assert.equal(done.run?.exitCode, 0);
  assert.equal(done.run?.result?.text, "Rebased, built, tested, pushed.");
  assert.equal(done.run?.result?.numTurns, 30);
  assert.match(done.next, /run\.result\.text/);
  assert.ok(done.waitedMs < 5000);
});

// 0 ms: the request is listed before the inline wait subscribes, as on a slow machine. 200 ms: it arrives during the wait.
for (const delayMs of [0, 200]) test(`a follow-up that asks for a permission ${delayMs === 0 ? "before the inline wait starts" : "during the inline wait"} returns started, so the caller can answer it`, async (t) => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = "d6666666-6666-4666-8666-666666666666";
  await writeSession(root, project, id);
  await writeFile(path.join(project, "fake-claude-sleep-ms"), "3000");
  // The shim registers no live process, so say what a real claude would: the session is busy.
  // Without that, entries for a session that is not running are dropped as stale.
  const agentsFile = path.join(home, "agents.json");
  await writeFile(agentsFile, JSON.stringify([{ sessionId: id, pid: process.pid, kind: "interactive", status: "busy" }]));
  const previous = process.env.CLAUDE_REMOTE_FAKE_AGENTS;
  process.env.CLAUDE_REMOTE_FAKE_AGENTS = agentsFile;
  t.after(() => {
    if (previous == null) delete process.env.CLAUDE_REMOTE_FAKE_AGENTS;
    else process.env.CLAUDE_REMOTE_FAKE_AGENTS = previous;
  });
  const config = { ...configAt(home, root, { allowSend: true }), sendInlineMs: 20_000 };
  setTimeout(() => {
    pendingStore.record({ hook_event_name: "PermissionRequest", session_id: id, cwd: project, tool_name: "Bash", tool_input: { command: "git push" } }, { allowApprove: true, waitMs: 60_000 });
  }, delayMs);
  const outcome = await sendFollowup(config, { sessionId: id, message: "push it", confirm: true });
  assert.equal(outcome.disposition, "started");
  // sent would mean the 3 s run ended first. How long the call took depends on the machine, so it is not asserted.
  const asked = await waitSession(config, { sessionId: id, timeoutMs: 5000 }, { pollMs: 50 });
  assert.equal(asked.phase.value, "needs-input");
  assert.equal(asked.pending[0]?.toolInput?.command, "git push");
  pendingStore.record({ hook_event_name: "Stop", session_id: id }, { allowApprove: true, waitMs: 0 });
  await until(async () => (await runStore.get(home, id))?.state === "exited");
});

test("a quick follow-up still returns sent with its result, and an error run reads as failed", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = "d5555555-5555-4555-8555-555555555555";
  await writeSession(root, project, id);
  const config = { ...configAt(home, root, { allowSend: true }), agentsJson: false };
  const quick = await sendFollowup(config, { sessionId: id, message: "hi", confirm: true });
  assert.equal(quick.disposition, "sent");
  assert.ok(quick.disposition === "sent" && quick.result === "shim-ok");
  assert.equal((await getSession(config, { sessionId: id })).phase.value, "done");

  await writeFile(path.join(project, "fake-claude-result.json"), JSON.stringify({ result: "Could not push.", is_error: true, subtype: "error_during_execution" }));
  await writeFile(path.join(project, "fake-claude-exit-code"), "1");
  await sendFollowup(config, { sessionId: id, message: "again", confirm: true });
  const detail = await getSession(config, { sessionId: id });
  assert.equal(detail.phase.value, "failed");
  assert.equal(detail.run?.exitCode, 1);
  assert.equal(detail.run?.result?.isError, true);
});

test("git facts say whether the branch is pushed", async () => {
  assert.deepEqual(parseGitStatus("# branch.oid 0123456789abcdef0123456789abcdef01234567\n# branch.head feature\n# branch.upstream origin/feature\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b src/a.ts\n? new.txt\n"), {
    head: "0123456789ab", branch: "feature", upstream: "origin/feature", ahead: 2, behind: 1, dirtyFiles: 2, pushed: false,
  });
  assert.equal(parseGitStatus("# branch.oid (initial)\n# branch.head main\n").pushed, null);

  const origin = await tempDir("claude-remote-origin-");
  const work = await tempDir("claude-remote-work-");
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { stdio: "ignore" });
  };
  git(origin, "init", "--bare", "-b", "main");
  git(work, "init", "-b", "main");
  await writeFile(path.join(work, "a.txt"), "one\n");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "one");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-u", "origin", "main");
  const pushed = await gitFacts(work);
  assert.equal(pushed?.branch, "main");
  assert.equal(pushed?.pushed, true);
  assert.equal(pushed?.dirtyFiles, 0);

  await writeFile(path.join(work, "a.txt"), "two\n");
  git(work, "commit", "-am", "two");
  await writeFile(path.join(work, "b.txt"), "untracked\n");
  const ahead = await gitFacts(work);
  assert.equal(ahead?.ahead, 1);
  assert.equal(ahead?.pushed, false);
  assert.equal(ahead?.dirtyFiles, 1);
  assert.equal(await gitFacts(await tempDir("claude-remote-nogit-")), null);
});

test("a finished turn and a finished run each produce one alert without any text", async () => {
  const sent: { body: string; headers: Record<string, string> }[] = [];
  const notifier = new Notifier(
    { url: "https://example.com/hook", secret: "0123456789abcdef0123", auth: "hmac", includeText: true, cleared: false },
    new PendingStore(),
    { send: async (_url, init) => { sent.push({ body: init.body, headers: init.headers }); return 200; }, clock: () => 1_700_000_000_000 },
  );
  notifier.signal({ sessionId: ID, event: "turn-finished", projectName: "my-app" });
  notifier.signal({ sessionId: ID, event: "run-finished", exitCode: 1, isError: true });
  notifier.signal({ sessionId: ID, event: "run-started" });
  notifier.signal({ sessionId: ID, event: "pending" });
  await captureError(() => notifier.idle());
  const bodies = sent.map((item) => JSON.parse(item.body) as Record<string, unknown>);
  assert.deepEqual(bodies.map((body) => body.event), ["turn-finished", "run-finished"]);
  assert.deepEqual(bodies[0], {
    type: "claude-remote.session", event: "turn-finished", eventId: `${ID}.turn-finished.1700000000000`, sessionId: ID,
    projectName: "my-app", exitCode: null, isError: false, sentAt: "2023-11-14T22:13:20.000Z",
  });
  assert.equal(bodies[1]?.exitCode, 1);
  assert.equal(bodies[1]?.isError, true);
  assert.match(sent[0]?.headers["X-Claude-Remote-Signature"] ?? sent[0]?.headers["x-claude-remote-signature"] ?? "", /^sha256=/);
});
