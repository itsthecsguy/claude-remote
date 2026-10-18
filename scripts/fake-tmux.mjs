#!/usr/bin/env node
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dir = process.env.FAKE_TMUX_DIR;
if (!dir) {
  process.stderr.write("FAKE_TMUX_DIR missing\n");
  process.exit(2);
}

const args = process.argv.slice(2);
await mkdir(dir, { recursive: true });
await appendFile(path.join(dir, "log.jsonl"), `${JSON.stringify(args)}\n`);

const sessionsFile = path.join(dir, "sessions.json");

function flag(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  return args[index + 1];
}

async function load() {
  try {
    return JSON.parse(await readFile(sessionsFile, "utf8"));
  } catch {
    return {};
  }
}

async function save(sessions) {
  await writeFile(sessionsFile, JSON.stringify(sessions));
}

if (args.includes("-V")) {
  process.stdout.write("tmux 3.4\n");
  process.exit(0);
}

if (args[0] === "new-session") {
  const name = flag("-s");
  const cwd = flag("-c");
  const split = args.indexOf("--");
  const cmd = split >= 0 ? args.slice(split + 1) : [];
  const pid = Number(process.env.FAKE_TMUX_PID ?? "0");
  const sessions = await load();
  sessions[name] = { cwd, cmd, pid, alive: true };
  await save(sessions);
  const recordDir = process.env.FAKE_TMUX_RECORD_DIR;
  const sessionId = process.env.FAKE_TMUX_SESSION;
  if (recordDir && sessionId && pid > 0) {
    const folder = path.join(recordDir, "sessions");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${pid}.json`), JSON.stringify({
      pid,
      sessionId,
      procStart: "1",
      status: "idle",
      entrypoint: "cli",
    }));
  }
  process.exit(0);
}

if (args[0] === "list-panes") {
  const sessions = await load();
  const session = sessions[flag("-t")];
  if (!session?.alive) process.exit(1);
  process.stdout.write(`${session.pid}\n`);
  process.exit(0);
}

if (args[0] === "capture-pane") {
  try {
    process.stdout.write(await readFile(path.join(dir, "pane.txt"), "utf8"));
  } catch {
    process.stdout.write("");
  }
  process.exit(0);
}

if (args[0] === "send-keys" || args[0] === "kill-session") {
  if (args[0] === "kill-session") {
    const sessions = await load();
    const name = flag("-t");
    if (sessions[name]) sessions[name].alive = false;
    await save(sessions);
  }
  process.exit(0);
}

if (args[0] === "set-option") {
  process.exit(0);
}

if (args[0] === "has-session") {
  const sessions = await load();
  const session = sessions[flag("-t")];
  process.exit(session?.alive ? 0 : 1);
}

process.stderr.write("unknown tmux command\n");
process.exit(1);
