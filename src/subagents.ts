import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import type { SessionId, SubSessionRow } from "./domain.js";
import { rejectCredentialPath } from "./paths.js";

const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const AGENT_TYPE = /^[A-Za-z0-9 _:./@-]{1,64}$/;
const MAX_META_BYTES = 65_536;
const MAX_ROWS = 500;

/**
 * Child rows for one session: every subagents/agent-<id>.jsonl under
 * <configRoot>/projects/<slug>/<sessionId>/, with fields from agent-<id>.meta.json. Only file
 * stats and the meta sidecar are read. The jsonl transcripts are never opened. Symlinks are
 * skipped, and the directory has to resolve inside the projects root.
 */
export async function listSubSessions(
  configRoot: string,
  transcriptPath: string,
  sessionId: SessionId,
  home: string,
): Promise<SubSessionRow[]> {
  const projectDir = path.dirname(transcriptPath);
  const dir = path.join(projectDir, sessionId, "subagents");
  if (!(await realDirectory(path.join(projectDir, sessionId))) || !(await realDirectory(dir))) return [];
  let projects: string;
  let realDir: string;
  try {
    projects = await realpath(path.join(configRoot, "projects"));
    realDir = await realpath(dir);
  } catch {
    return [];
  }
  if (!realDir.startsWith(projects + path.sep)) return [];
  let names: string[];
  try {
    names = await readdir(realDir);
  } catch {
    return [];
  }
  const rows: SubSessionRow[] = [];
  for (const name of names.sort()) {
    if (rows.length >= MAX_ROWS) break;
    const agentId = agentIdOf(name);
    if (!agentId) continue;
    const file = path.join(realDir, name);
    let info;
    try {
      info = await lstat(file);
    } catch {
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) continue;
    const meta = await readMeta(path.join(realDir, `agent-${agentId}.meta.json`), home);
    rows.push({
      agentId,
      parentSessionId: sessionId,
      agentType: meta?.agentType ?? null,
      isFork: meta?.isFork ?? false,
      spawnDepth: meta?.spawnDepth ?? null,
      finished: meta?.finished ?? null,
      parentAgentId: meta?.parentAgentId ?? null,
      worktree: meta?.worktree ?? false,
      sizeBytes: info.size,
      lastActivity: info.mtimeMs > 0 ? new Date(info.mtimeMs).toISOString() : null,
      hasMeta: meta != null,
    });
  }
  rows.sort((a, b) => (b.lastActivity ?? "").localeCompare(a.lastActivity ?? ""));
  return rows;
}

export function agentIdOf(name: string): string | null {
  if (!name.startsWith("agent-") || !name.endsWith(".jsonl")) return null;
  if (name.includes(".key")) return null;
  const id = name.slice("agent-".length, -".jsonl".length);
  return AGENT_ID.test(id) ? id : null;
}

type Meta = {
  agentType: string | null;
  isFork: boolean;
  spawnDepth: number | null;
  finished: boolean | null;
  parentAgentId: string | null;
  worktree: boolean;
};

export function parseMeta(text: string): Meta | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  return {
    agentType: typeof raw.agentType === "string" && AGENT_TYPE.test(raw.agentType) ? raw.agentType : null,
    isFork: raw.isFork === true,
    spawnDepth: typeof raw.spawnDepth === "number" && Number.isInteger(raw.spawnDepth) && raw.spawnDepth >= 0 && raw.spawnDepth <= 64
      ? raw.spawnDepth
      : null,
    finished: typeof raw.finished === "boolean" ? raw.finished : null,
    parentAgentId: typeof raw.parentAgentId === "string" && AGENT_ID.test(raw.parentAgentId) ? raw.parentAgentId : null,
    worktree: raw.spawnedWithWorktree === true,
  };
}

async function readMeta(file: string, home: string): Promise<Meta | null> {
  try {
    rejectCredentialPath(file, home);
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_META_BYTES) return null;
    return parseMeta(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function realDirectory(dir: string): Promise<boolean> {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}
