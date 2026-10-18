import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.js";
import { logEvent } from "./log.js";
import type { PendingStore, PendingView, SavedEntry } from "./pending.js";
import { loadSessionRegistry } from "./registry.js";
import { tokenDirectory } from "./token.js";

/**
 * Keep pending entries across an HTTP helper restart.
 *
 * The helper saves the store to ~/.claude-remote/http/pending.json (mode 0600, written to a temp
 * file and renamed) shortly after each change, and loads it on start. The file can hold question,
 * notification and tool-input text, so it is private to the user and never logged.
 *
 * On load an entry is dropped when its session is no longer live, when it is a permission request
 * or question older than the approve timeout, or when it is older than MAX_AGE_MS. What is left is
 * restored without a deadline, so nothing loaded from disk can be answered remotely: the hook that
 * was waiting gave up when the helper went away.
 */

export const PENDING_FILE = "pending.json";
export const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_FILE = 8 * 1024 * 1024;
const SAVE_DELAY_MS = 200;
const KINDS = new Set(["permission", "question", "notification"]);
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type Liveness = (sessionIds: string[]) => Promise<Set<string> | null>;

export function pendingFilePath(home: string): string {
  return path.join(tokenDirectory(home), PENDING_FILE);
}

/** Live session ids from ~/.claude/sessions, or null when that cannot be read. */
export function registryLiveness(config: Pick<Config, "configRoot" | "home">): Liveness {
  return async () => {
    try {
      const registry = await loadSessionRegistry(config.configRoot, config.home);
      if (registry.status !== "checked") return null;
      return new Set([...registry.live, ...registry.unverified].map((id) => id.toLowerCase()));
    } catch {
      return null;
    }
  };
}

export async function savePending(file: string, entries: SavedEntry[]): Promise<void> {
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      logEvent({ tool: "pending-file", code: "refused-path" });
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, entries })}\n`, "utf8");
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, file);
}

export async function readPending(file: string): Promise<SavedEntry[]> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return [];
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_FILE) {
    logEvent({ tool: "pending-file", code: "refused-file" });
    return [];
  }
  if ((info.mode & 0o077) !== 0) await chmod(file, 0o600).catch(() => undefined);
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      text = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
    const parsed = JSON.parse(text) as { version?: unknown; entries?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return [];
    return parsed.entries.flatMap((item) => validEntry(item) ? [item] : []);
  } catch {
    logEvent({ tool: "pending-file", code: "unreadable" });
    return [];
  }
}

function validEntry(item: unknown): item is SavedEntry {
  if (!item || typeof item !== "object") return false;
  const { view, createdMs, matchKey } = item as Record<string, unknown>;
  if (typeof createdMs !== "number" || !Number.isFinite(createdMs)) return false;
  if (matchKey !== null && typeof matchKey !== "string") return false;
  if (!view || typeof view !== "object") return false;
  const v = view as Record<string, unknown>;
  return typeof v.requestId === "string"
    && typeof v.sessionId === "string" && ID_RE.test(v.sessionId)
    && (v.agentId === null || typeof v.agentId === "string")
    && typeof v.kind === "string" && KINDS.has(v.kind)
    && typeof v.createdAt === "string"
    && typeof v.text === "string"
    && (v.toolName === null || typeof v.toolName === "string")
    && (v.notificationType === null || typeof v.notificationType === "string")
    && (v.title === null || typeof v.title === "string")
    && (v.toolInput === null || (typeof v.toolInput === "object" && !Array.isArray(v.toolInput)))
    && (v.questions === null || Array.isArray(v.questions));
}

/** Which saved entries to keep after a restart. */
export function keepEntry(
  item: SavedEntry,
  now: number,
  approveTimeoutMs: number,
  live: Set<string> | null,
): boolean {
  const age = now - item.createdMs;
  if (age < 0 || age > MAX_AGE_MS) return false;
  if (kindWaits(item.view) && age > approveTimeoutMs) return false;
  if (live && !live.has(item.view.sessionId.toLowerCase())) return false;
  return true;
}

function kindWaits(view: PendingView): boolean {
  return view.kind === "permission" || view.kind === "question";
}

export type PendingPersistence = {
  restored: number;
  dropped: number;
  flush: () => Promise<void>;
  stop: () => Promise<void>;
};

/** Load the saved entries into the store, then save the store after each change. */
export async function startPendingPersistence(
  store: PendingStore,
  options: { file: string; approveTimeoutMs: number; liveness: Liveness; clock?: () => number; delayMs?: number },
): Promise<PendingPersistence> {
  const clock = options.clock ?? Date.now;
  const saved = (await readPending(options.file)).sort((a, b) => a.createdMs - b.createdMs);
  const live = saved.length > 0 ? await options.liveness([...new Set(saved.map((item) => item.view.sessionId))]) : null;
  const now = clock();
  const kept = saved.filter((item) => keepEntry(item, now, options.approveTimeoutMs, live));
  const restored = store.restore(kept);
  const dropped = saved.length - restored;
  if (saved.length > 0) logEvent({ tool: "pending-file", code: "loaded", evidence: `restored-${restored}-dropped-${dropped}` });

  let timer: NodeJS.Timeout | null = null;
  let writing: Promise<void> = Promise.resolve();
  let stopped = false;
  const write = (): Promise<void> => {
    writing = writing.then(() => savePending(options.file, store.snapshot())).catch(() => {
      logEvent({ tool: "pending-file", code: "save-failed" });
    });
    return writing;
  };
  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await write();
  };
  const unsubscribe = store.subscribe(() => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void write();
    }, options.delayMs ?? SAVE_DELAY_MS);
  });
  if (saved.length > 0) await flush();
  return {
    restored,
    dropped,
    flush,
    stop: async () => {
      stopped = true;
      unsubscribe();
      await flush();
    },
  };
}
