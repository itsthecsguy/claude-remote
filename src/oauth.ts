import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { logEvent } from "./log.js";

/**
 * A long-lived Claude Code login for the helper's headless `claude` children.
 *
 * The helper runs from launchd. Its `claude -p` children use the login that `/login` saved, and
 * when that login reaches the end of its life, or cannot be renewed from a background process,
 * every headless call fails until someone signs in again at the keyboard. The Claude Code docs
 * name `claude setup-token` for exactly this case: it prints a one-year OAuth token that the CLI
 * reads from CLAUDE_CODE_OAUTH_TOKEN. This module reads that token from a 0600 file at spawn time
 * and puts it in the child's environment only. It never goes in a plist, a log, or a status line.
 */

export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";

const MIN_TOKEN_CHARS = 20;
const MAX_TOKEN_BYTES = 8192;
/** setup-token prints a one-year token; status warns at this age so the file is replaced in time. */
export const OAUTH_TOKEN_WARN_AGE_DAYS = 330;

export function oauthTokenPath(home: string, env?: NodeJS.ProcessEnv): string {
  const override = env?.CLAUDE_REMOTE_OAUTH_TOKEN_FILE;
  if (override && override.length > 0) return path.resolve(override);
  return path.join(path.resolve(home), ".config", "claude-remote", "oauth-token");
}

export type OauthTokenState = "present" | "missing" | "bad-mode" | "symlink" | "not-a-file" | "empty" | "bad-shape";

export type OauthTokenReport = {
  path: string;
  state: OauthTokenState;
  /** Octal mode such as "0600", or null when the file is missing. */
  mode: string | null;
  /** Whole days since the file was last written, so status can warn before the one-year token ends. */
  ageDays: number | null;
  /** True only for a regular 0600 file whose single line looks like a token. */
  usable: boolean;
};

/** Describe the token file without returning any of its contents. */
export async function inspectOauthToken(file: string, nowMs = Date.now()): Promise<OauthTokenReport> {
  const base = { path: file, mode: null, ageDays: null, usable: false };
  let info;
  try {
    info = await lstat(file);
  } catch {
    return { ...base, state: "missing" };
  }
  if (info.isSymbolicLink()) return { ...base, state: "symlink" };
  if (!info.isFile()) return { ...base, state: "not-a-file" };
  const mode = `0${(info.mode & 0o777).toString(8).padStart(3, "0")}`;
  const ageDays = Math.max(0, Math.floor((nowMs - info.mtimeMs) / 86_400_000));
  const described = { ...base, mode, ageDays };
  if ((info.mode & 0o077) !== 0) return { ...described, state: "bad-mode" };
  const token = await readLine(file);
  if (token === null || token.length === 0) return { ...described, state: "empty" };
  if (!tokenShape(token)) return { ...described, state: "bad-shape" };
  return { ...described, state: "present", usable: true };
}

/** The token itself, or null unless the file is usable. Callers must never log the result. */
export async function readOauthToken(file: string): Promise<string | null> {
  const report = await inspectOauthToken(file);
  if (!report.usable) return null;
  return readLine(file);
}

const reported = new Set<string>();

/**
 * The environment for a headless `claude` child: the parent's environment plus the token from the
 * file when it is usable. An explicit CLAUDE_CODE_OAUTH_TOKEN in the parent environment wins, so a
 * foreground `http` run can still be pointed at another token. A problem with the file is logged
 * once per process, as its state only.
 */
export async function claudeChildEnv(
  config: { oauthTokenFile: string },
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  if (base[OAUTH_TOKEN_ENV]) return base;
  const report = await inspectOauthToken(config.oauthTokenFile);
  if (report.state === "missing") return base;
  if (!report.usable) {
    noteOnce(`ignored-${report.state}`);
    return base;
  }
  const token = await readLine(config.oauthTokenFile);
  if (!token) return base;
  noteOnce("file-used");
  return { ...base, [OAUTH_TOKEN_ENV]: token };
}

function noteOnce(code: string): void {
  if (reported.has(code)) return;
  reported.add(code);
  logEvent({ tool: "oauth-token", code });
}

function tokenShape(token: string): boolean {
  return token.length >= MIN_TOKEN_CHARS && /^[\x21-\x7e]+$/.test(token);
}

async function readLine(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(MAX_TOKEN_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_TOKEN_BYTES) return null;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const line = text.split(/\r?\n/)[0] ?? "";
    return line.trim();
  } finally {
    await handle.close();
  }
}
