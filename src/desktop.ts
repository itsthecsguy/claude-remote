import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { runBoundedNode } from "./bounded.js";
import type { Config } from "./config.js";
import type { DesktopSessionId, SessionId } from "./domain.js";
import { allowDesktopMeta, parseSessionId } from "./paths.js";

const DESKTOP_STAT_MS = 2000;

const STAT_DIR_SOURCE = `
const { statSync } = require("node:fs");
try {
  process.stdout.write(statSync(process.argv[1]).isDirectory() ? "yes" : "no");
} catch {
  process.stdout.write("no");
}
`;

export type DesktopMeta = {
  cliSessionId: SessionId;
  desktopSessionId: DesktopSessionId | null;
  branch: string | null;
  worktreePath: string | null;
  cwd: string | null;
  title: string | null;
};

export async function resolveDesktopRoot(config: Config): Promise<string | null> {
  if (config.desktopRootExplicit) return config.desktopRoot;
  if (config.platform !== "darwin") return null;
  const consumer = path.join(config.home, "Library", "Application Support", "Claude", "claude-code-sessions");
  const third = path.join(config.home, "Library", "Application Support", "Claude-3p", "claude-code-sessions");
  if (await isDirectory(consumer)) return consumer;
  if (await isDirectory(third)) return third;
  return null;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    const text = await runBoundedNode(STAT_DIR_SOURCE, dir, DESKTOP_STAT_MS);
    return text.trim() === "yes";
  } catch {
    return false;
  }
}

export async function loadDesktopIndex(root: string | null, home: string): Promise<Map<string, DesktopMeta>> {
  const index = new Map<string, DesktopMeta>();
  if (!root) return index;
  const files = await walkLocalJson(root);
  for (const file of files) {
    let real: string;
    try {
      real = await allowDesktopMeta(root, file, home);
    } catch {
      continue;
    }
    let raw: string;
    try {
      const info = await stat(real);
      if (info.size > 1024 * 1024) continue;
      raw = await readFile(real, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as Record<string, unknown>;
    if (typeof record.cliSessionId !== "string") continue;
    const cliSessionId = parseSessionId(record.cliSessionId);
    if (!cliSessionId) continue;
    const desktopSessionId = typeof record.sessionId === "string" && record.sessionId.startsWith("local_")
      ? record.sessionId as DesktopSessionId
      : null;
    index.set(cliSessionId, {
      cliSessionId,
      desktopSessionId,
      branch: typeof record.branch === "string" ? record.branch : null,
      worktreePath: typeof record.worktreePath === "string" ? record.worktreePath : null,
      cwd: typeof record.cwd === "string" ? record.cwd : null,
      title: typeof record.title === "string" ? record.title : null,
    });
  }
  return index;
}

export function recordedWorkingFolder(meta: DesktopMeta | undefined, transcriptCwd: string | null): string | null {
  const worktree = folderPath(meta?.worktreePath ?? null);
  if (worktree) return worktree;
  const desktopCwd = folderPath(meta?.cwd ?? null);
  if (desktopCwd) return desktopCwd;
  return transcriptCwd;
}

export function sessionTitle(meta: DesktopMeta | undefined, transcriptTitle: string | null): string | null {
  const sidebar = meta?.title?.trim() ?? "";
  if (sidebar.length > 0) return sidebar;
  return transcriptTitle;
}

function folderPath(value: string | null): string | null {
  if (!value || value.trim().length === 0) return null;
  if (!value.includes("/") && !value.includes("\\")) return null;
  return value;
}

async function walkLocalJson(dir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      found.push(...await walkLocalJson(full));
    } else if (entry.isFile() && entry.name.startsWith("local_") && entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}
