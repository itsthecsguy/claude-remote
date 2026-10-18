import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { DeskError } from "./domain.js";
import { parseSessionId } from "./paths.js";

export type LaunchRecord = {
  recordId: string;
  cwd: string;
  startedAt: string;
  sessionId: string | null;
  claudePid: number | null;
} & (
  | { kind: "tmux"; tmuxTarget: string }
  | { kind: "terminal-app"; tmuxTarget: null }
  | { kind: "headless"; tmuxTarget: null }
);

export function launchesRoot(home: string): string {
  return path.join(path.resolve(home), ".claude-remote", "launches");
}

export async function writeLaunch(home: string, record: LaunchRecord): Promise<void> {
  const dir = await privateDir(home);
  const dest = path.join(dir, `${record.recordId}.json`);
  if (!parseSessionId(record.recordId)) throw new DeskError("denied", "launch path is not allowed");
  const tmp = path.join(dir, `.part-${process.pid}-${record.recordId}.tmp`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(record));
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(tmp, 0o600);
  await rename(tmp, dest);
  await chmod(dest, 0o600);
}

export async function readLaunches(home: string): Promise<LaunchRecord[]> {
  const dir = launchesRoot(home);
  let names: string[];
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
    names = await readdir(dir);
  } catch {
    return [];
  }
  const records: LaunchRecord[] = [];
  for (const name of names) {
    if (name.includes(".key") || !name.endsWith(".json") || name.startsWith(".")) continue;
    const file = path.join(dir, name);
    let info;
    try {
      info = await lstat(file);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const record = parseLaunch(text);
    if (record) records.push(record);
  }
  return records;
}

export async function removeLaunch(home: string, recordId: string): Promise<void> {
  if (!parseSessionId(recordId)) return;
  const file = path.join(launchesRoot(home), `${recordId}.json`);
  let info;
  try {
    info = await lstat(file);
  } catch {
    return;
  }
  if (info.isSymbolicLink() || !info.isFile()) return;
  await unlink(file);
}

function parseLaunch(text: string): LaunchRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as {
    recordId?: unknown;
    kind?: unknown;
    tmuxTarget?: unknown;
    cwd?: unknown;
    startedAt?: unknown;
    sessionId?: unknown;
    claudePid?: unknown;
  };
  if (typeof record.recordId !== "string" || !parseSessionId(record.recordId)) return null;
  if (typeof record.cwd !== "string" || record.cwd.length === 0) return null;
  if (typeof record.startedAt !== "string") return null;
  const sessionId = record.sessionId == null
    ? null
    : (typeof record.sessionId === "string" ? parseSessionId(record.sessionId) : null);
  if (record.sessionId != null && !sessionId) return null;
  const claudePid = typeof record.claudePid === "number" && Number.isInteger(record.claudePid) && record.claudePid > 0
    ? record.claudePid
    : null;
  if (record.kind === "tmux" && typeof record.tmuxTarget === "string" && safeTarget(record.tmuxTarget)) {
    return {
      recordId: record.recordId,
      kind: "tmux",
      tmuxTarget: record.tmuxTarget,
      cwd: record.cwd,
      startedAt: record.startedAt,
      sessionId,
      claudePid,
    };
  }
  if (record.kind === "headless" && record.tmuxTarget == null) {
    return {
      recordId: record.recordId,
      kind: "headless",
      tmuxTarget: null,
      cwd: record.cwd,
      startedAt: record.startedAt,
      sessionId,
      claudePid,
    };
  }
  if (record.kind === "terminal-app" && record.tmuxTarget == null) {
    return {
      recordId: record.recordId,
      kind: "terminal-app",
      tmuxTarget: null,
      cwd: record.cwd,
      startedAt: record.startedAt,
      sessionId,
      claudePid,
    };
  }
  return null;
}

export function freshRecordId(): string {
  return randomUUID();
}

export function safeTarget(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(value);
}

async function privateDir(home: string): Promise<string> {
  const root = path.resolve(home);
  const desk = path.join(root, ".claude-remote");
  const dir = path.join(desk, "launches");
  for (const current of [desk, dir]) {
    await mkdirOne(current);
    const real = await realpath(current);
    if (real !== path.resolve(current)) throw new DeskError("denied", "launch path is not allowed");
  }
  return dir;
}

async function mkdirOne(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new DeskError("denied", "launch path is not allowed");
    }
  } catch (error) {
    if (error instanceof DeskError) throw error;
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") throw error;
    await mkdir(dir, { mode: 0o700 });
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "launch path is not allowed");
  await chmod(dir, 0o700);
}
