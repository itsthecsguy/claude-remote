import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { DeskError, assertNever } from "./domain.js";
import { parseSessionId } from "./paths.js";

const META_KEY = /^[A-Za-z0-9_]+$/;
const TOKEN_TEXT = /^[0-9a-f]{64}$/;
const MAX_FRAME_BYTES = 300_000;
const MAX_CONTENT = 100_000;

export const CHANNEL_OFFER_MS = 400;

export const HANDED_NOTICE =
  "The channel process accepted the frame and wrote notifications/claude/channel. On Claude Code 2.1.295 a busy session took that text into the running turn and answered it when the turn finished. The channels reference says busy notifications are delivered together on the next turn, and it documents no switch that picks one of those. This result does not mean the turn has finished. observedStatus is the status token from sessions/<pid>.json when one is present. displayedInDesktop stays false. This server did not spawn claude.";

export const UNDELIVERED_NOTICE =
  "No channel listener accepted the message. This server did not resume the session, because a live process may still be writing the transcript. The open Code tab has no documented way to receive a custom channel. A channel server has to be spawned by that session, and a custom server needs an interactive terminal started with --dangerously-load-development-channels. The desktop app does not pass that flag. Existing queue tickets stay on disk and are not resumed while that process is live.";

export const REJECTED_NOTICE =
  "The channel listener rejected the frame and did not emit a notification. This server did not resume the session.";

export type ChannelNotification = {
  jsonrpc: "2.0";
  method: "notifications/claude/channel";
  params: {
    content: string;
    meta: Record<string, string>;
  };
};

export type ChannelOffer =
  | { accepted: true }
  | { accepted: false; code: "absent" | "auth" | "session" | "malformed" };

export type OfferDecision =
  | { kind: "accepted"; content: string }
  | { kind: "auth" | "session" | "malformed" };

type OfferExpect = {
  token: string;
  sessionId: string | null;
};

export function channelCapability(): { experimental: { "claude/channel": Record<string, never> } } {
  return { experimental: { "claude/channel": {} } };
}

export const SUN_PATH_LIMIT = 103;

export function channelDirectory(home: string): string {
  return path.join(home, ".claude-remote", "c");
}

export function legacyChannelDirectory(home: string): string {
  return path.join(home, ".claude-remote", "channel");
}

export function socketStem(sessionId: string): string {
  const id = parseSessionId(sessionId);
  if (!id) throw new DeskError("not-uuid", "session id must be a UUID");
  return Buffer.from(id.replaceAll("-", ""), "hex").toString("base64url");
}

export function sessionIdFromSocketName(name: string): ReturnType<typeof parseSessionId> {
  if (!name.endsWith(".sock") || name.includes(".key")) return null;
  const stem = name.slice(0, -".sock".length);
  const dashed = parseSessionId(stem);
  if (dashed) return dashed;
  if (!/^[A-Za-z0-9_-]{22}$/.test(stem)) return null;
  const bytes = Buffer.from(stem, "base64url");
  if (bytes.length !== 16) return null;
  const hex = bytes.toString("hex");
  return parseSessionId(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}

export function listenerSocket(home: string, sessionId: string): string {
  const socketPath = path.join(channelDirectory(home), `${socketStem(sessionId)}.sock`);
  if (Buffer.byteLength(socketPath) > SUN_PATH_LIMIT) {
    throw new DeskError("denied", "channel socket path is too long");
  }
  return socketPath;
}

export function channelProcessSpec(): { command: string; args: string[] } {
  const script = process.argv[1];
  if (!script) return { command: "claude-remote", args: ["channel"] };
  return { command: process.execPath, args: [script, "channel"] };
}

export function listenerToken(socketPath: string): string {
  if (socketPath.endsWith(".sock")) return `${socketPath.slice(0, -".sock".length)}.token`;
  return `${socketPath}.token`;
}

export function channelNotification(content: string, meta: Record<string, string>): ChannelNotification {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (!META_KEY.test(key)) continue;
    clean[key] = value;
  }
  return {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content, meta: clean },
  };
}

export function freshToken(): string {
  return randomBytes(32).toString("hex");
}

export function classifyOffer(line: string, expected: OfferExpect): OfferDecision {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { kind: "malformed" };
  const record = value as Record<string, unknown>;
  if (record.type !== "offer") return { kind: "malformed" };
  if (typeof record.token !== "string" || typeof record.sessionId !== "string" || typeof record.content !== "string") {
    return { kind: "malformed" };
  }
  if (record.content.length < 1 || record.content.length > MAX_CONTENT) return { kind: "malformed" };
  if (!tokenMatches(expected.token, record.token)) return { kind: "auth" };
  if (expected.sessionId != null) {
    const got = parseSessionId(record.sessionId);
    const want = parseSessionId(expected.sessionId);
    if (!got || !want || got !== want) return { kind: "session" };
  }
  return { kind: "accepted", content: record.content };
}

export async function channelListenerBound(home: string, sessionId: string): Promise<boolean> {
  const socketPath = socketPathOrNull(home, sessionId);
  if (!socketPath) return false;
  return socketIsBound(socketPath);
}

export async function channelListenerLive(home: string, sessionId: string, timeoutMs: number): Promise<boolean> {
  const socketPath = socketPathOrNull(home, sessionId);
  if (!socketPath) return false;
  return socketAccepts(socketPath, timeoutMs);
}

export async function socketAccepts(socketPath: string, timeoutMs: number): Promise<boolean> {
  if (!(await socketIsBound(socketPath))) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (live: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(live);
    };
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function liveSocketIds(home: string, timeoutMs: number): Promise<string[]> {
  const ids: string[] = [];
  for (const dir of [channelDirectory(home), legacyChannelDirectory(home)]) {
    let names: string[];
    try {
      const info = await lstat(dir);
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.includes(".key") || !name.endsWith(".sock")) continue;
      const id = sessionIdFromSocketName(name);
      if (!id) continue;
      if (await socketAccepts(path.join(dir, name), timeoutMs)) ids.push(id);
    }
  }
  return ids;
}

export async function writeChannelMcpConfig(home: string): Promise<string> {
  const dir = path.join(home, ".claude-remote", "mcp");
  await ensureChannelDir(dir);
  const file = path.join(dir, "channel.json");
  const body = `${JSON.stringify({ mcpServers: { "claude-remote-channel": channelProcessSpec() } })}\n`;
  await writePrivateText(file, body);
  return file;
}

function socketPathOrNull(home: string, sessionId: string): string | null {
  try {
    return listenerSocket(home, sessionId);
  } catch (error) {
    if (error instanceof DeskError && error.code === "denied") return null;
    throw error;
  }
}

export async function offerChannel(
  socketPath: string,
  content: string,
  sessionId: string,
  timeoutMs: number,
): Promise<ChannelOffer> {
  if (!(await socketIsBound(socketPath))) return { accepted: false, code: "absent" };
  const token = await readToken(listenerToken(socketPath));
  if (!token) return { accepted: false, code: "absent" };
  return submitOffer(socketPath, { sessionId, token, content }, timeoutMs);
}

export async function submitOffer(
  socketPath: string,
  body: { sessionId: string; token: string; content: string },
  timeoutMs: number,
): Promise<ChannelOffer> {
  if (!(await socketIsBound(socketPath))) return { accepted: false, code: "absent" };
  const line = JSON.stringify({
    type: "offer",
    sessionId: body.sessionId,
    token: body.token,
    content: body.content,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (offer: ChannelOffer) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(offer);
    };
    const socket = createConnection(socketPath);
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => finish({ accepted: false, code: "absent" }));
    socket.on("error", () => finish({ accepted: false, code: "absent" }));
    socket.on("connect", () => {
      socket.write(`${line}\n`);
    });
    readLineOn(socket, (reply) => finish(parseReply(reply)));
  });
}

export async function serveChannel(
  socketPath: string,
  options?: { sessionId?: string },
): Promise<{ received: string[]; close: () => Promise<void> }> {
  const token = freshToken();
  const received: string[] = [];
  const server = createServer((socket) => {
    readLineOn(socket, (line) => answerOffer(socket, line, { token, sessionId: options?.sessionId ?? null }, (content) => {
      received.push(content);
    }));
  });
  await openListener(server, socketPath, token);
  return {
    received,
    close: async () => {
      await closeListener(server, socketPath);
    },
  };
}

export async function openListener(server: Server, socketPath: string, token: string): Promise<void> {
  if (Buffer.byteLength(socketPath) > 103) {
    throw new DeskError("denied", "channel socket path is too long");
  }
  await ensureOneDir(path.dirname(socketPath));
  await refuseExistingSymlink(socketPath, "channel socket is a symlink");
  await unlink(socketPath).catch((error: unknown) => {
    if (errorCode(error) !== "ENOENT") throw error;
  });
  await writeToken(listenerToken(socketPath), token);
  try {
    await listen(server, socketPath);
    const bound = await lstat(socketPath);
    if (!bound.isSocket()) throw new DeskError("denied", "channel socket was not created");
    await chmod(socketPath, 0o600);
  } catch (error) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await unlink(listenerToken(socketPath)).catch(() => undefined);
    throw error;
  }
}

export async function closeListener(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await unlinkIfPlain(socketPath);
  await unlinkIfPlain(listenerToken(socketPath));
}

export function answerOffer(
  socket: Socket,
  line: string,
  expected: OfferExpect,
  onAccept: (content: string) => void,
): void {
  const decision = classifyOffer(line, expected);
  switch (decision.kind) {
    case "accepted":
      onAccept(decision.content);
      socket.end('{"type":"accepted"}\n');
      return;
    case "auth":
    case "session":
    case "malformed":
      socket.end(`${JSON.stringify({ type: "rejected", code: decision.kind })}\n`);
      return;
    default: {
      const _never: never = decision;
      return assertNever(_never);
    }
  }
}

export async function ensureChannelDir(dir: string): Promise<void> {
  await ensureOneDir(path.dirname(dir));
  await ensureOneDir(dir);
}

async function ensureOneDir(dir: string): Promise<void> {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink()) throw new DeskError("denied", "channel path is a symlink");
    if (!info.isDirectory()) throw new DeskError("denied", "channel path is not a directory");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (errorCode(error) !== "ENOENT") throw error;
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await chmod(dir, 0o700);
}

async function refuseExistingSymlink(file: string, message: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new DeskError("denied", message);
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function writeToken(tokenPath: string, token: string): Promise<void> {
  await writePrivateText(tokenPath, token);
}

async function writePrivateText(file: string, text: string): Promise<void> {
  await refuseExistingSymlink(file, "channel path is a symlink");
  const fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(text, "utf8");
    await fh.chmod(0o600);
  } finally {
    await fh.close();
  }
}

async function readToken(tokenPath: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(tokenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await fh.stat();
    if (!info.isFile()) return null;
    if ((info.mode & 0o077) !== 0) return null;
    if (info.size < 64 || info.size > 80) return null;
    const text = (await fh.readFile({ encoding: "utf8" })).trim();
    if (!TOKEN_TEXT.test(text)) return null;
    return text;
  } finally {
    await fh.close();
  }
}

async function socketIsBound(socketPath: string): Promise<boolean> {
  try {
    const info = await lstat(socketPath);
    return info.isSocket();
  } catch {
    return false;
  }
}

async function unlinkIfPlain(file: string): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) return;
    await unlink(file);
  } catch {
    return;
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

export function readLineOn(socket: Socket, onLine: (line: string) => void): void {
  let buf = "";
  const take = (chunk: Buffer | string) => {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(buf) > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    socket.off("data", take);
    onLine(buf.slice(0, nl));
  };
  socket.on("data", take);
}

function parseReply(line: string): ChannelOffer {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { accepted: false, code: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { accepted: false, code: "malformed" };
  const record = value as { type?: unknown; code?: unknown };
  if (record.type === "accepted") return { accepted: true };
  if (record.type === "rejected") {
    switch (record.code) {
      case "auth":
      case "session":
      case "malformed":
        return { accepted: false, code: record.code };
      default:
        return { accepted: false, code: "malformed" };
    }
  }
  return { accepted: false, code: "malformed" };
}

function tokenMatches(expected: string, given: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(given);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}
