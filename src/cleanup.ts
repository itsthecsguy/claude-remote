import { lstat, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { sweepAttachments } from "./attachments.js";
import { channelDirectory, legacyChannelDirectory, listenerToken, sessionIdFromSocketName, socketAccepts } from "./channel.js";
import type { Config } from "./config.js";
import { logEvent } from "./log.js";

const PROBE_MS = 200;

export type CleanupResult = {
  sockets: number;
  tokens: number;
};

export async function cleanupDesk(config: Config): Promise<CleanupResult> {
  const started = Date.now();
  await sweepAttachments(config.home, config.attachmentTtlMs, Date.now());
  const removed = await removeStaleSockets(config.home);
  logEvent({ tool: "cleanup", durationMs: Date.now() - started });
  return removed;
}

async function removeStaleSockets(home: string): Promise<CleanupResult> {
  let sockets = 0;
  let tokens = 0;
  for (const dir of [channelDirectory(home), legacyChannelDirectory(home)]) {
    const removed = await removeStaleIn(dir);
    sockets += removed.sockets;
    tokens += removed.tokens;
  }
  return { sockets, tokens };
}

async function removeStaleIn(dir: string): Promise<CleanupResult> {
  let names: string[];
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return { sockets: 0, tokens: 0 };
    names = await readdir(dir);
  } catch {
    return { sockets: 0, tokens: 0 };
  }
  let sockets = 0;
  let tokens = 0;
  for (const name of names) {
    if (name.includes(".key") || !name.endsWith(".sock")) continue;
    if (!sessionIdFromSocketName(name)) continue;
    const socketPath = path.join(dir, name);
    let info;
    try {
      info = await lstat(socketPath);
    } catch {
      continue;
    }
    if (info.isSymbolicLink()) continue;
    if (await socketAccepts(socketPath, PROBE_MS)) continue;
    try {
      await unlink(socketPath);
      sockets += 1;
    } catch {
      continue;
    }
    const tokenPath = listenerToken(socketPath);
    if (path.basename(tokenPath).includes(".key")) continue;
    try {
      const tokenInfo = await lstat(tokenPath);
      if (tokenInfo.isSymbolicLink() || !tokenInfo.isFile()) continue;
      await unlink(tokenPath);
      tokens += 1;
    } catch {
      continue;
    }
  }
  return { sockets, tokens };
}
