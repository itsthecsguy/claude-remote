import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { DeskError } from "./domain.js";

const TOKEN_BYTES = 32;

export function tokenDirectory(home: string): string {
  return path.join(path.resolve(home), ".claude-remote", "http");
}

export function tokenPath(home: string): string {
  return path.join(tokenDirectory(home), "token");
}

export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function bearerMatches(header: string | null, expected: string): boolean {
  const presented = bearerValue(header);
  const left = createHash("sha256").update(presented).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export async function readToken(home: string): Promise<string | null> {
  const file = tokenPath(home);
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const text = (await handle.readFile({ encoding: "utf8" })).trim();
    if (!tokenShape(text)) return null;
    return text;
  } finally {
    await handle.close();
  }
}

export async function writeToken(home: string, token: string): Promise<string> {
  if (!tokenShape(token)) throw new DeskError("denied", "token is not allowed");
  const dir = tokenDirectory(home);
  await mkdirPrivate(path.join(path.resolve(home), ".claude-remote"));
  await mkdirPrivate(dir);
  const dest = tokenPath(home);
  const tmp = path.join(dir, `.token.${process.pid}.tmp`);
  const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${token}\n`);
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(tmp, dest);
  await chmod(dest, 0o600);
  return dest;
}

export async function ensureToken(home: string): Promise<{ path: string; created: boolean }> {
  const existing = await readToken(home);
  if (existing) return { path: tokenPath(home), created: false };
  await writeToken(home, mintToken());
  return { path: tokenPath(home), created: true };
}

function bearerValue(header: string | null): string {
  if (!header) return "";
  const match = /^Bearer ([A-Za-z0-9_-]{43,})$/.exec(header.trim());
  return match?.[1] ?? "";
}

function tokenShape(token: string): boolean {
  if (!/^[A-Za-z0-9_-]{43,}$/.test(token)) return false;
  try {
    return Buffer.from(token, "base64url").length >= TOKEN_BYTES;
  } catch {
    return false;
  }
}

async function mkdirPrivate(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new DeskError("denied", "token directory is not allowed");
    }
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
    await mkdir(dir, { mode: 0o700 });
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "token directory is not allowed");
  await chmod(dir, 0o700);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
