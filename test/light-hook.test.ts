import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parseConfig, type Config } from "../src/config.js";
import { decisionOutput } from "../src/hook.js";
import { hookScriptPath, renderHookScript, writeHookScript } from "../src/hook-script.js";
import { HOOK_MARKER } from "../src/hook-settings.js";
import { listenHttp, type HttpListener } from "../src/http.js";
import { executeInstall, executeUninstall, type InstallHooks, type InstallInput } from "../src/install.js";
import { answerPermission, answerQuestion, pendingStore } from "../src/pending.js";
import { mintToken, writeToken } from "../src/token.js";
import { tempHome } from "./helpers.js";

const curl = whichCurl();
const skip = curl ? false : "curl is not installed";

function whichCurl(): string | null {
  try {
    return execFileSync("/bin/sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

function permission(session: string, command = "npm publish"): Record<string, unknown> {
  return { session_id: session, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command, description: "Publish" } };
}

function question(session: string): Record<string, unknown> {
  return {
    session_id: session,
    hook_event_name: "PreToolUse",
    tool_name: "AskUserQuestion",
    tool_use_id: "toolu_light1",
    tool_input: { questions: [{ question: "Ship it?", header: "Ship", multiSelect: false, options: [{ label: "Yes", description: "y" }, { label: "No", description: "n" }] }] },
  };
}

type Run = { code: number | null; stdout: string; ms: number };

function runScript(script: string, input: unknown, env: NodeJS.ProcessEnv): Promise<Run> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", [script, HOOK_MARKER], { env });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", () => undefined);
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
  });
}

async function fixture(patch: Partial<Config> = {}): Promise<{ home: string; token: string; listener: HttpListener; config: Config; script: string; env: NodeJS.ProcessEnv }> {
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const config = { ...parseConfig({ CLAUDE_CONFIG_DIR: root, CLAUDE_REMOTE_ALLOW_APPROVE: "1" }, { home, platform: "linux" }), ...patch };
  const listener = await listenHttp(config, 0);
  const stub = path.join(home, "stub-entry.mjs");
  await writeFile(stub, "process.stdout.write(`fallback ${process.argv.slice(2).join(' ')}\\n`);\n");
  const script = await writeHookScript(home, process.execPath, stub);
  return { home, token, listener, config, script, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", CLAUDE_REMOTE_HTTP_PORT: String(listener.port) } };
}

async function answerable(session: string): Promise<string> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const entry = pendingStore.list({ sessionId: session }).find((item) => item.answerable);
    if (entry) return entry.requestId;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no answerable entry");
}

test("the script is valid sh, quotes its paths, and holds no token", { skip }, async () => {
  const text = renderHookScript({ stateDir: "/tmp/it's here/http", nodeBin: "/opt/node bin/node", entry: "/opt/x/dist/index.js" });
  assert.match(text, /STATE='\/tmp\/it'\\''s here\/http'/);
  const { home } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const script = await writeHookScript(home, "/usr/bin/node", "/opt/x/dist/index.js");
  assert.equal(script, hookScriptPath(home));
  assert.equal((await stat(script)).mode & 0o777, 0o700);
  assert.equal((await readFile(script, "utf8")).includes(token), false);
  execFileSync("/bin/sh", ["-n", script]);
});

test("the sh hook prints exactly what the Node hook prints for allow, deny, and a question", { skip }, async () => {
  const { listener, config, script, env } = await fixture();
  const session = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  try {
    const allowInput = permission(session);
    const allowRun = runScript(script, allowInput, env);
    await answerPermission(config, { sessionId: session, requestId: await answerable(session), decision: "allow", confirm: true });
    const allow = await allowRun;
    assert.equal(allow.code, 0);
    assert.equal(allow.stdout, `${decisionOutput(allowInput, { kind: "permission", answer: { behavior: "allow" } })}\n`);

    const denyInput = permission(session, "rm -rf dist");
    const denyRun = runScript(script, denyInput, env);
    await answerPermission(config, { sessionId: session, requestId: await answerable(session), decision: "deny", message: "use \"npm pack\" first", confirm: true });
    const deny = await denyRun;
    assert.equal(deny.stdout, `${decisionOutput(denyInput, { kind: "permission", answer: { behavior: "deny", message: "use \"npm pack\" first" } })}\n`);

    const askInput = question(session);
    const askRun = runScript(script, askInput, env);
    await answerQuestion(config, { sessionId: session, requestId: await answerable(session), answers: { "Ship it?": "Yes" }, confirm: true });
    const ask = await askRun;
    assert.equal(ask.stdout, `${decisionOutput(askInput, { kind: "question", answer: { answers: { "Ship it?": "Yes" } } })}\n`);
    assert.deepEqual(JSON.parse(ask.stdout).hookSpecificOutput.updatedInput.answers, { "Ship it?": "Yes" });

    const note = await runScript(script, { session_id: session, hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting" }, env);
    assert.equal(note.code, 0);
    assert.equal(note.stdout, "");
    assert.equal(pendingStore.list({ sessionId: session }).find((entry) => entry.kind === "notification")?.text, "Claude is waiting");
  } finally {
    pendingStore.record({ session_id: session, hook_event_name: "SessionEnd" }, { allowApprove: false, waitMs: 0 });
    await listener.close();
  }
});

test("the sh hook fails open: helper down, no token, bad input, or no answer in time", { skip }, async () => {
  const { home, listener, script, env } = await fixture({ approveTimeoutMs: 2000 });
  const session = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2";
  try {
    const timedOut = await runScript(script, permission(session), env);
    assert.equal(timedOut.code, 0);
    assert.equal(timedOut.stdout, "");
    assert.ok(timedOut.ms >= 1500 && timedOut.ms < 6000, `took ${timedOut.ms}ms`);
    const junk = await runScript(script, "not json", env);
    assert.equal(junk.code, 0);
    assert.equal(junk.stdout, "");
  } finally {
    pendingStore.record({ session_id: session, hook_event_name: "SessionEnd" }, { allowApprove: false, waitMs: 0 });
    await listener.close();
  }
  const down = await runScript(script, permission(session), env);
  assert.equal(down.code, 0);
  assert.equal(down.stdout, "");
  assert.ok(down.ms < 1500, `helper down took ${down.ms}ms`);
  await writeFile(path.join(home, ".claude-remote", "http", "token"), "short\n");
  const badToken = await runScript(script, permission(session), env);
  assert.equal(badToken.code, 0);
  assert.equal(badToken.stdout, "");
});

test("the token never appears in a process argument list", { skip }, async () => {
  const { home, token, listener, script, env } = await fixture();
  const spy = path.join(home, "spy");
  await mkdir(spy);
  const log = path.join(home, "argv.log");
  await writeFile(path.join(spy, "curl"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nexec '${curl}' "$@"\n`);
  await chmod(path.join(spy, "curl"), 0o755);
  const session = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
  try {
    const run = await runScript(script, { session_id: session, hook_event_name: "Notification", message: "hi" }, { ...env, PATH: `${spy}:${env.PATH}` });
    assert.equal(run.code, 0);
    const argv = await readFile(log, "utf8");
    assert.match(argv, /\/dev\/fd\/3/);
    assert.equal(argv.includes(token), false);
    assert.equal(pendingStore.list({ sessionId: session }).length, 1, "the event still reached the helper");
  } finally {
    pendingStore.record({ session_id: session, hook_event_name: "SessionEnd" }, { allowApprove: false, waitMs: 0 });
    await listener.close();
  }
});

test("without curl the script runs the Node hook", async () => {
  const { home } = await tempHome();
  await writeToken(home, mintToken());
  const stub = path.join(home, "stub-entry.mjs");
  await writeFile(stub, "process.stdout.write(`fallback ${process.argv.slice(2).join(' ')}\\n`);\n");
  const script = await writeHookScript(home, process.execPath, stub);
  const run = await runScript(script, { hook_event_name: "Stop" }, { PATH: path.join(home, "empty-path") });
  assert.equal(run.code, 0);
  assert.equal(run.stdout, `fallback hook ${HOOK_MARKER}\n`);
});

test("install points the hooks at the script, stays idempotent, and uninstall removes both", async () => {
  const { home } = await tempHome();
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  await chmod(launchAgents, 0o755);
  const configRoot = path.join(home, "cfg");
  const first = await executeInstall(installInput(home, configRoot), fakeRun());
  const script = hookScriptPath(home);
  assert.equal(first.hookScript, script);
  assert.equal((await stat(script)).mode & 0o777, 0o700);
  const settings = JSON.parse(await readFile(path.join(configRoot, "settings.json"), "utf8"));
  for (const groups of Object.values(settings.hooks) as Array<Array<{ hooks: Array<{ command: string; args: string[] }> }>>) {
    assert.equal(groups.length, 1);
    assert.equal(groups[0]!.hooks[0]!.command, "/bin/sh");
    assert.deepEqual(groups[0]!.hooks[0]!.args, [script, HOOK_MARKER]);
  }
  const second = await executeInstall(installInput(home, configRoot), fakeRun());
  assert.equal(second.hooks?.changed, false);
  await executeUninstall({ home, uid: 501, dryRun: false, purge: false, launchctlBin: "/fake/launchctl", claudeBin: "/fake/claude", configRoot }, fakeRun());
  await assert.rejects(() => stat(script));
  const after = JSON.parse(await readFile(path.join(configRoot, "settings.json"), "utf8"));
  assert.equal(after.hooks, undefined);
});

function installInput(home: string, configRoot: string): InstallInput {
  return {
    home,
    platform: "darwin",
    uid: 501,
    port: 47321,
    allowSend: false,
    allowLaunch: false,
    dryRun: false,
    nodeBin: "/usr/bin/node",
    entry: "/opt/claude-remote/dist/index.js",
    cloudflaredBin: "/fake/cloudflared",
    cloudflaredPresent: true,
    brewBin: "/fake/brew",
    launchctlBin: "/fake/launchctl",
    claudeBin: "/fake/claude",
    urlWaitMs: 0,
    configRoot,
  };
}

function fakeRun(): InstallHooks {
  return { build: async () => undefined, run: async () => ({ code: 0, stdout: "", stderr: "" }) };
}
