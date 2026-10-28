import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { DeskError, assertNever } from "./domain.js";

/**
 * File helpers shared by install, the watchdog, and status. Every writer refuses symlinks, creates
 * files 0600, and writes through a temp file plus rename so a reader never sees a partial file.
 */

export function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function writePrivate(file: string, text: string, parent: "private" | "launchAgents" = "private"): Promise<void> {
  switch (parent) {
    case "private":
      await mkdirPrivate(path.dirname(file));
      break;
    case "launchAgents":
      await mkdirLaunchAgents(path.dirname(file));
      break;
    default: {
      const _never: never = parent;
      return assertNever(_never);
    }
  }
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink()) throw new DeskError("denied", "refusing to follow a symlink");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(text);
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(tmp, file);
  await chmod(file, 0o600);
}

export async function mkdirLaunchAgents(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new DeskError("denied", "directory is not allowed");
    return;
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  await mkdir(dir, { recursive: true });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "directory is not allowed");
  await chmod(dir, 0o755);
}

export async function mkdirPrivate(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new DeskError("denied", "directory is not allowed");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "directory is not allowed");
  await chmod(dir, 0o700);
}

/** Create a log file 0600 before launchd opens it, or tighten an existing one. */
export async function ensureLog(file: string): Promise<void> {
  await mkdirPrivate(path.dirname(file));
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink()) throw new DeskError("denied", "refusing to follow a symlink");
    if (!existing.isFile()) throw new DeskError("denied", "log path is not a file");
    await chmod(file, 0o600);
    return;
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(file).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(file, 0o600);
}

export async function readPlainFile(file: string): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile()) return null;
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

/** Delete a regular file. Symlinks, directories, and anything named like a key are left alone. */
export async function unlinkFile(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return;
    if (path.basename(file).includes(".key")) return;
    await unlink(file);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
}

/**
 * The last `maxBytes` of a regular file, as text. A symlink or a missing file reads as empty.
 * Status and the watchdog read the tunnel log this way: the live quick-tunnel URL and the newest
 * connection events are at the end, and the file is never rotated by cloudflared.
 */
export async function readTail(file: string, maxBytes: number): Promise<string> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return "";
  }
  if (info.isSymbolicLink() || !info.isFile()) return "";
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const length = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Math.max(0, info.size - length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export type TrimResult = { file: string; before: number; after: number } | null;

/**
 * Keep an append-only log under `maxBytes`: the last `keepBytes` go to `<file>.1`, and the file is
 * truncated in place. launchd and cloudflared both open their log with O_APPEND, so a writer that
 * still holds the file keeps appending after the truncation. Returns null when nothing was done.
 */
export async function trimLog(file: string, maxBytes: number, keepBytes: number): Promise<TrimResult> {
  let info;
  try {
    info = await lstat(file);
  } catch {
    return null;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size <= maxBytes) return null;
  const tail = await readTail(file, keepBytes);
  const firstLine = tail.indexOf("\n");
  await writePrivate(`${file}.1`, firstLine >= 0 ? tail.slice(firstLine + 1) : tail);
  const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
  try {
    await handle.truncate(0);
  } finally {
    await handle.close();
  }
  return { file, before: info.size, after: 0 };
}
