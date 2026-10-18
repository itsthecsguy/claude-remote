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
if (args.some((arg) => forbidden.includes(arg))) exit(2);

const chunks = [];
for await (const chunk of stdin) chunks.push(chunk);
const stdinText = Buffer.concat(chunks).toString("utf8");
const dir = cwd();
const recordPath = path.join(dir, "fake-claude-record.json");
appendFileSync(path.join(dir, "fake-claude-log.jsonl"), `${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`);
writeFileSync(recordPath, JSON.stringify({ argv: args, stdin: stdinText, cwd: dir, pid: process.pid, finished: false }));

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

writeFileSync(recordPath, JSON.stringify({ argv: args, stdin: stdinText, cwd: dir, pid: process.pid, finished: true }));
const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] ?? "" : "";
process.stdout.write(`${JSON.stringify({ type: "result", result: "shim-ok", session_id: sessionId })}\n`);
