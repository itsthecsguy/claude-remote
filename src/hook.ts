import { lstat, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

/**
 * `claude-remote hook`: the command Claude Code runs for the hook events `install` registers.
 *
 * It reads the hook JSON from stdin and POSTs it to the local helper on 127.0.0.1 with the bearer
 * token from ~/.claude-remote/http/token. It fails open: when the helper is down, slow, or anything
 * goes wrong, it exits 0 with no output (no decision) so Claude Code carries on as if the hook did
 * not exist. Registration has a hard budget of about two seconds.
 *
 * For a PermissionRequest, or a PreToolUse on AskUserQuestion, the helper can ask the hook to wait
 * for a remote answer. The hook then long-polls in short slices until the helper's deadline and
 * prints a decision only if one arrives. A remote permission answer is only ever
 * {"behavior":"allow"} or {"behavior":"deny","message":...}: no rules, no mode, no input changes.
 *
 * Nothing from stdin is written to disk, stderr, or any log.
 */

export const HOOK_EVENTS = [
  "Notification",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

export const REGISTER_TIMEOUT_MS = 1500;
export const WATCHDOG_MS = 2500;
export const MAX_WAIT_MS = 600_000;
const SLICE_MS = 25_000;
const MAX_STDIN = 1024 * 1024;
const MAX_RESPONSE = 256 * 1024;
const DEFAULT_PORT = 47321;
const TOKEN_RE = /^[A-Za-z0-9_-]{43,256}$/;

export type Poster = (port: number, pathname: string, token: string, body: unknown, timeoutMs: number) => Promise<unknown | null>;

export type HookIo = {
  stdinText: string;
  home: string;
  env: NodeJS.ProcessEnv;
  post?: Poster;
  now?: () => number;
  onWait?: (deadlineMs: number) => void;
};

export async function runHook(io: HookIo): Promise<string> {
  const now = io.now ?? Date.now;
  const post = io.post ?? postJson;
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(io.stdinText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    input = parsed as Record<string, unknown>;
  } catch {
    return "";
  }
  const event = input.hook_event_name;
  if (typeof event !== "string" || !(HOOK_EVENTS as readonly string[]).includes(event)) return "";
  const token = await readSmall(path.join(io.home, ".claude-remote", "http", "token"));
  if (!token || !TOKEN_RE.test(token)) return "";
  const port = await resolvePort(io.home, io.env);
  const registered = await post(port, "/hook/event", token, input, REGISTER_TIMEOUT_MS);
  if (!registered || typeof registered !== "object") return "";
  const reply = registered as { requestId?: unknown; wait?: unknown; waitMs?: unknown };
  if (reply.wait !== true || typeof reply.requestId !== "string") return "";
  const waitMs = typeof reply.waitMs === "number" && Number.isFinite(reply.waitMs) ? Math.min(Math.max(reply.waitMs, 0), MAX_WAIT_MS) : 0;
  const deadline = now() + waitMs;
  io.onWait?.(deadline);
  while (true) {
    const remaining = deadline - now();
    if (remaining <= 0) return "";
    const slice = Math.min(SLICE_MS, remaining);
    const result = await post(port, "/hook/wait", token, { requestId: reply.requestId, sliceMs: slice }, slice + 3000);
    if (!result || typeof result !== "object") return "";
    const state = (result as { state?: unknown }).state;
    if (state === "pending") continue;
    if (state !== "decided") return "";
    return decisionOutput(input, (result as { decision?: unknown }).decision);
  }
}

/** Turn a helper decision into hook stdout. Anything unexpected becomes no decision. */
export function decisionOutput(input: Record<string, unknown>, decision: unknown): string {
  if (!decision || typeof decision !== "object") return "";
  const { kind, answer } = decision as { kind?: unknown; answer?: unknown };
  if (!answer || typeof answer !== "object") return "";
  if (input.hook_event_name === "PermissionRequest" && kind === "permission") {
    const { behavior, message } = answer as { behavior?: unknown; message?: unknown };
    if (behavior === "allow") {
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
    }
    if (behavior === "deny") {
      const out: { behavior: "deny"; message?: string } = { behavior: "deny" };
      if (typeof message === "string" && message.length > 0) out.message = message.slice(0, 2000);
      return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: out } });
    }
    return "";
  }
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "AskUserQuestion" && kind === "question") {
    const toolInput = input.tool_input;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";
    const questions = (toolInput as { questions?: unknown }).questions;
    if (!Array.isArray(questions)) return "";
    const texts = new Set(questions.flatMap((q) => q && typeof q === "object" && typeof (q as { question?: unknown }).question === "string" ? [(q as { question: string }).question] : []));
    const raw = (answer as { answers?: unknown }).answers;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (!texts.has(key) || typeof value !== "string" || value.length === 0) return "";
      answers[key] = value.slice(0, 2000);
    }
    if (Object.keys(answers).length === 0) return "";
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...(toolInput as Record<string, unknown>), answers },
      },
    });
  }
  return "";
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > 1024) return null;
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

async function resolvePort(home: string, env: NodeJS.ProcessEnv): Promise<number> {
  const candidates = [env.CLAUDE_REMOTE_HTTP_PORT, await readSmall(path.join(home, ".claude-remote", "http", "port"))];
  for (const raw of candidates) {
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) return parsed;
  }
  return DEFAULT_PORT;
}

export const postJson: Poster = (port, pathname, token, body, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  const finish = (value: unknown | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  const payload = Buffer.from(JSON.stringify(body));
  const req = http.request({
    host: "127.0.0.1",
    port,
    path: pathname,
    method: "POST",
    agent: false,
    headers: {
      host: `127.0.0.1:${port}`,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-length": payload.length,
    },
  }, (res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_RESPONSE) {
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (res.statusCode !== 200) return finish(null);
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        finish(null);
      }
    });
    res.on("error", () => finish(null));
  });
  const timer = setTimeout(() => {
    req.destroy();
    finish(null);
  }, timeoutMs);
  req.on("error", () => finish(null));
  req.end(payload);
});

function readStdin(limitMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.pause();
      resolve(size > MAX_STDIN ? "" : Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, limitMs);
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_STDIN) chunks.push(chunk);
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

export async function hookMain(): Promise<void> {
  let watchdog = setTimeout(() => process.exit(0), WATCHDOG_MS);
  let out = "";
  try {
    const stdinText = await readStdin(1000);
    out = await runHook({
      stdinText,
      home: os.homedir(),
      env: process.env,
      onWait: (deadlineMs) => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => process.exit(0), Math.max(0, deadlineMs - Date.now()) + 5000);
      },
    });
  } catch {
    out = "";
  }
  clearTimeout(watchdog);
  if (out) {
    process.stdout.write(`${out}\n`, () => process.exit(0));
    return;
  }
  process.exit(0);
}
