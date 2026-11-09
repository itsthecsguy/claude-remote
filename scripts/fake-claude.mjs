#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { argv, cwd, exit, stdin } from "node:process";

const forbidden = [
  "--dangerously-skip-permissions",
  "--permission-mode",
  "--allow-dangerously-skip-permissions",
  "--allowedTools",
  "--disallowedTools",
  "--permission-prompts",
  "--bare",
  "--fork-session",
  "--no-session-persistence",
  "--session-id",
  "--desktop",
  "--bg",
  "--model",
  "--settings",
];

const scriptIndex = argv.findIndex((arg) => arg.endsWith("fake-claude.mjs"));
const args = scriptIndex >= 0 ? argv.slice(scriptIndex + 1) : argv.slice(1);
const FAST_MODE_SETTINGS = '{"fastMode":true}';
// --settings is allowed only with the exact fast-mode value that new_session passes.
// A deliver worker (only tool SendMessage) may also pass --no-session-persistence.
const deliverWorker = args.includes("--tools") && args[args.indexOf("--tools") + 1] === "SendMessage";
const flagged = args.filter((arg, index) => !(arg === "--settings" && args[index + 1] === FAST_MODE_SETTINGS)
  && !(deliverWorker && arg === "--no-session-persistence"));
if (flagged.some((arg) => forbidden.includes(arg))) exit(2);

// `agents --json --all` prints the file named by CLAUDE_REMOTE_FAKE_AGENTS. Without it the shim
// behaves like an older CLI that has no agents subcommand.
if (args[0] === "agents") {
  const file = process.env.CLAUDE_REMOTE_FAKE_AGENTS;
  if (!file) {
    process.stderr.write("error: unknown command 'agents'\n");
    exit(1);
  }
  process.stdout.write(readFileSync(file, "utf8"));
  exit(0);
}

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const stdinText = Buffer.concat(chunks).toString("utf8");
const dir = cwd();
const recordPath = path.join(dir, "fake-claude-record.json");
// Only whether the long-lived login reached the child is recorded, never the value.
const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN ? "set" : "unset";
appendFileSync(path.join(dir, "fake-claude-log.jsonl"), `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
writeFileSync(recordPath, JSON.stringify({ argv: args, stdin: stdinText, cwd: dir, pid: process.pid, finished: false, oauth }));

const streaming = args.includes("stream-json");
const resumeAtStart = args.indexOf("--resume");
const initSession = resumeAtStart >= 0 ? args[resumeAtStart + 1] ?? "" : (process.env.FAKE_CLAUDE_SESSION ?? "");
const fastAt = args.indexOf("--settings");
if (streaming && initSession) {
  process.stdout.write(`${JSON.stringify({
    type: "system",
    subtype: "init",
    session_id: initSession,
    fast_mode_state: fastAt >= 0 && args[fastAt + 1] === FAST_MODE_SETTINGS ? "on" : "off",
  })}\n`);
}

if (args.includes("--environment")) {
  process.stdout.write(`${JSON.stringify({ ok: true, session_id: "session_01FakeCloudSession", url: "https://claude.ai/code/session_01FakeCloudSession" })}\n`);
  exit(0);
}

let sleepMs = 0;
try {
  sleepMs = Number(readFileSync(path.join(dir, "fake-claude-sleep-ms"), "utf8"));
} catch {
  sleepMs = 0;
}
if (Number.isFinite(sleepMs) && sleepMs > 0) {
  await new Promise((resolve) => {
    setTimeout(resolve, sleepMs);
  });
}

writeFileSync(recordPath, JSON.stringify({ argv: args, stdin: stdinText, cwd: dir, pid: process.pid, finished: true, oauth }));
const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] ?? "" : "";
// fake-claude-noise-bytes: print that many bytes of stream records before the result, as a long
// run does. fake-claude-result.json: extra fields for the result record (is_error, num_turns,
// permission_denials, result). fake-claude-exit-code: the exit status.
let noise = 0;
try {
  noise = Number(readFileSync(path.join(dir, "fake-claude-noise-bytes"), "utf8"));
} catch {
  noise = 0;
}
const line = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "n".repeat(8000) }] } })}\n`;
for (let sent = 0; Number.isFinite(noise) && sent < noise; sent += line.length) {
  if (!process.stdout.write(line)) await new Promise((resolve) => process.stdout.once("drain", resolve));
}
let extra = {};
try {
  extra = JSON.parse(readFileSync(path.join(dir, "fake-claude-result.json"), "utf8"));
} catch {
  extra = {};
}
let code = 0;
try {
  code = Number(readFileSync(path.join(dir, "fake-claude-exit-code"), "utf8")) || 0;
} catch {
  code = 0;
}
process.stdout.write(`${JSON.stringify({ type: "result", result: "shim-ok", session_id: sessionId || initSession, ...extra })}\n`, () => exit(code));
