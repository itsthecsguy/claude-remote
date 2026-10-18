import assert from "node:assert/strict";
import { chmod, mkdir, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { agentIdOf, listSubSessions, parseMeta } from "../src/subagents.js";
import { getSession, listSessions } from "../src/tools.js";
import { configAt, tempHome } from "./helpers.js";

const PARENT = "acacacac-acac-4aca-8aca-acacacacacac";
const SECRET = "SUBAGENT-TRANSCRIPT-SECRET";

async function seed(): Promise<{ home: string; root: string; transcript: string; subDir: string }> {
  const { home, root } = await tempHome();
  const project = path.join(root, "projects", "-tmp-fixture-sub-app");
  await mkdir(project, { recursive: true });
  const transcript = path.join(project, `${PARENT}.jsonl`);
  await writeFile(transcript, `${JSON.stringify({ type: "user", cwd: "/tmp/fixture/sub-app", sessionId: PARENT, message: { role: "user", content: "hello" }, timestamp: "2026-01-01T00:00:00.000Z" })}\n`);
  const subDir = path.join(project, PARENT, "subagents");
  await mkdir(subDir, { recursive: true });
  const line = `${JSON.stringify({ isSidechain: true, message: { role: "assistant", content: SECRET } })}\n`;
  await writeFile(path.join(subDir, "agent-a1b2c3.jsonl"), line);
  await writeFile(path.join(subDir, "agent-a1b2c3.meta.json"), JSON.stringify({
    agentType: "Explore",
    description: `${SECRET} description`,
    toolUseId: "toolu_fake",
    spawnDepth: 1,
    model: "fake-model",
  }));
  await writeFile(path.join(subDir, "agent-d4e5f6.jsonl"), line + line);
  await writeFile(path.join(subDir, "agent-d4e5f6.meta.json"), JSON.stringify({
    agentType: "general-purpose",
    isFork: true,
    spawnDepth: 2,
    finished: true,
    parentAgentId: "a1b2c3",
    spawnedWithWorktree: true,
    worktreePath: "/tmp/fixture/sub-app/.claude/worktrees/x",
  }));
  await writeFile(path.join(subDir, "agent-nometa.jsonl"), line);
  await writeFile(path.join(subDir, "agent-a1b2c3.prefix.json"), "{}");
  await writeFile(path.join(subDir, "notes.txt"), SECRET);
  await mkdir(path.join(subDir, "workflows"));
  const outside = path.join(home, "outside.jsonl");
  await writeFile(outside, line);
  await symlink(outside, path.join(subDir, "agent-linked.jsonl"));
  const old = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-01-02T00:00:00Z");
  await utimes(path.join(subDir, "agent-a1b2c3.jsonl"), old, old);
  await utimes(path.join(subDir, "agent-d4e5f6.jsonl"), newer, newer);
  await utimes(path.join(subDir, "agent-nometa.jsonl"), old, old);
  return { home, root, transcript, subDir };
}

test("subagent transcripts become child rows from stats and meta only", async () => {
  const { home, root, transcript, subDir } = await seed();
  // The transcripts are unreadable, so a row can only come from stat and the meta sidecar.
  for (const name of ["agent-a1b2c3.jsonl", "agent-d4e5f6.jsonl", "agent-nometa.jsonl"]) await chmod(path.join(subDir, name), 0o000);
  try {
    const rows = await listSubSessions(root, transcript, PARENT as never, home);
    assert.deepEqual(rows.map((row) => row.agentId), ["d4e5f6", "a1b2c3", "nometa"]);
    const fork = rows[0]!;
    assert.deepEqual(fork, {
      agentId: "d4e5f6",
      parentSessionId: PARENT,
      agentType: "general-purpose",
      isFork: true,
      spawnDepth: 2,
      finished: true,
      parentAgentId: "a1b2c3",
      worktree: true,
      sizeBytes: fork.sizeBytes,
      lastActivity: "2026-01-02T00:00:00.000Z",
      hasMeta: true,
    });
    assert.ok(fork.sizeBytes > 0);
    const explore = rows[1]!;
    assert.equal(explore.agentType, "Explore");
    assert.equal(explore.isFork, false);
    assert.equal(explore.finished, null);
    assert.equal(explore.spawnDepth, 1);
    const bare = rows[2]!;
    assert.equal(bare.hasMeta, false);
    assert.equal(bare.agentType, null);
    const text = JSON.stringify(rows);
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes("fake-model"), false);
    assert.equal(text.includes("worktrees"), false);
  } finally {
    for (const name of ["agent-a1b2c3.jsonl", "agent-d4e5f6.jsonl", "agent-nometa.jsonl"]) await chmod(path.join(subDir, name), 0o644);
  }
});

test("list_sessions nests sub-session rows under the parent and get_session returns them all", async () => {
  const { home, root, subDir } = await seed();
  for (let i = 0; i < 25; i += 1) await writeFile(path.join(subDir, `agent-extra${String(i).padStart(2, "0")}.jsonl`), "{}\n");
  const config = configAt(home, root);
  const listed = await listSessions(config, {}, async () => []);
  const card = listed.sessions.find((item) => item.sessionId === PARENT);
  assert.ok(card);
  assert.equal(card.subSessionCount, 28);
  assert.equal(card.subSessions.length, 20);
  assert.equal(listed.sessions.some((item) => item.sessionId.includes("a1b2c3")), false);
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
  const detail = await getSession(config, { sessionId: PARENT }, async () => []);
  assert.equal(detail.card.subSessions.length, 28);
  assert.equal(detail.card.subSessionCount, 28);
  assert.equal(JSON.stringify(detail.card).includes(SECRET), false);
});

test("a session without a subagents folder, or with a symlinked one, has no child rows", async () => {
  const { home, root, transcript, subDir } = await seed();
  const { rename } = await import("node:fs/promises");
  const moved = path.join(home, "moved-subagents");
  await rename(subDir, moved);
  assert.deepEqual(await listSubSessions(root, transcript, PARENT as never, home), []);
  await symlink(moved, subDir);
  assert.deepEqual(await listSubSessions(root, transcript, PARENT as never, home), []);
});

test("agent ids and meta fields are validated", () => {
  assert.equal(agentIdOf("agent-abc123.jsonl"), "abc123");
  assert.equal(agentIdOf("agent-abc.meta.json"), null);
  assert.equal(agentIdOf("agent-../x.jsonl"), null);
  assert.equal(agentIdOf("agent-x.key.jsonl"), null);
  assert.equal(agentIdOf("child.jsonl"), null);
  assert.deepEqual(parseMeta('{"agentType":"bad\\ntype","spawnDepth":-1,"isFork":"yes","finished":"no","parentAgentId":"../x"}'), {
    agentType: null,
    isFork: false,
    spawnDepth: null,
    finished: null,
    parentAgentId: null,
    worktree: false,
  });
  assert.equal(parseMeta("[]"), null);
  assert.equal(parseMeta("nope"), null);
});
