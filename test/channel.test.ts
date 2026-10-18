import assert from "node:assert/strict";
import { chmod, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  SUN_PATH_LIMIT,
  channelCapability,
  channelNotification,
  listenerSocket,
  offerChannel,
  serveChannel,
  sessionIdFromSocketName,
} from "../src/channel.js";
import { DeskError } from "../src/domain.js";
import { tempDir, tempHome } from "./helpers.js";

test("a short home fits under the socket limit and a long home does not", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const shortHome = `/Users/${"n".repeat(40)}`;
  const socket = listenerSocket(shortHome, id);
  assert.ok(Buffer.byteLength(socket) <= SUN_PATH_LIMIT);
  assert.equal(socket.includes(id), false);
  assert.equal(sessionIdFromSocketName(path.basename(socket)), id);
  assert.equal(sessionIdFromSocketName(`${id}.sock`), id);
  const legacy = path.join(shortHome, ".claude-remote", "channel", `${id}.sock`);
  assert.ok(Buffer.byteLength(legacy) > SUN_PATH_LIMIT);
  const longHome = `/Users/${"n".repeat(80)}`;
  assert.throws(
    () => listenerSocket(longHome, id),
    (error: unknown) => error instanceof DeskError && error.code === "denied" && error.message === "channel socket path is too long",
  );
});

test("a temp home stays short when the process temp directory is long", async () => {
  const { home } = await tempHome();
  assert.match(home, /^\/(?:private\/)?tmp\/cr-/);
  assert.equal(home.includes("folders"), false);
  const id = "11111111-1111-4111-8111-111111111111";
  assert.ok(Buffer.byteLength(listenerSocket(home, id)) <= SUN_PATH_LIMIT);
});

test("the channel capability and notification match the documented frame", async () => {
  assert.deepEqual(channelCapability(), { experimental: { "claude/channel": {} } });
  const frame = channelNotification("hello", { session_id: "abc", "session-id": "drop" });
  assert.deepEqual(frame, {
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: "hello", meta: { session_id: "abc" } },
  });
});

test("a listener accepts one frame and a missing socket does not", async () => {
  const dir = await tempDir("claude-remote-ch-");
  const socketPath = path.join(dir, "listener.sock");
  const missing = await offerChannel(socketPath, "hello", "abc", 200);
  assert.deepEqual(missing, { accepted: false, code: "absent" });
  const server = await serveChannel(socketPath);
  try {
    const info = await stat(socketPath);
    assert.equal(info.mode & 0o777, 0o600);
    const dirInfo = await stat(dir);
    assert.equal(dirInfo.mode & 0o777, 0o700);
    const tokenInfo = await stat(path.join(dir, "listener.token"));
    assert.equal(tokenInfo.mode & 0o777, 0o600);
    const offer = await offerChannel(socketPath, "hello", "abc", 1000);
    assert.deepEqual(offer, { accepted: true });
    assert.deepEqual(server.received, ["hello"]);
  } finally {
    await server.close();
  }
});

test("a symlink in place of the listener socket is not opened", async () => {
  const dir = await tempDir("claude-remote-ch-");
  const key = path.join(dir, "4242.secret.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  const socketPath = path.join(dir, "listener.sock");
  await symlink(key, socketPath);
  const offer = await offerChannel(socketPath, "hello", "abc", 200);
  assert.deepEqual(offer, { accepted: false, code: "absent" });
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
});

test("a symlink in place of the token file is not read", async () => {
  const dir = await tempDir("claude-remote-ch-");
  const key = path.join(dir, "4242.secret.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  const socketPath = path.join(dir, "listener.sock");
  const server = await serveChannel(socketPath);
  try {
    const tokenPath = path.join(dir, "listener.token");
    await unlink(tokenPath);
    await symlink(key, tokenPath);
    const offer = await offerChannel(socketPath, "hello", "abc", 200);
    assert.deepEqual(offer, { accepted: false, code: "absent" });
    assert.equal(server.received.length, 0);
    assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
    await unlink(tokenPath);
    await writeFile(tokenPath, "a".repeat(64), { mode: 0o644 });
    await chmod(tokenPath, 0o644);
    const loose = await offerChannel(socketPath, "hello", "abc", 200);
    assert.deepEqual(loose, { accepted: false, code: "absent" });
    assert.equal(server.received.length, 0);
  } finally {
    await server.close();
  }
});
