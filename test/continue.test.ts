import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DESKTOP_VID, VID } from "../fixtures/ids.js";
import { continueCommandLine, shellQuote } from "../src/continue.js";
import { DeskError } from "../src/domain.js";
import type { ProcessIdentity } from "../src/registry.js";
import { continueCommand, listSessions } from "../src/tools.js";
import { configAt, fixtureConfig, tempDir, tempHome } from "./helpers.js";

const execFileAsync = promisify(execFile);

test("continue_command quotes a weird cwd and does not run it", async () => {
  const { home, root } = await tempHome();
  const cwd = "/tmp/odd dir/it's \"quoted\"";
  const id = await writeSession(root, cwd);
  const config = { ...configAt(home, root), claudeBin: "claude" };
  const result = await continueCommand(config, { sessionId: id }, async () => []);
  assert.equal(result.command, continueCommandLine("claude", cwd, id));
  assert.equal(result.command, `cd ${shellQuote(cwd)} && claude --resume ${id} --dangerously-load-development-channels server:claude-remote-channel`);
  assert.equal(result.command.includes("local_"), false);
  assert.equal(result.worktreeLaunch, null);
  assert.equal(result.liveOwner, "none");
  assert.equal(result.warning, null);
  await assert.rejects(() => stat(path.join(cwd, "fake-claude-record.json")));
});

test("continue_command on a joined fixture uses the transcript id and the worktree folder", async () => {
  const config = { ...fixtureConfig(), claudeBin: "claude" };
  const result = await continueCommand(config, { sessionId: VID }, async () => []);
  assert.equal(result.sessionId, VID);
  assert.equal(result.cwd, "/tmp/fixture/demo-app/.claude/worktrees/audio");
  assert.equal(result.command.includes("local_"), false);
  assert.equal(result.command.includes(DESKTOP_VID), false);
  assert.equal(result.command.includes(`--resume ${VID}`), true);
  assert.equal(result.liveOwner, "none");
  assert.equal(result.warning, null);
  await assert.rejects(
    () => continueCommand(config, { sessionId: DESKTOP_VID }, async () => []),
    (error: unknown) => error instanceof DeskError && error.code === "not-uuid",
  );
});

test("a desktop entrypoint warns to stop the desktop session, and a terminal entrypoint warns too", async () => {
  const project = await tempDir("claude-remote-cont-");
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, project, id);
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100", entrypoint: "claude-desktop" });
  const identity = async (pid: number): Promise<ProcessIdentity> => {
    if (pid === 4242) return { alive: true, startToken: "100" };
    return { alive: false };
  };
  const desktop = await continueCommand(configAt(home, root), { sessionId: id }, async () => [], identity);
  const listed = await listSessions(configAt(home, root), {}, async () => [], identity);
  const card = listed.sessions.find((session) => session.sessionId === id);
  assert.equal(card?.command, desktop.command);
  assert.equal(card?.warning, desktop.warning);
  assert.equal(desktop.liveOwner, "desktop");
  assert.equal(desktop.warning, "Stop this session in the desktop app before you run this command. Two writers must not resume the same transcript.");
  assert.equal(desktop.command.includes("local_"), false);
  assert.equal(desktop.command.includes(`--resume ${id}`), true);
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));

  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100", entrypoint: "cli" });
  const terminal = await continueCommand(configAt(home, root), { sessionId: id }, async () => [], identity);
  assert.equal(terminal.liveOwner, "terminal");
  assert.match(terminal.warning ?? "", /Stop the terminal process/);

  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100", entrypoint: "claude-vscode" });
  const other = await continueCommand(configAt(home, root), { sessionId: id }, async () => [`claude --resume ${id}`], identity);
  assert.equal(other.liveOwner, "unknown");
  assert.match(other.warning ?? "", /Stop the live process/);
});

test("a process command line names the live owner when no entrypoint is recorded", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, "/tmp/fixture/plain", id);
  const terminal = await continueCommand(
    configAt(home, root),
    { sessionId: id },
    async () => [`claude --resume ${id}`],
  );
  assert.equal(terminal.liveOwner, "terminal");
  assert.match(terminal.warning ?? "", /Stop the terminal process/);

  const desktop = await continueCommand(
    configAt(home, root),
    { sessionId: id },
    async () => [`/Applications/Claude.app/Contents/MacOS/claude --resume ${id}`],
  );
  assert.equal(desktop.liveOwner, "desktop");
  assert.match(desktop.warning ?? "", /Stop this session in the desktop app/);
});

test("an unverified live pid warns without naming a desktop or terminal owner", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, "/tmp/fixture/plain", id);
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100", entrypoint: "claude-desktop" });
  const identity = async (): Promise<ProcessIdentity> => ({ alive: true });
  const result = await continueCommand(
    configAt(home, root),
    { sessionId: id },
    async () => [`claude --resume ${id}`],
    identity,
  );
  assert.equal(result.liveOwner, "unknown");
  assert.match(result.warning ?? "", /Stop the live process/);
});

test("a linked worktree command uses the main checkout, and a claude worktree stays put", async () => {
  const repo = await tempDir("claude-remote-repo-");
  await git(repo, ["init"]);
  await git(repo, ["commit", "--allow-empty", "-m", "init"]);
  const linked = path.join(tmpdir(), `claude-remote-linked-${process.pid}-${Date.now()}`);
  await git(repo, ["worktree", "add", "-b", "wt", linked]);
  const { home, root } = await tempHome();
  const linkedId = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, linked, linkedId);
  const config = { ...configAt(home, root), claudeBin: "claude" };
  const linkedResult = await continueCommand(config, { sessionId: linkedId }, async () => []);
  assert.equal(linkedResult.worktreeLaunch, "main-checkout");
  assert.equal(linkedResult.cwd, await realpath(repo));
  assert.equal(linkedResult.command, continueCommandLine("claude", linkedResult.cwd, linkedId));
  assert.equal(linkedResult.command.includes("local_"), false);
  await assert.rejects(() => stat(path.join(repo, "fake-claude-record.json")));

  const managed = path.join(repo, ".claude", "worktrees", "audio");
  await mkdir(managed, { recursive: true });
  const managedId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeSession(root, managed, managedId);
  const managedResult = await continueCommand(config, { sessionId: managedId }, async () => []);
  assert.equal(managedResult.worktreeLaunch, "project");
  assert.equal(managedResult.cwd, await realpath(managed));
  assert.equal(managedResult.command, continueCommandLine("claude", managedResult.cwd, managedId));
});

test("a path that looks like a claude worktree but points at a linked worktree uses the main checkout", async () => {
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
  const result = await continueCommand({ ...configAt(home, root), claudeBin: "claude" }, { sessionId: id }, async () => []);
  assert.equal(result.worktreeLaunch, "main-checkout");
  assert.equal(result.cwd, await realpath(repo));
});

test("continue_command does not read a sibling key file", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  await writeSession(root, "/tmp/fixture/plain", id);
  await writeRecord(root, 4242, { pid: 4242, sessionId: id, procStart: "100", entrypoint: "cli" });
  const key = path.join(root, "sessions", "4242.abc123.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  const identity = async (pid: number): Promise<ProcessIdentity> => {
    if (pid === 4242) return { alive: true, startToken: "100" };
    return { alive: false };
  };
  const result = await continueCommand(configAt(home, root), { sessionId: id }, async () => [], identity);
  assert.equal(result.liveOwner, "terminal");
  assert.equal(JSON.stringify(result).includes("SECRET-KEY-BODY"), false);
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
});

test("a sidebar title wins, and a cli-only session keeps the transcript title and cwd", async () => {
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  const cliId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeSession(root, "/tmp/transcript/cwd", id, "Transcript title");
  await writeSession(root, "/tmp/cli/only", cliId);
  const desktop = path.join(home, "desktop", "acct", "org");
  await mkdir(desktop, { recursive: true });
  await writeFile(path.join(desktop, "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc.json"), JSON.stringify({
    cliSessionId: id,
    sessionId: "local_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    title: "Sidebar title",
    cwd: "-tmp-encoded-slug",
    worktreePath: "/tmp/real/worktree",
  }));
  const listed = await listSessions(configAt(home, root, { desktop: path.join(home, "desktop") }), {}, async () => []);
  const joined = listed.sessions.find((session) => session.sessionId === id);
  const cli = listed.sessions.find((session) => session.sessionId === cliId);
  assert.ok(joined);
  assert.ok(cli);
  assert.equal(joined.title, "Sidebar title");
  assert.equal(joined.projectName, "cwd");
  assert.equal(joined.cwd, "/tmp/real/worktree");
  assert.equal(joined.inDesktopSidebar, true);
  assert.equal(joined.liveOwner, "none");
  assert.equal(cli.inDesktopSidebar, false);
  assert.equal(cli.title, "closed prompt");
  assert.equal(cli.projectName, "only");
  assert.equal(cli.cwd, "/tmp/cli/only");
  assert.equal(cli.liveOwner, "none");
  assert.equal(JSON.stringify(listed).includes("local_cccccccc"), true);
  assert.equal(JSON.stringify(listed).includes("hello session"), false);
});

async function writeRecord(root: string, pid: number, body: unknown): Promise<void> {
  const dir = path.join(root, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${pid}.json`), JSON.stringify(body));
}

async function writeSession(root: string, cwd: string, id = "abcdefab-cdef-4def-8aaa-abcdefabcdef", title?: string): Promise<string> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const user = "a1111111-1111-4111-8111-111111111101";
  const assistant = "a1111111-1111-4111-8111-111111111102";
  const lines = [
    title ? JSON.stringify({ type: "custom-title", customTitle: title, sessionId: id }) : "",
    JSON.stringify({
      type: "user",
      uuid: user,
      parentUuid: null,
      sessionId: id,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd,
      message: { role: "user", content: "closed prompt" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: assistant,
      parentUuid: user,
      sessionId: id,
      timestamp: "2024-01-01T00:00:01.000Z",
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "closed reply" }] },
    }),
  ].filter((line) => line.length > 0);
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
