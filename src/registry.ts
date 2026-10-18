import { execFile } from "node:child_process";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { EntrypointOwner, SessionId, SessionRegistry } from "./domain.js";
import { DeskError, assertNever } from "./domain.js";
import { allowSessionRecord, parseSessionId, sessionRecordName } from "./paths.js";

const execFileAsync = promisify(execFile);

const MAX_RECORD_BYTES = 65_536;
const START_SKEW_MS = 2000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

export type ProcessIdentity = {
  alive: boolean;
  startToken?: string;
  state?: string;
};

export type ProcessIdentityLookup = (pid: number) => Promise<ProcessIdentity>;

export type LiveRecord = {
  sessionId: SessionId;
  cwd: string | null;
  entrypoint: EntrypointOwner;
  mtimeMs: number;
};

export async function loadSessionRegistry(
  configRoot: string,
  home: string,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<SessionRegistry> {
  const read = await readRegistry(configRoot, home, identity);
  if (read.status !== "checked") return { status: read.status };
  return { status: "checked", live: read.live, unverified: read.unverified, owners: read.owners };
}

export async function loadLiveRecords(
  configRoot: string,
  home: string,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<LiveRecord[]> {
  const read = await readRegistry(configRoot, home, identity);
  return read.records;
}

async function readRegistry(
  configRoot: string,
  home: string,
  identity: ProcessIdentityLookup,
): Promise<{
  status: "missing" | "unreadable" | "checked";
  live: SessionId[];
  unverified: SessionId[];
  owners: Record<string, EntrypointOwner>;
  records: LiveRecord[];
}> {
  const dir = path.join(configRoot, "sessions");
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") return { status: "missing", live: [], unverified: [], owners: {}, records: [] };
    return { status: "unreadable", live: [], unverified: [], owners: {}, records: [] };
  }
  if (!info.isDirectory()) return { status: "unreadable", live: [], unverified: [], owners: {}, records: [] };
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { status: "unreadable", live: [], unverified: [], owners: {}, records: [] };
  }
  const live: SessionId[] = [];
  const unverified: SessionId[] = [];
  const owners: Record<string, EntrypointOwner> = {};
  const records: LiveRecord[] = [];
  for (const name of names) {
    if (sessionRecordName(name) !== "pid-json") continue;
    const lexical = path.join(dir, name);
    let real: string;
    try {
      real = await allowSessionRecord(configRoot, lexical, home);
    } catch (error) {
      if (error instanceof DeskError) continue;
      throw error;
    }
    const verdict = await verdictFor(real, name, identity);
    if (verdict.kind === "skip") continue;
    if (verdict.kind === "live") {
      live.push(verdict.sessionId);
      owners[verdict.sessionId] = preferOwner(owners[verdict.sessionId], verdict.entrypoint);
      records.push({
        sessionId: verdict.sessionId,
        cwd: verdict.cwd,
        entrypoint: verdict.entrypoint,
        mtimeMs: verdict.mtimeMs,
      });
    } else {
      unverified.push(verdict.sessionId);
    }
  }
  return { status: "checked", live, unverified, owners, records };
}

export async function sessionRecordKeys(file: string): Promise<string[] | null> {
  if (sessionRecordName(path.basename(file)) !== "pid-json") return null;
  let text: string | null;
  try {
    text = await readBounded(file);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Object.keys(parsed).sort();
  } catch {
    return null;
  }
}

export async function processIdentity(pid: number): Promise<ProcessIdentity> {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false };
  if (!processAlive(pid)) return { alive: false };
  if (process.platform === "linux") return linuxIdentity(pid);
  if (process.platform === "darwin") return darwinIdentity(pid);
  return { alive: true };
}

export function linuxStatStart(statText: string): { start: string; state: string } | null {
  const close = statText.lastIndexOf(")");
  if (close < 0 || close + 2 >= statText.length) return null;
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  const state = fields[0];
  const start = fields[19];
  if (!state || state.length !== 1 || !start || !/^\d+$/.test(start)) return null;
  return { start, state };
}

export function procStartMatches(recorded: string, actual: string): boolean {
  const left = recorded.trim().replace(/\s+/g, " ");
  const right = actual.trim().replace(/\s+/g, " ");
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const actualLocal = asctimeToMs(right, "local");
  const recordedUtc = asctimeToMs(left, "utc");
  const recordedLocal = asctimeToMs(left, "local");
  if (actualLocal != null && recordedUtc != null && Math.abs(actualLocal - recordedUtc) <= START_SKEW_MS) return true;
  if (actualLocal != null && recordedLocal != null && Math.abs(actualLocal - recordedLocal) <= START_SKEW_MS) return true;
  return false;
}

async function verdictFor(
  file: string,
  name: string,
  identity: ProcessIdentityLookup,
): Promise<
  | { kind: "live"; sessionId: SessionId; entrypoint: EntrypointOwner; cwd: string | null; mtimeMs: number }
  | { kind: "unverified"; sessionId: SessionId }
  | { kind: "skip" }
> {
  const filenamePid = filenamePidOf(name);
  if (filenamePid == null) return { kind: "skip" };
  let text: string | null;
  try {
    text = await readBounded(file);
  } catch {
    return { kind: "skip" };
  }
  if (text === null) return { kind: "skip" };
  const parsed = parseRecord(text);
  if (!parsed) return { kind: "skip" };
  if (parsed.pid != null && parsed.pid !== filenamePid) {
    return { kind: "unverified", sessionId: parsed.sessionId };
  }
  const found = await identity(filenamePid);
  if (!found.alive || found.state === "Z") return { kind: "skip" };
  if (!parsed.procStart || !found.startToken) return { kind: "unverified", sessionId: parsed.sessionId };
  if (!procStartMatches(parsed.procStart, found.startToken)) return { kind: "skip" };
  const fileStat = await stat(file).catch(() => null);
  return {
    kind: "live",
    sessionId: parsed.sessionId,
    entrypoint: parsed.entrypoint,
    cwd: parsed.cwd,
    mtimeMs: fileStat?.mtimeMs ?? 0,
  };
}

function preferOwner(current: EntrypointOwner | undefined, next: EntrypointOwner): EntrypointOwner {
  if (!current) return next;
  if (rank(next) > rank(current)) return next;
  return current;
}

function rank(owner: EntrypointOwner): number {
  switch (owner) {
    case "desktop":
      return 3;
    case "terminal":
      return 2;
    case "other":
      return 1;
    case "absent":
      return 0;
    default: {
      const _never: never = owner;
      return assertNever(_never);
    }
  }
}

function parseRecord(text: string): { sessionId: SessionId; pid: number | null; procStart: string | null; entrypoint: EntrypointOwner; cwd: string | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as { sessionId?: unknown; pid?: unknown; procStart?: unknown; entrypoint?: unknown; cwd?: unknown };
  if (typeof record.sessionId !== "string") return null;
  const sessionId = parseSessionId(record.sessionId);
  if (!sessionId) return null;
  return {
    sessionId,
    pid: pidValue(record.pid),
    procStart: procStartValue(record.procStart),
    entrypoint: entrypointOwner(record.entrypoint),
    cwd: cwdValue(record.cwd),
  };
}

function cwdValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes(".key") || trimmed.includes("\0")) return null;
  return trimmed;
}

function entrypointOwner(value: unknown): EntrypointOwner {
  if (value == null) return "absent";
  if (value === "claude-desktop") return "desktop";
  if (value === "cli") return "terminal";
  if (typeof value === "string") return "other";
  return "other";
}

function pidValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
  return null;
}

function procStartValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function filenamePidOf(name: string): number | null {
  const match = /^(\d+)\.json$/.exec(name);
  if (!match?.[1]) return null;
  const pid = Number(match[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

async function readBounded(file: string): Promise<string | null> {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
  return readFile(file, "utf8");
}

const STATUS_TOKEN = /^[A-Za-z0-9_-]{1,32}$/;

export async function sessionRecordForPid(
  configRoot: string,
  pid: number,
  home: string,
): Promise<{ sessionId: SessionId; status: string | null } | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const name = `${pid}.json`;
  if (sessionRecordName(name) !== "pid-json") return null;
  const lexical = path.join(configRoot, "sessions", name);
  let real: string;
  try {
    real = await allowSessionRecord(configRoot, lexical, home);
  } catch {
    return null;
  }
  return readObserved(real);
}

export async function observedRegistryStatus(
  configRoot: string,
  home: string,
  sessionId: string,
): Promise<string | null> {
  const dir = path.join(configRoot, "sessions");
  let names: string[];
  try {
    const info = await lstat(dir);
    if (!info.isDirectory()) return null;
    names = await readdir(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    if (sessionRecordName(name) !== "pid-json") continue;
    let real: string;
    try {
      real = await allowSessionRecord(configRoot, path.join(dir, name), home);
    } catch {
      continue;
    }
    const found = await readObserved(real);
    if (found?.sessionId === sessionId) return found.status;
  }
  return null;
}

async function readObserved(file: string): Promise<{ sessionId: SessionId; status: string | null } | null> {
  let text: string | null;
  try {
    text = await readBounded(file);
  } catch {
    return null;
  }
  if (text === null) return null;
  const parsed = parseRecord(text);
  if (!parsed) return null;
  return { sessionId: parsed.sessionId, status: statusToken(text) };
}

function statusToken(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const status = (parsed as { status?: unknown }).status;
  if (typeof status !== "string" || !STATUS_TOKEN.test(status)) return null;
  return status;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    return code === "EPERM";
  }
}

async function linuxIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const parsed = linuxStatStart(text);
    if (!parsed) return { alive: true };
    if (parsed.state === "Z") return { alive: false, state: "Z" };
    return { alive: true, startToken: parsed.start, state: parsed.state };
  } catch {
    return { alive: true };
  }
}

async function darwinIdentity(pid: number): Promise<ProcessIdentity> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 2000,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    const token = stdout.trim().replace(/\s+/g, " ");
    if (token.length === 0) return { alive: true };
    return { alive: true, startToken: token };
  } catch {
    return { alive: true };
  }
}

function asctimeToMs(text: string, zone: "utc" | "local"): number | null {
  const match = /^(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) ([A-Z][a-z]{2}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text);
  if (!match) return null;
  const month = MONTHS.indexOf(match[1] as (typeof MONTHS)[number]);
  if (month < 0) return null;
  const day = Number(match[2]);
  const hour = Number(match[3]);
  const minute = Number(match[4]);
  const second = Number(match[5]);
  const year = Number(match[6]);
  if (zone === "utc") return Date.UTC(year, month, day, hour, minute, second);
  return new Date(year, month, day, hour, minute, second).getTime();
}
