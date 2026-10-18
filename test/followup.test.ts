import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { VID } from "../fixtures/ids.js";
import { DeskError } from "../src/domain.js";
import { FORBIDDEN_FLAGS } from "../src/followup.js";
import type { FollowupOutcome } from "../src/queue.js";
import { queueDirectory } from "../src/queue.js";
import { sendFollowup } from "../src/tools.js";
import { configAt, shimPath, tempDir, tempHome } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("send stays off unless the flag is set, and confirm must be true", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await assert.rejects(
    () => sendFollowup(configAt(home, root), { sessionId: id, message: "hello", confirm: true }),
    (error: unknown) => error instanceof DeskError && error.code === "send-disabled",
  );
  await assert.rejects(
    () => sendFollowup(configAt(home, root, { allowSend: true }), { sessionId: id, message: "hello", confirm: false }),
    (error: unknown) => error instanceof DeskError && error.code === "confirm-required",
  );
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
});

test("a confirmed one-line message is positional, and a leading dash uses stdin", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  const first = asSent(await sendFollowup(config, { sessionId: id, message: "hello", confirm: true }));
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as {
    argv: string[];
    stdin: string;
    cwd: string;
  };
  assert.deepEqual(record.argv, ["-p", "--resume", id, "--output-format", "stream-json", "--verbose", "hello"]);
  assert.equal(record.stdin, "");
  assert.equal(await realpath(record.cwd), await realpath(project));
  assert.equal(first.displayedInDesktop, false);
  assert.equal("attachments" in first, false);
  assert.equal(first.notice.includes("outside the desktop window"), true);
  assert.equal(first.result, "shim-ok");
  assert.equal(first.sessionId, id);
  for (const flag of FORBIDDEN_FLAGS) assert.equal(record.argv.includes(flag), false);

  const second = asSent(await sendFollowup(config, { sessionId: id, message: "-show\nnext", confirm: true }));
  const again = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as {
    argv: string[];
    stdin: string;
  };
  assert.deepEqual(again.argv, ["-p", "--resume", id, "--output-format", "stream-json", "--verbose"]);
  assert.equal(again.stdin, "-show\nnext");
  assert.equal(second.exitCode, 0);
});

test("the shim exits 2 when a harness appends a permission-bypass flag", async () => {
  for (const flag of FORBIDDEN_FLAGS) {
    const result = await execFileAsync(process.execPath, [shimPath, "-p", "--resume", VID, flag], { timeout: 5000 }).then(
      () => ({ code: 0 }),
      (error: unknown) => {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        return { code: typeof code === "number" ? code : 1 };
      },
    );
    assert.equal(result.code, 2, flag);
  }
});

test("send times out and the shim process is gone", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeFile(path.join(project, "fake-claude-sleep-ms"), "5000");
  const started = Date.now();
  await assert.rejects(
    () => sendFollowup(configAt(home, root, { allowSend: true, timeoutMs: 200 }), {
      sessionId: id,
      message: "hello",
      confirm: true,
    }),
    (error: unknown) => error instanceof DeskError && error.code === "timeout",
  );
  assert.equal(Date.now() - started < 3000, true);
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as {
    finished: boolean;
    pid: number;
  };
  assert.equal(record.finished, false);
  assert.equal(alive(record.pid), false);
  const names = await readdir(queueDirectory(home, id));
  const ticketName = names.find((name) => name.endsWith(".json"));
  assert.ok(ticketName);
  const ticket = JSON.parse(await readFile(path.join(queueDirectory(home, id), ticketName), "utf8")) as { state: string };
  assert.equal(ticket.state, "failed");
});

test("a linked worktree spawns in the main checkout, and a claude worktree stays put", async () => {
  const repo = await tempDir("claude-remote-repo-");
  await git(repo, ["init"]);
  await git(repo, ["commit", "--allow-empty", "-m", "init"]);
  const linked = path.join(tmpdir(), `claude-remote-linked-${process.pid}-${Date.now()}`);
  await git(repo, ["worktree", "add", "-b", "wt", linked]);
  const { home, root } = await tempHome();
  const linkedId = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, linked, linkedId);
  const linkedResult = asSent(await sendFollowup(configAt(home, root, { allowSend: true }), {
    sessionId: linkedId,
    message: "hello",
    confirm: true,
  }));
  const linkedRecord = JSON.parse(await readFile(path.join(repo, "fake-claude-record.json"), "utf8")) as { cwd: string };
  assert.equal(await realpath(linkedRecord.cwd), await realpath(repo));
  assert.equal(linkedResult.worktreeLaunch, "main-checkout");

  const managed = path.join(repo, ".claude", "worktrees", "audio");
  await mkdir(managed, { recursive: true });
  const managedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeSession(root, managed, managedId);
  const managedResult = asSent(await sendFollowup(configAt(home, root, { allowSend: true }), {
    sessionId: managedId,
    message: "hello",
    confirm: true,
  }));
  const managedRecord = JSON.parse(await readFile(path.join(managed, "fake-claude-record.json"), "utf8")) as { cwd: string };
  assert.equal(await realpath(managedRecord.cwd), await realpath(managed));
  assert.equal(managedResult.worktreeLaunch, "project");
});

test("a path that looks like a claude worktree but points at a linked worktree spawns in the main checkout", async () => {
  const repo = await tempDir("claude-remote-repo-");
  await git(repo, ["init"]);
  await git(repo, ["commit", "--allow-empty", "-m", "init"]);
  const linked = path.join(tmpdir(), `claude-remote-linked-${process.pid}-${Date.now()}`);
  await git(repo, ["worktree", "add", "-b", "wt", linked]);
  const decoyParent = await tempDir("claude-remote-decoy-");
  const decoy = path.join(decoyParent, ".claude", "worktrees", "audio");
  await mkdir(path.dirname(decoy), { recursive: true });
  await symlink(linked, decoy);
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, decoy, id);
  const result = asSent(await sendFollowup(configAt(home, root, { allowSend: true }), {
    sessionId: id,
    message: "hello",
    confirm: true,
  }));
  const record = JSON.parse(await readFile(path.join(repo, "fake-claude-record.json"), "utf8")) as { cwd: string };
  assert.equal(await realpath(record.cwd), await realpath(repo));
  assert.equal(result.worktreeLaunch, "main-checkout");
});

test("a symlink into a claude worktree stays in that directory", async () => {
  const repo = await tempDir("claude-remote-repo-");
  await git(repo, ["init"]);
  await git(repo, ["commit", "--allow-empty", "-m", "init"]);
  const managed = path.join(repo, ".claude", "worktrees", "audio");
  await mkdir(managed, { recursive: true });
  const outside = await tempDir("claude-remote-outside-");
  const link = path.join(outside, "audio");
  await symlink(managed, link);
  const { home, root } = await tempHome();
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeSession(root, link, id);
  const result = asSent(await sendFollowup(configAt(home, root, { allowSend: true }), {
    sessionId: id,
    message: "hello",
    confirm: true,
  }));
  const record = JSON.parse(await readFile(path.join(managed, "fake-claude-record.json"), "utf8")) as { cwd: string };
  assert.equal(await realpath(record.cwd), await realpath(managed));
  assert.equal(result.worktreeLaunch, "project");
});

test("a symlinked project directory spawns in the physical directory", async () => {
  const physical = await tempDir("claude-remote-proj-");
  const parent = await tempDir("claude-remote-link-");
  const link = path.join(parent, "project");
  await symlink(physical, link);
  const { home, root } = await tempHome();
  const id = await writeSession(root, link);
  const result = asSent(await sendFollowup(configAt(home, root, { allowSend: true }), {
    sessionId: id,
    message: "hello",
    confirm: true,
  }));
  const record = JSON.parse(await readFile(path.join(link, "fake-claude-record.json"), "utf8")) as { cwd: string };
  assert.equal(record.cwd, physical);
  assert.equal(result.worktreeLaunch, "project");
});

test("send is refused when the session directory does not exist", async () => {
  const { home, root } = await tempHome();
  const missing = path.join(tmpdir(), `claude-remote-missing-${process.pid}-${Date.now()}`);
  const id = await writeSession(root, missing);
  await assert.rejects(
    () => sendFollowup(configAt(home, root, { allowSend: true }), { sessionId: id, message: "hello", confirm: true }),
    (error: unknown) => error instanceof DeskError && error.code === "missing-cwd",
  );
  await assert.rejects(() => stat(path.join(missing, "fake-claude-record.json")));
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

async function git(cwd: string, args: string[]): Promise<void> {
  const home = await mkdtemp(path.join(tmpdir(), "claude-remote-git-home-"));
  await execFileAsync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "user.name=dev", "-c", "user.email=dev@example.com", ...args],
    {
      cwd,
      env: {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "dev",
        GIT_AUTHOR_EMAIL: "dev@example.com",
        GIT_COMMITTER_NAME: "dev",
        GIT_COMMITTER_EMAIL: "dev@example.com",
      },
    },
  );
}

function asSent(outcome: FollowupOutcome): Extract<FollowupOutcome, { disposition: "sent" }> {
  assert.equal(outcome.disposition, "sent");
  if (outcome.disposition !== "sent") throw new Error("expected sent");
  return outcome;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
