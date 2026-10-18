import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ERR, TOOL, VID, WAIT } from "../fixtures/ids.js";
import { parseSessionId } from "../src/paths.js";
import { linuxStatStart, processIdentity, procStartMatches, type ProcessIdentity } from "../src/registry.js";
import { classifyRunState } from "../src/running.js";
import { showSession } from "../src/show.js";
import { getSession, listSessions, sendFollowup } from "../src/tools.js";
import { captureError, configAt, fixtureConfig, tempHome } from "./helpers.js";

test("list_sessions returns the fixture cards and hides junk files", async () => {
  const config = fixtureConfig();
  const logs = await captureError(async () => {
    const listed = await listSessions(config, {}, async () => []);
    assert.equal(listed.pagedBy, "mtime");
    assert.equal(listed.scannedFileCount, 4);
    const vid = listed.sessions.find((session) => session.sessionId === VID);
    assert.ok(vid);
    assert.equal(vid.projectName, "demo-app");
    assert.equal(vid.title, "Audio desk");
    assert.equal(vid.projectPath, "/tmp/fixture/demo-app");
    assert.equal(vid.cwd, "/tmp/fixture/demo-app/.claude/worktrees/audio");
    assert.equal(vid.liveOwner, "none");
    assert.equal(vid.branch, "claude/audio-lead-in-0a1b2c");
    assert.equal(vid.messageCount, 2);
    assert.equal(vid.inDesktopSidebar, true);
    assert.equal(vid.desktopSessionId, "local_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(vid.worktreePath, "/tmp/fixture/demo-app/.claude/worktrees/audio");
    assert.deepEqual(vid.runState, { kind: "finished" });
    const waiting = listed.sessions.find((session) => session.sessionId === WAIT);
    assert.ok(waiting);
    assert.equal(waiting.projectName, "sample-app");
    assert.equal(waiting.cwd, "/tmp/fixture/sample-app/.claude/worktrees/export");
    assert.equal(waiting.liveOwner, "none");
    assert.equal(waiting.branch, "claude/sample-app-0a1b");
    assert.equal(waiting.inDesktopSidebar, true);
    assert.deepEqual(waiting.runState, { kind: "unknown", reason: "tail-open" });
    const notes = listed.sessions.find((session) => session.sessionId === ERR);
    assert.ok(notes);
    assert.equal(notes.inDesktopSidebar, false);
    assert.equal(notes.projectName, "notes");
    assert.equal(notes.cwd, "/tmp/fixture/notes");
    assert.equal(notes.title, "run the check");
    assert.equal(notes.liveOwner, "none");
    const body = JSON.stringify(listed);
    assert.equal(body.includes("ORPHAN-TITLE"), false);
    assert.equal(body.includes("SIDECHAIN-TITLE"), false);
    assert.equal(body.includes("SUBAGENT-TITLE"), false);
    assert.equal(body.includes("SUPERSEDED-TITLE"), false);
    assert.equal(body.includes("meta command"), false);
    assert.equal(body.includes("Tighten the audio lead-in"), false);
    assert.equal(body.includes("Shortened the lead-in"), false);
    assert.equal(body.includes("Created the project."), false);
    assert.equal(body.includes("add the export button"), false);
    assert.equal(body.includes("turns"), false);
  });
  assert.equal(logs.includes("Tighten the audio lead-in"), false);
  assert.equal(logs.includes("Audio lead-in"), false);
  assert.equal(logs.includes("Audio desk"), false);
  assert.equal(logs.includes("list_sessions"), true);
});

test("get_session reports stuck lines for open, tool, and error tails", async () => {
  const config = fixtureConfig();
  const waiting = await getSession(config, { sessionId: WAIT }, async () => []);
  assert.equal(waiting.summary.stuck, "waiting on a reply");
  assert.equal(waiting.summary.coverage, "full");
  assert.equal(waiting.turns.some((turn) => turn.text === "add the export button"), true);
  const tool = await getSession(config, { sessionId: TOOL }, async () => []);
  assert.equal(tool.summary.stuck, "last tool call has no result in the tail");
  assert.equal(tool.turns.some((turn) => turn.toolNames.includes("Bash")), true);
  const error = await getSession(config, { sessionId: ERR }, async () => []);
  assert.equal(error.summary.stuck, "last tool result is an error: command exited 1");
  assert.deepEqual(error.card.runState, { kind: "finished" });
  assert.equal(error.summary.did, "Running the check. Tools: Bash.");
});

test("a process command line marks a closed session running and wins the stuck line", async () => {
  const detail = await getSession(fixtureConfig(), { sessionId: VID }, async () => [`claude --resume ${VID}`]);
  assert.deepEqual(detail.card.runState, { kind: "running", evidence: "process-argv" });
  assert.equal(detail.summary.stuck, "session is running");
});

test("an unreadable sessions path stays unknown even when the tail is closed", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await writeFile(path.join(root, "sessions"), "not-a-directory");
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [`claude --resume ${id}`]);
  assert.deepEqual(detail.card.runState, { kind: "unknown", reason: "sessions-dir-unreadable" });
});

test("a live pid whose procStart matches is running, and a missing record is finished", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    if (pid == null) return;
    const found = await processIdentity(pid);
    assert.equal(typeof found.startToken, "string");
    if (process.platform === "linux") assert.match(String(found.startToken), /^\d+$/);
    const runningHome = await tempHome();
    const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
    await writeClosed(runningHome.root, id, path.join(runningHome.home, "proj"));
    await mkdir(path.join(runningHome.root, "sessions"), { recursive: true });
    await writeFile(path.join(runningHome.root, "sessions", `${pid}.json`), JSON.stringify({
      pid,
      sessionId: id,
      procStart: found.startToken,
      status: "busy",
      messagingSocketPath: "SOCKET-SENTINEL",
    }));
    const logs = await captureError(async () => {
      const running = await getSession(configAt(runningHome.home, runningHome.root), { sessionId: id }, async () => []);
      assert.deepEqual(running.card.runState, { kind: "running", evidence: "sessions-file" });
      assert.equal(JSON.stringify(running).includes("SOCKET-SENTINEL"), false);
    });
    assert.equal(logs.includes("SOCKET-SENTINEL"), false);
  } finally {
    child.kill("SIGKILL");
  }

  const idleHome = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(idleHome.root, id, path.join(idleHome.home, "proj"));
  const idle = await getSession(configAt(idleHome.home, idleHome.root), { sessionId: id }, async () => []);
  assert.deepEqual(idle.card.runState, { kind: "finished" });
});

test("a live pid with a different procStart is not running", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100" });
  const identity = async (pid: number): Promise<ProcessIdentity> => {
    if (pid === 4242) return { alive: true, startToken: "999" };
    return { alive: false };
  };
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [`claude --resume ${id}`], identity);
  assert.deepEqual(detail.card.runState, { kind: "running", evidence: "process-argv" });
});

test("a zombie pid does not count as a live session", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100" });
  const identity = async (): Promise<ProcessIdentity> => ({ alive: true, state: "Z", startToken: "100" });
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [], identity);
  assert.deepEqual(detail.card.runState, { kind: "finished" });
});

test("a dead pid does not count as a live session", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100" });
  const identity = async (): Promise<ProcessIdentity> => ({ alive: false });
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [], identity);
  assert.deepEqual(detail.card.runState, { kind: "finished" });
});

test("a live pid whose start time cannot be read is unknown", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100" });
  const identity = async (): Promise<ProcessIdentity> => ({ alive: true });
  const detail = await getSession(
    configAt(home, root),
    { sessionId: id },
    async () => [`claude --resume ${id}`],
    identity,
  );
  assert.deepEqual(detail.card.runState, { kind: "unknown", reason: "sessions-file-unverified" });
});

test("a malformed session record is ignored", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "sessions", "4242.json"), "{not-json SECRET-BAD-RECORD");
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => []);
  assert.deepEqual(detail.card.runState, { kind: "finished" });
  assert.equal(JSON.stringify(detail).includes("SECRET-BAD-RECORD"), false);
});

test("a sibling key file is never read", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeClosed(root, id, path.join(home, "proj"));
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100" });
  const key = path.join(root, "sessions", "4242.abc123.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  const identity = async (pid: number): Promise<ProcessIdentity> => {
    if (pid === 4242) return { alive: true, startToken: "100" };
    return { alive: false };
  };
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => [], identity);
  assert.deepEqual(detail.card.runState, { kind: "running", evidence: "sessions-file" });
  assert.equal(JSON.stringify(detail).includes("SECRET-KEY-BODY"), false);
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
});

test("procStart matches clock ticks exactly and asctime within two seconds", () => {
  assert.equal(procStartMatches("133782286", "133782286"), true);
  assert.equal(procStartMatches("133782286", "133782287"), false);
  assert.equal(procStartMatches("Thu Jun 18 14:15:10 2026", "Thu Jun 18 14:15:11 2026"), true);
  assert.equal(procStartMatches("Thu Jun 18 14:15:10 2026", "Thu Jun 18 14:15:13 2026"), false);
  const utc = Date.UTC(2026, 5, 18, 14, 15, 10);
  const local = new Date(utc);
  const localText = [
    ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getDay()],
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][local.getMonth()],
    String(local.getDate()),
    [local.getHours(), local.getMinutes(), local.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":"),
    String(local.getFullYear()),
  ].join(" ");
  assert.equal(procStartMatches("Thu Jun 18 14:15:10 2026", localText), true);
  const statText = "4242 (claude code) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 133782286 0 0";
  assert.deepEqual(linuxStatStart(statText), { start: "133782286", state: "S" });
});

test("classifyRunState keeps unreadable ahead of a matching process and a closed tail", () => {
  const vid = parseSessionId(VID);
  assert.ok(vid);
  assert.deepEqual(classifyRunState({
    registry: { status: "unreadable" },
    sessionId: vid,
    cmdlines: [`claude --resume ${vid}`],
    tail: "closed",
  }), { kind: "unknown", reason: "sessions-dir-unreadable" });
  assert.deepEqual(classifyRunState({
    registry: { status: "checked", live: [vid], unverified: [], owners: {} },
    sessionId: vid,
    cmdlines: [],
    tail: "open",
  }), { kind: "running", evidence: "sessions-file" });
  assert.deepEqual(classifyRunState({
    registry: { status: "missing" },
    sessionId: vid,
    cmdlines: ["claude"],
    tail: "closed",
  }), { kind: "finished" });
});

test("list_sessions pages by mtime before it reads a newer internal timestamp", async () => {
  const { home, root } = await tempHome();
  const oldId = "11111111-1111-4111-8111-111111111111";
  const newId = "22222222-2222-4222-8222-222222222222";
  const oldFile = await writeClosed(root, oldId, "/tmp/fixture/old", "2099-01-01T00:00:00.000Z");
  const newFile = await writeClosed(root, newId, "/tmp/fixture/new", "2020-01-01T00:00:00.000Z");
  const old = new Date("2020-01-01T00:00:00.000Z");
  const newer = new Date("2024-01-01T00:00:00.000Z");
  await utimes(oldFile, old, old);
  await utimes(newFile, newer, newer);
  const listed = await listSessions(configAt(home, root), { limit: 1 }, async () => []);
  assert.equal(listed.scannedFileCount, 2);
  assert.equal(listed.pagedBy, "mtime");
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0]?.sessionId, newId);
});

test("a custom title in the head beats an ai title in the tail", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const head = [
    JSON.stringify({ type: "custom-title", customTitle: "Head Custom", sessionId: id }),
    JSON.stringify({
      type: "user",
      uuid: "a1111111-1111-4111-8111-111111111101",
      parentUuid: null,
      sessionId: id,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd: "/tmp/fixture/demo-app",
      message: { role: "user", content: "head prompt" },
    }),
  ];
  const padding = `${JSON.stringify({ type: "progress", data: "x".repeat(200) })}\n`.repeat(400);
  const tail = `${JSON.stringify({ type: "ai-title", aiTitle: "Tail AI", sessionId: id })}\n`;
  await writeFile(file, `${head.join("\n")}\n${padding}${tail}`);
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => []);
  assert.equal(detail.card.title, "Head Custom");
});

test("show reads the last assistant text from a huge line and from a file with no trailing newline", async () => {
  const { home, root } = await tempHome();
  const hugeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const smallId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const user = (id: string) => JSON.stringify({
    type: "user",
    uuid: "a1111111-1111-4111-8111-111111111101",
    parentUuid: null,
    sessionId: id,
    timestamp: "2024-01-01T00:00:00.000Z",
    cwd: "/tmp/fixture/reply",
    message: { role: "user", content: "prompt" },
  });
  const huge = JSON.stringify({
    type: "assistant",
    uuid: "a1111111-1111-4111-8111-111111111102",
    parentUuid: "a1111111-1111-4111-8111-111111111101",
    sessionId: hugeId,
    timestamp: "2024-01-01T00:00:01.000Z",
    cwd: "/tmp/fixture/reply",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "x".repeat(70000), signature: "sig" },
        { type: "text", text: "VISIBLE-REPLY" },
      ],
    },
  });
  await writeFile(path.join(dir, `${hugeId}.jsonl`), `${user(hugeId)}\n${huge}`);
  const hugeView = await showSession(configAt(home, root), hugeId, async () => []);
  assert.equal(hugeView.messageCount, 2);
  assert.equal(hugeView.reply, "VISIBLE-REPLY");
  assert.equal(hugeView.reply.includes("x".repeat(20)), false);

  const small = JSON.stringify({
    type: "assistant",
    uuid: "a1111111-1111-4111-8111-111111111102",
    parentUuid: "a1111111-1111-4111-8111-111111111101",
    sessionId: smallId,
    timestamp: "2024-01-01T00:00:01.000Z",
    cwd: "/tmp/fixture/reply",
    message: { role: "assistant", content: [{ type: "output_text", content: "TAIL-REPLY" }] },
  });
  await writeFile(path.join(dir, `${smallId}.jsonl`), `${user(smallId)}\n${small}`);
  const detail = await getSession(configAt(home, root), { sessionId: smallId }, async () => []);
  assert.equal(detail.lastReply, "TAIL-REPLY");
  assert.equal(detail.card.messageCount, 2);
  assert.equal(detail.turns.some((turn) => turn.text === "TAIL-REPLY"), true);
  const smallView = await showSession(configAt(home, root), smallId, async () => []);
  assert.equal(smallView.reply, "TAIL-REPLY");
});

test("steer on a live session with no transcript does not stage a file", async () => {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    if (pid == null) return;
    const found = await processIdentity(pid);
    const { home, root } = await tempHome();
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const folder = path.join(home, "proj");
    await mkdir(folder, { recursive: true });
    await writeRecord(root, pid, {
      pid,
      sessionId: id,
      procStart: found.startToken,
      entrypoint: "cli",
      cwd: folder,
    });
    const outcome = await sendFollowup(configAt(home, root, { allowSend: true }), {
      sessionId: id,
      message: "STEER-SECRET",
      confirm: true,
      mode: "steer",
    }, async () => []);
    assert.equal(outcome.disposition, "unsupported");
    await assert.rejects(() => stat(path.join(home, ".claude-remote", "attachments", id)));
  } finally {
    child.kill("SIGKILL");
  }
  await closed;
});

test("an oversized invalid line still counts and its body stays out of the result", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const prefix = `{"type":"user","uuid":"a1111111-1111-4111-8111-111111111101","parentUuid":null,"sessionId":"${id}","timestamp":"2024-05-01T00:00:00.000Z","cwd":"/tmp/fixture/oversize","message":{"role":"user","content":"hi"}}`;
  const marker = "SENTINEL-OVERSIZE-BODY";
  const line = `${prefix}${marker}${"x".repeat(1024 * 1024)}${marker}`;
  assert.throws(() => JSON.parse(line));
  await writeFile(path.join(dir, `${id}.jsonl`), `${line}\n`);
  const detail = await getSession(configAt(home, root), { sessionId: id }, async () => []);
  assert.equal(detail.card.messageCount, 1);
  assert.equal(JSON.stringify(detail).includes(marker), false);
});

async function writeRecord(root: string, pid: number, body: unknown): Promise<void> {
  const dir = path.join(root, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${pid}.json`), JSON.stringify(body));
}

async function writeClosed(root: string, id: string, cwd: string, timestamp = "2024-01-01T00:00:00.000Z"): Promise<string> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const user = "a1111111-1111-4111-8111-111111111101";
  const assistant = "a1111111-1111-4111-8111-111111111102";
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: user,
      parentUuid: null,
      sessionId: id,
      timestamp,
      cwd,
      message: { role: "user", content: "closed prompt" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: assistant,
      parentUuid: user,
      sessionId: id,
      timestamp,
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "closed reply" }] },
    }),
  ];
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}
