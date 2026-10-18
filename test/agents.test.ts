import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ERR, TOOL, VID, WAIT } from "../fixtures/ids.js";
import { loadAgents, parseAgentsJson, resolveStatus, snapshotFrom, statusFromEntry, type AgentEntry } from "../src/agents.js";
import { listRows } from "../src/rows.js";
import { processIdentity } from "../src/registry.js";
import { stuckFromStatus } from "../src/summary.js";
import { getSession, listSessions } from "../src/tools.js";
import { captureError, configAt, fixtureConfig, repoRoot, tempHome } from "./helpers.js";

const agentsFixture = path.join(repoRoot, "fixtures", "agents", "agents.json");

function entry(partial: Partial<AgentEntry>): AgentEntry {
  return { sessionId: null, pid: 1, kind: "interactive", status: null, state: null, waitingFor: null, shortId: null, ...partial };
}

async function withFakeAgents<T>(file: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CLAUDE_REMOTE_FAKE_AGENTS;
  if (file) process.env.CLAUDE_REMOTE_FAKE_AGENTS = file;
  else delete process.env.CLAUDE_REMOTE_FAKE_AGENTS;
  try {
    return await fn();
  } finally {
    if (previous == null) delete process.env.CLAUDE_REMOTE_FAKE_AGENTS;
    else process.env.CLAUDE_REMOTE_FAKE_AGENTS = previous;
  }
}

test("parseAgentsJson keeps only the documented fields and drops cwd and name", async () => {
  const { readFile } = await import("node:fs/promises");
  const entries = parseAgentsJson(await readFile(agentsFixture, "utf8"));
  assert.ok(entries);
  assert.equal(entries.length, 6);
  const first = entries[0]!;
  assert.deepEqual(Object.keys(first).sort(), ["kind", "pid", "sessionId", "shortId", "state", "status", "waitingFor"]);
  assert.equal(JSON.stringify(entries).includes("/tmp/fixture"), false);
  assert.equal(JSON.stringify(entries).includes("refactor"), false);
  const background = entries.find((item) => item.shortId === "bg7k2");
  assert.equal(background?.kind, "background");
  assert.equal(background?.state, "blocked");
  assert.equal(background?.waitingFor, "input needed");
  assert.equal(parseAgentsJson("not json"), null);
  assert.equal(parseAgentsJson("{}"), null);
  assert.deepEqual(parseAgentsJson("[1, null, {\"sessionId\": \"nope\"}]"), []);
});

test("busy maps to working, waiting to needs-you with waitingFor, idle to idle", () => {
  assert.deepEqual(statusFromEntry(entry({ status: "busy" })), { value: "working", waitingFor: null, source: "agents-json", kind: "interactive" });
  assert.deepEqual(statusFromEntry(entry({ status: "waiting", waitingFor: "permission prompt" })), {
    value: "needs-you",
    waitingFor: "permission prompt",
    source: "agents-json",
    kind: "interactive",
  });
  assert.equal(statusFromEntry(entry({ status: "idle" })).value, "idle");
  assert.equal(statusFromEntry(entry({ status: null })).value, "unknown");
  assert.equal(statusFromEntry(entry({ status: "idle", waitingFor: "dialog open" })).waitingFor, null);
  assert.equal(parseAgentsJson('[{"pid":5,"status":"waiting","waitingFor":"something new"}]')?.[0]?.waitingFor, "other");
});

test("a background session uses state over status", () => {
  const bg = (state: AgentEntry["state"], status: AgentEntry["status"] = "idle") => statusFromEntry(entry({ kind: "background", state, status, waitingFor: "input needed" }));
  assert.equal(bg("working").value, "working");
  assert.deepEqual([bg("blocked").value, bg("blocked").waitingFor], ["needs-you", "input needed"]);
  assert.equal(bg("done", "busy").value, "idle");
  assert.equal(bg("failed").value, "failed");
  assert.equal(bg("stopped").value, "stopped");
  assert.equal(bg(null, "busy").value, "working");
});

test("resolveStatus marks unlisted sessions and falls back to the sessions-file token", () => {
  const snapshot = snapshotFrom([entry({ sessionId: VID as AgentEntry["sessionId"], status: "busy" })]);
  assert.equal(resolveStatus({ snapshot, sessionId: VID, runState: { kind: "finished" }, registryToken: null }).value, "working");
  assert.equal(resolveStatus({ snapshot, sessionId: WAIT, runState: { kind: "finished" }, registryToken: null }).value, "not-running");
  assert.equal(resolveStatus({ snapshot, sessionId: WAIT, runState: { kind: "running", evidence: "sessions-file" }, registryToken: "busy" }).value, "unknown");
  const none = { available: false as const, reason: "failed" as const };
  assert.deepEqual(resolveStatus({ snapshot: none, sessionId: VID, runState: { kind: "running", evidence: "sessions-file" }, registryToken: "waiting" }), {
    value: "needs-you",
    waitingFor: null,
    source: "sessions-file",
    kind: null,
  });
  assert.equal(resolveStatus({ snapshot: none, sessionId: VID, runState: { kind: "running", evidence: "process-argv" }, registryToken: null }).source, "fallback");
  assert.equal(resolveStatus({ snapshot: none, sessionId: VID, runState: { kind: "finished" }, registryToken: null }).value, "not-running");
  assert.equal(resolveStatus({ snapshot: none, sessionId: VID, runState: { kind: "unknown", reason: "tail-open" }, registryToken: null }).value, "unknown");
});

test("a live process row wins over an exited background row for the same session", () => {
  const id = VID as AgentEntry["sessionId"];
  const snapshot = snapshotFrom([
    entry({ sessionId: id, pid: null, kind: "background", state: "done" }),
    entry({ sessionId: id, pid: 7, status: "busy" }),
  ]);
  assert.ok(snapshot.available);
  assert.equal(snapshot.bySession.get(VID)?.pid, 7);
});

test("loadAgents falls back on a missing binary, an older CLI, bad JSON, and a timeout", async () => {
  const run = (result: { code: number | null; stdout: string; spawnError: string | null }) => async () => result;
  assert.deepEqual(await loadAgents("claude", { run: run({ code: null, stdout: "", spawnError: "ENOENT" }) }), { available: false, reason: "missing" });
  assert.deepEqual(await loadAgents("claude", { run: run({ code: 1, stdout: "", spawnError: null }) }), { available: false, reason: "failed" });
  assert.deepEqual(await loadAgents("claude", { run: run({ code: 0, stdout: "Usage: claude", spawnError: null }) }), { available: false, reason: "unparseable" });
  assert.deepEqual(await loadAgents("claude", { run: run({ code: null, stdout: "", spawnError: "timeout" }) }), { available: false, reason: "timeout" });
  assert.deepEqual(await loadAgents("claude", { disabled: true }), { available: false, reason: "disabled" });
  assert.deepEqual(await loadAgents("claude", { run: async () => { throw new Error("boom"); } }), { available: false, reason: "failed" });
  const seen: string[][] = [];
  const ok = await loadAgents("claude", {
    run: async (_bin, args) => {
      seen.push(args);
      return { code: 0, stdout: "[]\n", spawnError: null };
    },
  });
  assert.equal(ok.available, true);
  assert.deepEqual(seen, [["agents", "--json", "--all"]]);
  assert.deepEqual(await loadAgents("/no/such/claude-binary"), { available: false, reason: "missing" });
});

test("list_sessions takes status from claude agents --json and keeps names and paths out of the log", async () => {
  const config = fixtureConfig();
  await withFakeAgents(agentsFixture, async () => {
    const logs = await captureError(async () => {
      const listed = await listSessions(config, {}, async () => []);
      const by = (id: string) => listed.sessions.find((card) => card.sessionId === id);
      assert.deepEqual(by(VID)?.status, { value: "working", waitingFor: null, source: "agents-json", kind: "interactive" });
      assert.deepEqual(by(WAIT)?.status, { value: "needs-you", waitingFor: "permission prompt", source: "agents-json", kind: "interactive" });
      assert.equal(by(TOOL)?.status.value, "idle");
      assert.deepEqual(by(ERR)?.status, { value: "needs-you", waitingFor: "input needed", source: "agents-json", kind: "background" });
    });
    assert.match(logs, /"evidence":"agents-json"/);
    assert.equal(logs.includes("demo-app-3f"), false);
    assert.equal(logs.includes("web-ui refactor"), false);
    const detail = await getSession(config, { sessionId: WAIT }, async () => []);
    assert.equal(detail.summary.stuck, "needs you: permission prompt");
    const rows = await listRows(config, {}, async () => []);
    assert.equal(rows.find((row) => row.sessionId === VID)?.activity, "working");
    assert.equal(rows.find((row) => row.sessionId === WAIT)?.activity, "needs-you");
  });
});

test("without the agents subcommand the old heuristics stay in place", async () => {
  const config = fixtureConfig();
  await withFakeAgents(undefined, async () => {
    const logs = await captureError(async () => {
      const listed = await listSessions(config, {}, async () => []);
      const vid = listed.sessions.find((card) => card.sessionId === VID);
      assert.deepEqual(vid?.status, { value: "not-running", waitingFor: null, source: "fallback", kind: null });
      const wait = listed.sessions.find((card) => card.sessionId === WAIT);
      assert.equal(wait?.status.value, "unknown");
    });
    assert.match(logs, /"evidence":"agents-failed"/);
    const detail = await getSession(config, { sessionId: WAIT }, async () => []);
    assert.equal(detail.summary.stuck, "waiting on a reply");
  });
  const disabled = { ...config, agentsJson: false };
  const listed = await listSessions(disabled, {}, async () => []);
  assert.equal(listed.sessions.every((card) => card.status.source !== "agents-json"), true);
});

test("a live session shows entrypoint, tmux, bridge id, and inbox socket from sessions/<pid>.json", async () => {
  const { home, root } = await tempHome();
  const id = "abababab-abab-4aba-8aba-abababababab";
  const identity = await processIdentity(process.pid);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    sessionId: id,
    procStart: identity.startToken,
    entrypoint: "claude-desktop",
    cwd: home,
    status: "waiting",
    tmux: "work:1.0",
    bridgeSessionId: "cse_0123abcd",
    messagingSocketPath: `/tmp/cc-socks/${process.pid}.sock`,
    kind: "interactive",
  }));
  const config = configAt(home, root);
  await withFakeAgents(undefined, async () => {
    const listed = await listSessions(config, {}, async () => []);
    const card = listed.sessions.find((item) => item.sessionId === id);
    assert.ok(card);
    assert.deepEqual(card.process, {
      pid: process.pid,
      entrypoint: "desktop",
      tmux: "work:1.0",
      bridgeSessionId: "cse_0123abcd",
      messagingSocketPath: `/tmp/cc-socks/${process.pid}.sock`,
    });
    assert.deepEqual(card.status, { value: "needs-you", waitingFor: null, source: "sessions-file", kind: null });
  });
  await writeFile(path.join(root, "sessions", `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    sessionId: id,
    procStart: identity.startToken,
    entrypoint: "cli",
    tmux: "bad; name",
    bridgeSessionId: null,
    messagingSocketPath: "/tmp/../etc/passwd.sock",
  }));
  const listed = await listSessions(config, {}, async () => []);
  const card = listed.sessions.find((item) => item.sessionId === id);
  assert.deepEqual(card?.process, { pid: process.pid, entrypoint: "terminal", tmux: null, bridgeSessionId: null, messagingSocketPath: null });
});

test("stuckFromStatus only speaks for agents-json rows", () => {
  assert.equal(stuckFromStatus({ value: "working", waitingFor: null, source: "agents-json", kind: "interactive" }), "session is working");
  assert.equal(stuckFromStatus({ value: "needs-you", waitingFor: null, source: "agents-json", kind: "interactive" }), "needs you");
  assert.equal(stuckFromStatus({ value: "failed", waitingFor: null, source: "agents-json", kind: "background" }), "background session failed");
  assert.equal(stuckFromStatus({ value: "not-running", waitingFor: null, source: "agents-json", kind: null }), null);
  assert.equal(stuckFromStatus({ value: "working", waitingFor: null, source: "sessions-file", kind: null }), null);
  assert.equal(stuckFromStatus(undefined), null);
});
