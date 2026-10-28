import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { homedir } from "node:os";
import { runBoundedNode } from "./bounded.js";
import type { WorktreeLaunch } from "./domain.js";
import { DeskError } from "./domain.js";

const MAX_STDOUT = 2_000_000;

export const DESKTOP_NOTICE =
  "A resumed run happens in this subprocess, outside the desktop window, and it is not documented to appear live there.";

export const FORBIDDEN_FLAGS = [
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
] as const;

export function followupInvocation(sessionId: string, message: string): { args: string[]; stdin: string | null } {
  const useStdin = message.startsWith("-") || message.includes("\n");
  const args = ["-p", "--resume", sessionId, "--output-format", "stream-json", "--verbose"];
  if (!useStdin) args.push(message);
  for (const arg of args) {
    if ((FORBIDDEN_FLAGS as readonly string[]).includes(arg)) {
      throw new DeskError("denied", "refusing a permission-bypass flag");
    }
  }
  return { args, stdin: useStdin ? message : null };
}

const PROTECTED_FOLDERS = ["Desktop", "Documents", "Downloads"] as const;
const CWD_PROBE_MS = 2500;

const CWD_PROBE_SOURCE = `
const { spawnSync } = require("node:child_process");
const { realpathSync, statSync } = require("node:fs");
const path = require("node:path");
const projectPath = process.argv[1];
function physical(file) {
  try {
    return realpathSync(file);
  } catch (error) {
    return path.resolve(file);
  }
}
function underClaudeWorktree(folder) {
  const parts = folder.split(path.sep);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (parts[i] === ".claude" && parts[i + 1] === "worktrees") return true;
  }
  return false;
}
function gitOutput(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    timeout: 1500,
    killSignal: "SIGKILL",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error("git failed");
    error.code = result.status;
    throw error;
  }
  return String(result.stdout || "").trim();
}
function send(payload) {
  process.stdout.write(JSON.stringify(payload));
}
let info;
try {
  info = statSync(projectPath);
} catch (error) {
  send({ ok: false, code: "missing-cwd" });
  process.exit(0);
}
if (!info.isDirectory()) {
  send({ ok: false, code: "missing-cwd" });
  process.exit(0);
}
const canonical = physical(projectPath);
if (underClaudeWorktree(canonical)) {
  send({ ok: true, cwd: canonical, worktreeLaunch: "project" });
  process.exit(0);
}
try {
  const inside = gitOutput(canonical, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") {
    send({ ok: true, cwd: canonical, worktreeLaunch: "project" });
    process.exit(0);
  }
  const gitDir = gitOutput(canonical, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const common = gitOutput(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (physical(gitDir) === physical(common)) {
    send({ ok: true, cwd: canonical, worktreeLaunch: "project" });
    process.exit(0);
  }
  const mainLexical = common.endsWith(path.sep + ".git") ? path.dirname(common) : common;
  send({ ok: true, cwd: physical(mainLexical), worktreeLaunch: "main-checkout" });
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "ENOENT") send({ ok: true, cwd: canonical, worktreeLaunch: "unchecked" });
  else send({ ok: true, cwd: canonical, worktreeLaunch: "project" });
}
`;

export function skipsFolderProbe(folder: string, home: string): boolean {
  if (folder.includes("\0")) return true;
  const resolved = path.resolve(folder);
  const root = path.resolve(home);
  const roots = [
    ...PROTECTED_FOLDERS.map((name) => path.join(root, name)),
    path.join(root, "Library", "Mobile Documents"),
    path.join(root, "Library", "CloudStorage"),
  ];
  return roots.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));
}

export async function resolveSpawnCwd(
  projectPath: string,
  home: string = homedir(),
): Promise<{ cwd: string; worktreeLaunch: WorktreeLaunch }> {
  if (skipsFolderProbe(projectPath, home)) return { cwd: projectPath, worktreeLaunch: "unchecked" };
  let text = "";
  try {
    text = await runBoundedNode(CWD_PROBE_SOURCE, projectPath, CWD_PROBE_MS);
  } catch {
    return { cwd: path.resolve(projectPath), worktreeLaunch: "unchecked" };
  }
  const parsed = parseProbe(text);
  if (!parsed) return { cwd: path.resolve(projectPath), worktreeLaunch: "unchecked" };
  if (!parsed.ok) throw new DeskError("missing-cwd", "session directory does not exist");
  return { cwd: parsed.cwd, worktreeLaunch: parsed.worktreeLaunch };
}

function parseProbe(text: string): { ok: true; cwd: string; worktreeLaunch: WorktreeLaunch } | { ok: false } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { ok?: unknown; cwd?: unknown; worktreeLaunch?: unknown };
  if (record.ok === false) return { ok: false };
  if (record.ok !== true) return null;
  if (typeof record.cwd !== "string" || record.cwd.length === 0 || record.cwd.includes("\0")) return null;
  switch (record.worktreeLaunch) {
    case "project":
    case "main-checkout":
    case "unchecked":
      return { ok: true, cwd: record.cwd, worktreeLaunch: record.worktreeLaunch };
    default:
      return null;
  }
}

export async function spawnClaude(input: {
  bin: string;
  args: string[];
  stdin: string | null;
  cwd: string;
  timeoutMs: number;
  redact: string;
  onChild?: (pid: number) => Promise<void>;
  /** The child environment, normally from claudeChildEnv so the setup-token login is available. */
  env?: NodeJS.ProcessEnv;
}): Promise<{ result: string; exitCode: number; sessionId: string | null }> {
  const child = spawn(input.bin, input.args, {
    cwd: input.cwd,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: input.env,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new DeskError("spawn-failed", "failed to spawn claude");
  }
  const stdoutChunks: Buffer[] = [];
  let stdoutLen = 0;
  let tooLarge = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutLen += chunk.length;
    if (stdoutLen > MAX_STDOUT) {
      tooLarge = true;
      killGroup(child.pid);
      return;
    }
    stdoutChunks.push(chunk);
  });
  const stderrChunks: Buffer[] = [];
  let stderrLen = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrLen >= 4000) return;
    stderrChunks.push(chunk);
    stderrLen += chunk.length;
  });
  if (input.onChild && child.pid != null) {
    try {
      await input.onChild(child.pid);
    } catch (error) {
      killGroup(child.pid);
      await waitExit(child, 1000);
      throw error;
    }
  }
  if (input.stdin == null) child.stdin.end();
  else child.stdin.end(input.stdin);

  const outcome = await new Promise<{ code: number; timedOut: boolean; spawnError: NodeJS.ErrnoException | null }>((resolve) => {
    let settled = false;
    const finish = (value: { code: number; timedOut: boolean; spawnError: NodeJS.ErrnoException | null }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      killGroup(child.pid);
      finish({ code: -1, timedOut: true, spawnError: null });
    }, input.timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: 127, timedOut: false, spawnError: error });
    });
    child.on("exit", (code) => {
      finish({ code: code ?? 1, timedOut: false, spawnError: null });
    });
  });

  if (outcome.timedOut) {
    await waitExit(child, 1000);
    throw new DeskError("timeout", "send timed out");
  }
  if (tooLarge) throw new DeskError("too-large", "claude output exceeded the capture limit");
  if (outcome.spawnError) {
    if (outcome.spawnError.code === "ENOENT") throw new DeskError("spawn-failed", "claude binary not found");
    throw new DeskError("spawn-failed", "failed to spawn claude");
  }
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  let stderr = Buffer.concat(stderrChunks).toString("utf8").slice(0, 500);
  if (input.redact.length > 0) stderr = stderr.split(input.redact).join("[message]");
  const parsed = parseStream(stdout);
  const result = parsed.result.length > 0 ? parsed.result : stderr.trim();
  return { result, exitCode: outcome.code, sessionId: parsed.sessionId };
}

function parseStream(stdout: string): { result: string; sessionId: string | null } {
  let result = "";
  let sessionId: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const msg: unknown = JSON.parse(line);
      if (!msg || typeof msg !== "object") continue;
      const record = msg as { type?: unknown; result?: unknown; session_id?: unknown };
      if (typeof record.session_id === "string") sessionId = record.session_id;
      if (record.type === "result" && typeof record.result === "string") result = record.result;
    } catch {
      continue;
    }
  }
  return { result, sessionId };
}

function killGroup(pid: number | undefined): void {
  if (pid == null) return;
  // Detached children lead their own process group, so the signal does not hit the server.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process has already exited.
    }
  }
}

function waitExit(child: ChildProcess, ms: number): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
