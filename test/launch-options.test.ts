import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DeskError } from "../src/domain.js";
import { FORBIDDEN_FLAGS } from "../src/followup.js";
import { startNew, stopLaunched, type ExecResult } from "../src/launch.js";
import {
  FAST_MODE_SETTINGS,
  assertNoBypass,
  cloudArgs,
  initFromLine,
  launchMode,
  localLaunchFlags,
  parseCloudJson,
  parseCloudPane,
  parseLaunchOptions,
} from "../src/launch-options.js";
import { readLaunches } from "../src/launches.js";
import { terminalArgs } from "../src/terminal.js";
import { captureError, configAt, tempHome } from "./helpers.js";

const NEW_ID = "bcbcbcbc-bcbc-4bcb-8bcb-bcbcbcbcbcbc";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DeskError) return error.code;
    throw error;
  }
  return "ok";
}

test("worktree, fastMode, cloud, environment, and prompt are validated", () => {
  assert.deepEqual(parseLaunchOptions({}), { worktree: null, fastMode: false, cloud: null, environment: null, prompt: null });
  assert.equal(parseLaunchOptions({ worktree: true }).worktree, true);
  assert.equal(parseLaunchOptions({ worktree: false }).worktree, null);
  assert.equal(parseLaunchOptions({ worktree: "feature-auth_2.1" }).worktree, "feature-auth_2.1");
  for (const bad of ["../up", "-rf", "a/b", "#12", "x; rm -rf ~", "$(id)", "a b", "", "x".repeat(65), "a..b"]) {
    assert.equal(code(() => parseLaunchOptions({ worktree: bad })), "bad-option", bad);
  }
  assert.equal(code(() => parseLaunchOptions({ fastMode: "yes" })), "bad-option");
  assert.equal(parseLaunchOptions({ cloud: "  Fix the login bug  " }).cloud, "Fix the login bug");
  for (const bad of ["-p", "--dangerously-skip-permissions", "session_01abc", "cse_01abc", "https://claude.ai/code/session_01abc", "a\nb", "a\u0007b", "", "   ", "x".repeat(2001)]) {
    assert.equal(code(() => parseLaunchOptions({ cloud: bad })), "bad-option", JSON.stringify(bad));
  }
  assert.equal(parseLaunchOptions({ cloud: "Run tests", environment: "ccpool_abc123" }).environment, "ccpool_abc123");
  for (const bad of ["ccpool_", "pool_abc", "ccpool_abc;id", "ccpool_abc def", "--environment"]) {
    assert.equal(code(() => parseLaunchOptions({ cloud: "x", environment: bad })), "bad-option", bad);
  }
  assert.equal(code(() => parseLaunchOptions({ environment: "ccpool_abc" })), "bad-option");
  assert.equal(code(() => parseLaunchOptions({ cloud: "x", fastMode: true })), "bad-option");
  assert.equal(code(() => parseLaunchOptions({ cloud: "x", worktree: true })), "bad-option");
  assert.equal(code(() => parseLaunchOptions({ cloud: "x", prompt: "y" })), "bad-option");
  assert.equal(code(() => parseLaunchOptions({ prompt: "a\u0000b" })), "bad-option");
  assert.equal(parseLaunchOptions({ prompt: "line one\nline two" }).prompt, "line one\nline two");
  assert.equal(launchMode(parseLaunchOptions({})), "interactive");
  assert.equal(launchMode(parseLaunchOptions({ prompt: "x" })), "headless");
  assert.equal(launchMode(parseLaunchOptions({ cloud: "x" })), "cloud");
  assert.equal(launchMode(parseLaunchOptions({ cloud: "x", environment: "ccpool_a" })), "environment");
});

test("launch flags match the documented spellings and fast mode is opt-in", () => {
  assert.deepEqual(localLaunchFlags(parseLaunchOptions({})), []);
  assert.deepEqual(localLaunchFlags(parseLaunchOptions({ worktree: true })), ["--worktree"]);
  assert.deepEqual(localLaunchFlags(parseLaunchOptions({ worktree: "fix-1", fastMode: true })), ["--worktree", "fix-1", "--settings", '{"fastMode":true}']);
  assert.equal(FAST_MODE_SETTINGS, '{"fastMode":true}');
  assert.deepEqual(cloudArgs(parseLaunchOptions({ cloud: "Fix the login bug" })), ["--cloud", "Fix the login bug"]);
  assert.deepEqual(cloudArgs(parseLaunchOptions({ cloud: "Run tests", environment: "ccpool_abc" })), ["-p", "Run tests", "--environment", "ccpool_abc", "--output-format", "json"]);
});

test("only the fast-mode settings value gets past the bypass check", () => {
  assert.doesNotThrow(() => assertNoBypass(["--settings", FAST_MODE_SETTINGS], FORBIDDEN_FLAGS));
  assert.throws(() => assertNoBypass(["--settings", '{"permissions":{"defaultMode":"bypassPermissions"}}'], FORBIDDEN_FLAGS), /settings value/);
  assert.throws(() => assertNoBypass(["--settings", '{"fastMode":true,"x":1}'], FORBIDDEN_FLAGS), /settings value/);
  assert.throws(() => assertNoBypass(["--settings"], FORBIDDEN_FLAGS), /settings value/);
  assert.throws(() => assertNoBypass([`--settings=${FAST_MODE_SETTINGS}`], FORBIDDEN_FLAGS), /bypass/);
  assert.throws(() => assertNoBypass(["--dangerously-skip-permissions"], FORBIDDEN_FLAGS), /bypass/);
  assert.throws(() => assertNoBypass(["--permission-mode=bypassPermissions"], FORBIDDEN_FLAGS), /bypass/);
  assert.throws(() => assertNoBypass(["--allow-dangerously-skip-permissions"], FORBIDDEN_FLAGS), /bypass/);
  const args = terminalArgs("claude", null, { addDir: "/a", mcpConfig: "/m" }, ["--worktree", "w1", "--settings", FAST_MODE_SETTINGS]);
  assert.deepEqual(args.slice(6, 10), ["--worktree", "w1", "--settings", FAST_MODE_SETTINGS]);
  assert.equal(args.includes("--dangerously-skip-permissions"), false);
  assert.throws(() => terminalArgs("claude", null, { addDir: "/a", mcpConfig: "/m" }, ["--settings", "{}"]), /settings value/);
});

test("init, cloud JSON, and cloud pane parsing keep only validated fields", () => {
  assert.deepEqual(initFromLine(JSON.stringify({ type: "system", subtype: "init", session_id: NEW_ID.toUpperCase(), fast_mode_state: "cooldown", fast_mode_disabled_reason: "rate_limited", cwd: "/x" })), {
    sessionId: NEW_ID,
    fastModeState: "cooldown",
    fastModeDisabledReason: "rate_limited",
  });
  assert.deepEqual(initFromLine(JSON.stringify({ type: "system", subtype: "init", session_id: "x", fast_mode_state: "warp" })), { sessionId: null, fastModeState: null, fastModeDisabledReason: null });
  assert.equal(initFromLine(JSON.stringify({ type: "system", subtype: "hook_started" })), null);
  assert.equal(initFromLine("not json"), null);
  assert.deepEqual(parseCloudJson('{"ok":true,"session_id":"session_01Abcdef","title":"t","url":"https://claude.ai/code/session_01Abcdef"}\n'), {
    ok: true,
    cloudSessionId: "session_01Abcdef",
    url: "https://claude.ai/code/session_01Abcdef",
  });
  assert.deepEqual(parseCloudJson('{"ok":true,"session_id":"session_01Abcdef","url":"https://evil.example/x"}'), { ok: true, cloudSessionId: "session_01Abcdef", url: null });
  assert.deepEqual(parseCloudJson('{"ok":false,"error":"nope"}'), { ok: false, code: "cloud-create-failed" });
  assert.deepEqual(parseCloudJson("Error: cloud sessions are unavailable"), { ok: false, code: "cloud-unparsed" });
  assert.deepEqual(parseCloudPane("Sent to cloud session.\nSession ID: session_01DiUkqY2k\nView: https://claude.ai/code/session_01DiUkqY2k?from=cli&m=0\n"), {
    cloudSessionId: "session_01DiUkqY2k",
    url: "https://claude.ai/code/session_01DiUkqY2k?from=cli&m=0",
  });
  assert.equal(parseCloudPane("Cloning repository..."), null);
});

function fakeTmux(root: string, pane = "", pid = 6262, sessionId = NEW_ID) {
  const calls: string[][] = [];
  return {
    calls,
    io: {
      probeTmux: async () => true,
      runTmux: async (_bin: string, args: string[]): Promise<ExecResult> => {
        calls.push(args);
        if (args[0] === "has-session") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "new-session") {
          await mkdir(path.join(root, "sessions"), { recursive: true });
          await writeFile(path.join(root, "sessions", `${pid}.json`), JSON.stringify({ pid, sessionId, procStart: "1", entrypoint: "cli" }));
        }
        if (args[0] === "list-panes") return { code: 0, stdout: `${pid}\n`, stderr: "" };
        if (args[0] === "capture-pane") return { code: 0, stdout: pane, stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("an interactive launch passes --worktree and the fast-mode settings as separate argv entries", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const config = { ...configAt(home, root), allowLaunch: true, launchWaitMs: 300 };
  const tmux = fakeTmux(root);
  const started = await startNew(config, { folder, tmuxName: "wt1", acceptDevChannelPrompt: false, options: { worktree: "fix-login", fastMode: true } }, tmux.io);
  assert.equal(started.sessionId, NEW_ID);
  assert.equal(started.worktree, "fix-login");
  assert.deepEqual(started.fastMode, { requested: true, state: null, disabledReason: null, source: "no-init-event" });
  const created = tmux.calls.find((args) => args[0] === "new-session") ?? [];
  const cmd = created.slice(created.indexOf("--") + 1);
  assert.deepEqual(cmd.slice(cmd.indexOf("--worktree"), cmd.indexOf("--worktree") + 4), ["--worktree", "fix-login", "--settings", FAST_MODE_SETTINGS]);
  for (const flag of ["--dangerously-skip-permissions", "--permission-mode", "--allow-dangerously-skip-permissions"]) assert.equal(cmd.includes(flag), false);

  const plain = fakeTmux(root, "", 6263, "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd");
  const quiet = await startNew(config, { folder, tmuxName: "wt2", acceptDevChannelPrompt: false }, plain.io);
  assert.deepEqual(quiet.fastMode, { requested: false, state: null, disabledReason: null, source: "not-requested" });
  const plainCmd = plain.calls.find((args) => args[0] === "new-session") ?? [];
  assert.equal(plainCmd.includes("--settings"), false);
  assert.equal(plainCmd.includes("--worktree"), false);

  await assert.rejects(startNew(config, { folder, acceptDevChannelPrompt: false, options: { worktree: "x; touch pwned" } }, plain.io), /worktree name/);
});

test("a headless launch reports fast_mode_state from the init event and can be stopped", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const config = { ...configAt(home, root), allowLaunch: true, launchWaitMs: 5000 };
  const previous = process.env.FAKE_CLAUDE_SESSION;
  process.env.FAKE_CLAUDE_SESSION = NEW_ID;
  try {
    const logs = await captureError(async () => {
      const off = await startNew(config, { folder, acceptDevChannelPrompt: false, options: { prompt: "PROMPT-SECRET say ok" } });
      assert.equal(off.kind, "headless");
      assert.equal(off.sessionId, NEW_ID);
      assert.deepEqual(off.fastMode, { requested: false, state: "off", disabledReason: null, source: "init-event" });
    });
    assert.equal(logs.includes("PROMPT-SECRET"), false);
    await waitFor(async () => JSON.parse(await readFile(path.join(folder, "fake-claude-record.json"), "utf8")).finished === true);
    const record = JSON.parse(await readFile(path.join(folder, "fake-claude-record.json"), "utf8")) as { argv: string[]; stdin: string };
    assert.equal(record.stdin, "PROMPT-SECRET say ok");
    assert.equal(record.argv.includes("PROMPT-SECRET say ok"), false);
    assert.deepEqual(record.argv.slice(0, 4), ["-p", "--output-format", "stream-json", "--verbose"]);

    await writeFile(path.join(folder, "fake-claude-sleep-ms"), "5000");
    const on = await startNew(config, { folder, acceptDevChannelPrompt: false, options: { prompt: "hi", fastMode: true, worktree: true } });
    assert.deepEqual(on.fastMode, { requested: true, state: "on", disabledReason: null, source: "init-event" });
    const argv = (JSON.parse(await readFile(path.join(folder, "fake-claude-record.json"), "utf8")) as { argv: string[] }).argv;
    assert.equal(argv.includes("--worktree"), true);
    assert.deepEqual(argv.slice(argv.indexOf("--settings"), argv.indexOf("--settings") + 2), ["--settings", FAST_MODE_SETTINGS]);
    assert.equal((await readLaunches(home)).some((item) => item.kind === "headless" && item.sessionId === NEW_ID), true);
    const stopped = await stopLaunched(config, { sessionId: NEW_ID });
    assert.equal(stopped.stopped, "killed");
    assert.equal((await readLaunches(home)).some((item) => item.kind === "headless"), false);
  } finally {
    if (previous == null) delete process.env.FAKE_CLAUDE_SESSION;
    else process.env.FAKE_CLAUDE_SESSION = previous;
  }
});

test("a cloud launch runs --cloud in tmux and reads the session id back", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const config = { ...configAt(home, root), allowLaunch: true, launchWaitMs: 300 };
  const tmux = fakeTmux(root, "Sent to cloud session.\nSession ID: session_01FakeAbcd\nView: https://claude.ai/code/session_01FakeAbcd?from=cli\n");
  const desc = "Fix the bug; $(touch pwned) `id` && echo hi";
  const started = await startNew(config, { folder, tmuxName: "cloud1", acceptDevChannelPrompt: false, options: { cloud: desc } }, tmux.io);
  assert.equal(started.kind, "cloud");
  assert.equal(started.cloudSessionId, "session_01FakeAbcd");
  assert.equal(started.cloudUrl, "https://claude.ai/code/session_01FakeAbcd?from=cli");
  const created = tmux.calls.find((args) => args[0] === "new-session") ?? [];
  assert.deepEqual(created.slice(created.indexOf("--") + 1), [config.claudeBin, "--cloud", desc]);
  assert.equal(tmux.calls.some((args) => args[0] === "set-option" && args.includes("remain-on-exit")), true);
});

test("an environment launch uses -p with --environment and parses the JSON result", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const config = { ...configAt(home, root), allowLaunch: true };
  const started = await startNew(config, { folder, acceptDevChannelPrompt: false, options: { cloud: "Run the smoke test", environment: "ccpool_test123" } });
  assert.equal(started.kind, "cloud");
  assert.equal(started.cloudSessionId, "session_01FakeCloudSession");
  const record = JSON.parse(await readFile(path.join(folder, "fake-claude-record.json"), "utf8")) as { argv: string[] };
  assert.deepEqual(record.argv, ["-p", "Run the smoke test", "--environment", "ccpool_test123", "--output-format", "json"]);
});

test("launch options need the launch gate", async () => {
  const { home, root } = await tempHome();
  await assert.rejects(startNew(configAt(home, root), { folder: home, acceptDevChannelPrompt: false, options: { fastMode: true } }), /launch is disabled/);
});

async function waitFor(check: () => Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}
