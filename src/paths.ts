import { realpathSync } from "node:fs";
import { lstat, open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionId } from "./domain.js";
import { DeskError } from "./domain.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSessionId(raw: string): SessionId | null {
  if (!UUID_RE.test(raw)) return null;
  return raw.toLowerCase() as SessionId;
}

export function rejectCredentialPath(file: string, home: string): void {
  const files = new Set([path.resolve(file), physicalSync(file)]);
  const homes = new Set([path.resolve(home), physicalSync(home)]);
  for (const candidate of files) {
    for (const root of homes) {
      if (credentialAt(candidate, root)) throw new DeskError("denied", "path is not a transcript");
    }
  }
}

function credentialAt(file: string, home: string): boolean {
  if (file === path.join(home, ".claude", ".credentials.json")) return true;
  if (file === path.join(home, ".claude.json")) return true;
  const anthropic = path.join(home, ".config", "anthropic");
  if (file === anthropic || file.startsWith(anthropic + path.sep)) return true;
  const base = path.basename(file);
  return base === ".credentials.json" || base === ".claude.json";
}

function physicalSync(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

export async function allowTranscript(configRoot: string, lexicalPath: string, home: string): Promise<string> {
  rejectCredentialPath(lexicalPath, home);
  const realRoot = await realpath(configRoot);
  const real = await realpath(lexicalPath);
  rejectCredentialPath(real, home);
  const projects = path.join(realRoot, "projects");
  if (real !== projects && !real.startsWith(projects + path.sep)) {
    throw new DeskError("denied", "path is not a transcript");
  }
  const rel = path.relative(projects, real);
  const parts = rel.split(path.sep);
  if (parts.length !== 2) throw new DeskError("denied", "path is not a transcript");
  const slug = parts[0] ?? "";
  const base = parts[1] ?? "";
  if (
    slug.includes(".orphaned-")
    || slug.includes(".superseded")
    || base.includes(".orphaned-")
    || base.includes(".superseded")
    || parts.includes("subagents")
  ) {
    throw new DeskError("denied", "path is not a transcript");
  }
  if (!base.endsWith(".jsonl")) throw new DeskError("denied", "path is not a transcript");
  const stem = base.slice(0, -".jsonl".length);
  if (!parseSessionId(stem)) throw new DeskError("denied", "path is not a transcript");
  return real;
}

export async function allowDesktopMeta(desktopRoot: string, lexicalPath: string, home: string): Promise<string> {
  rejectCredentialPath(lexicalPath, home);
  const realRoot = await realpath(desktopRoot);
  const real = await realpath(lexicalPath);
  rejectCredentialPath(real, home);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new DeskError("denied", "path is not desktop metadata");
  }
  const base = path.basename(real);
  if (!base.startsWith("local_") || !base.endsWith(".json")) {
    throw new DeskError("denied", "path is not desktop metadata");
  }
  return real;
}

const PID_JSON = /^(\d+)\.json$/;

export function sessionRecordName(name: string): "pid-json" | "key" | "other" {
  if (name.endsWith(".key") || name.includes(".key")) return "key";
  if (PID_JSON.test(name)) return "pid-json";
  return "other";
}

const KEY_LINK_HOPS = 8;

export async function allowSessionRecord(configRoot: string, lexicalPath: string, home: string): Promise<string> {
  const base = path.basename(lexicalPath);
  if (sessionRecordName(base) !== "pid-json") {
    throw new DeskError("denied", "path is not a session record");
  }
  await refuseKeyLink(lexicalPath);
  rejectCredentialPath(lexicalPath, home);
  const realRoot = await realpath(configRoot);
  const sessions = await realpath(path.join(realRoot, "sessions"));
  const real = await realpath(lexicalPath);
  rejectCredentialPath(real, home);
  if (path.dirname(real) !== sessions || path.basename(real) !== base) {
    throw new DeskError("denied", "path is not a session record");
  }
  return real;
}

async function refuseKeyLink(file: string): Promise<void> {
  let current = file;
  for (let hop = 0; hop < KEY_LINK_HOPS; hop += 1) {
    let info;
    try {
      info = await lstat(current);
    } catch {
      return;
    }
    if (!info.isSymbolicLink()) return;
    let target: string;
    try {
      target = await readlink(current);
    } catch {
      return;
    }
    if (sessionRecordName(path.basename(target)) === "key") {
      throw new DeskError("denied", "path is not a session record");
    }
    current = path.resolve(path.dirname(current), target);
  }
  throw new DeskError("denied", "path is not a session record");
}

export type TranscriptCandidate = {
  sessionId: SessionId;
  filePath: string;
  mtimeMs: number;
  projectSlug: string;
};

export async function discoverTranscripts(configRoot: string, home: string): Promise<TranscriptCandidate[]> {
  const projects = path.join(configRoot, "projects");
  let slugs: string[];
  try {
    slugs = await readdir(projects);
  } catch {
    return [];
  }
  const found: TranscriptCandidate[] = [];
  for (const slug of slugs) {
    const dir = path.join(projects, slug);
    let dirStat;
    try {
      dirStat = await lstat(dir);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      if (name.includes(".orphaned-") || name.includes(".superseded")) continue;
      const sessionId = parseSessionId(name.slice(0, -".jsonl".length));
      if (!sessionId) continue;
      const lexical = path.join(dir, name);
      let real: string;
      try {
        real = await allowTranscript(configRoot, lexical, home);
      } catch {
        continue;
      }
      if (await fileIsSidechain(real)) continue;
      const fileStat = await stat(real);
      found.push({ sessionId, filePath: real, mtimeMs: fileStat.mtimeMs, projectSlug: slug });
    }
  }
  return found;
}

export async function resolveSessionFile(configRoot: string, id: SessionId, home: string): Promise<string> {
  const projects = path.join(configRoot, "projects");
  let slugs: string[];
  try {
    slugs = await readdir(projects);
  } catch {
    throw new DeskError("not-found", "session not found");
  }
  let denied = false;
  const matches: { file: string; mtimeMs: number }[] = [];
  for (const slug of slugs) {
    const lexical = path.join(projects, slug, `${id}.jsonl`);
    try {
      await lstat(lexical);
    } catch {
      continue;
    }
    try {
      const real = await allowTranscript(configRoot, lexical, home);
      if (await fileIsSidechain(real)) continue;
      const fileStat = await stat(real);
      matches.push({ file: real, mtimeMs: fileStat.mtimeMs });
    } catch (error) {
      if (error instanceof DeskError && error.code === "denied") denied = true;
    }
  }
  if (matches.length === 0) {
    if (denied) throw new DeskError("denied", "path is not a transcript");
    throw new DeskError("not-found", "session not found");
  }
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const first = matches[0];
  if (!first) throw new DeskError("not-found", "session not found");
  return first.file;
}

const PREFIX_BYTES = 200;

export async function fileIsSidechain(file: string): Promise<boolean> {
  const prefix = await readPrefix(file);
  return /"isSidechain"\s*:\s*true/.test(prefix);
}

async function readPrefix(file: string): Promise<string> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(PREFIX_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PREFIX_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    await fh.close();
  }
}
