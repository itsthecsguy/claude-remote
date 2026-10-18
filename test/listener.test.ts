import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { continueCommandLine } from "../src/continue.js";
import { skipsFolderProbe } from "../src/followup.js";
import { listenHttp } from "../src/http.js";
import { continueCommand, listSessions } from "../src/tools.js";
import { mintToken, writeToken } from "../src/token.js";
import { configAt, repoRoot, shimPath, tempHome } from "./helpers.js";

const tsxLoader = pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
const ID = "abcdefab-cdef-4def-8aaa-abcdefabcdef";

test("protected folders are recognized without resolving them", () => {
  const home = "/home/example";
  assert.equal(skipsFolderProbe(path.join(home, "Documents", "proj"), home), true);
  assert.equal(skipsFolderProbe(path.join(home, "Desktop"), home), true);
  assert.equal(skipsFolderProbe(path.join(home, "Downloads", "a"), home), true);
  assert.equal(skipsFolderProbe(path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"), home), true);
  assert.equal(skipsFolderProbe(path.join(home, "Library", "CloudStorage", "iCloud Drive"), home), true);
  assert.equal(skipsFolderProbe(path.join(home, "code", "proj"), home), false);
  assert.equal(skipsFolderProbe(path.join(home, "Library", "Application Support", "Claude"), home), false);
});

test("a protected working directory does not wait on git", async () => {
  const { home, root } = await tempHome();
  const cwd = path.join(home, "Documents", "proj");
  await mkdir(cwd, { recursive: true });
  await writeClosed(root, ID, cwd);
  const config = configAt(home, root);
  const previous = process.env.PATH;
  process.env.PATH = `${await sleeperGit(home)}:/usr/bin:/bin`;
  try {
    const started = Date.now();
    const listed = await listSessions(config, {}, async () => []);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `elapsed ${elapsed}`);
    const card = listed.sessions.find((session) => session.sessionId === ID);
    assert.ok(card);
    assert.equal(card.cwd, cwd);
    assert.equal(card.command, continueCommandLine(config.claudeBin, cwd, ID));
    const command = await continueCommand(config, { sessionId: ID }, async () => []);
    assert.equal(command.worktreeLaunch, null);
    assert.equal(command.cwd, cwd);
  } finally {
    process.env.PATH = previous;
  }
});

test("a stalled directory check returns instead of waiting", async () => {
  const { home, root } = await tempHome();
  const cwd = path.join(home, "code", "proj");
  await mkdir(cwd, { recursive: true });
  await writeClosed(root, ID, cwd);
  const config = configAt(home, root);
  const previous = process.env.PATH;
  process.env.PATH = `${await sleeperGit(home)}:/usr/bin:/bin`;
  try {
    const started = Date.now();
    const command = await continueCommand(config, { sessionId: ID }, async () => []);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 4500, `elapsed ${elapsed}`);
    assert.ok(elapsed > 700, `elapsed ${elapsed}`);
    assert.equal(command.cwd, cwd);
    assert.equal(command.worktreeLaunch, "project");
  } finally {
    process.env.PATH = previous;
  }
});

test("a tools/call that misses the deadline returns a JSON-RPC error", async () => {
  const { home, root } = await tempHome();
  const cwd = path.join(home, "code", "proj");
  await mkdir(cwd, { recursive: true });
  await writeClosed(root, ID, cwd);
  const token = mintToken();
  await writeToken(home, token);
  const previousPath = process.env.PATH;
  const previousTimeout = process.env.CLAUDE_REMOTE_CALL_TIMEOUT_MS;
  process.env.PATH = `${await sleeperGit(home)}:/usr/bin:/bin`;
  process.env.CLAUDE_REMOTE_CALL_TIMEOUT_MS = "600";
  const listener = await listenHttp(configAt(home, root), 0);
  try {
    const started = Date.now();
    const listed = await post(listener.port, `Bearer ${token}`, {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "list_sessions", arguments: { note: "SECRET-ARGUMENT" } },
    });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2500, `elapsed ${elapsed}`);
    assert.equal(listed.status, 200, listed.body);
    const message = JSON.parse(listed.body) as { id?: number; error?: { code?: number; message?: string } };
    assert.equal(message.id, 7);
    assert.equal(message.error?.code, -32000);
    assert.equal(message.error?.message, "deadline exceeded");
    assert.equal(listed.body.includes(token), false);
    assert.equal(listed.body.includes("SECRET-ARGUMENT"), false);
    assert.equal(listed.stderr.includes("SECRET-ARGUMENT"), false);
    assert.equal(listed.stderr.includes(token), false);
    assert.match(listed.stderr, /"tool":"list_sessions","code":"start"/);
    assert.match(listed.stderr, /"tool":"list_sessions","durationMs":\d+,"code":"error"/);
    const invalid = await post(listener.port, `Bearer ${token}`, {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "bad name SECRET-NAME", arguments: {} },
    });
    assert.equal(invalid.stderr.includes("SECRET-NAME"), false);
    assert.match(invalid.stderr, /"tool":"invalid"/);
  } finally {
    process.env.PATH = previousPath;
    if (previousTimeout == null) delete process.env.CLAUDE_REMOTE_CALL_TIMEOUT_MS;
    else process.env.CLAUDE_REMOTE_CALL_TIMEOUT_MS = previousTimeout;
    await listener.close();
  }
});

test("list_sessions answers from a launchd-like child", { timeout: 20_000 }, async () => {
  const { home, root } = await tempHome();
  const cwd = path.join(home, "Documents", "proj");
  await mkdir(cwd, { recursive: true });
  await writeClosed(root, ID, cwd);
  const token = mintToken();
  await writeToken(home, token);
  const port = await freePort();
  const child = spawn(process.execPath, [
    "--import",
    tsxLoader,
    path.join(repoRoot, "src", "index.ts"),
    "http",
    `--port=${port}`,
  ], {
    cwd: "/",
    env: {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_REMOTE_ALLOW_SEND: "0",
      CLAUDE_REMOTE_ALLOW_LAUNCH: "0",
      CLAUDE_REMOTE_PLATFORM: "darwin",
      CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
      CLAUDE_REMOTE_SPAWN_GUARD: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.destroy();
  assert.equal(child.stdin?.destroyed, true);
  const output = child.stdout as { isTTY?: boolean } | null;
  assert.notEqual(output?.isTTY, true);
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await waitFor(() => stdout.includes("listening="), child, () => stderr);
    const listed = await post(port, `Bearer ${token}`, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_sessions", arguments: { note: "SECRET-ARGUMENT" } },
    }, 8000);
    assert.equal(listed.status, 200, `${listed.body}\n${stderr}`);
    const page = JSON.parse(rpcText(listed.body)) as { sessions?: Array<{ sessionId?: string; cwd?: string }> };
    assert.equal(page.sessions?.some((session) => session.sessionId === ID && session.cwd === cwd), true);
    assert.equal(listed.body.includes(token), false);
    assert.equal(stderr.includes(token), false);
    assert.equal(stderr.includes("SECRET-ARGUMENT"), false);
    assert.match(stderr, /"tool":"list_sessions","code":"start"/);
    assert.match(stderr, /"tool":"list_sessions","durationMs":\d+,"code":"end"/);
    const anon = await post(port, null, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "check", version: "0" } },
    }, 8000);
    assert.equal(anon.status, 401);
  } finally {
    await stopChild(child);
  }
});

async function sleeperGit(home: string): Promise<string> {
  const dir = path.join(home, "sleeper-bin");
  await mkdir(dir, { recursive: true });
  const bin = path.join(dir, "git");
  await writeFile(bin, "#!/bin/sh\nexec sleep 8\n");
  await chmod(bin, 0o755);
  return dir;
}

async function writeClosed(root: string, id: string, cwd: string): Promise<void> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const user = "a1111111-1111-4111-8111-111111111101";
  await writeFile(path.join(dir, `${id}.jsonl`), `${JSON.stringify({
    type: "user",
    uuid: user,
    parentUuid: null,
    sessionId: id,
    timestamp: "2024-01-01T00:00:00.000Z",
    cwd,
    message: { role: "user", content: "closed prompt" },
  })}\n`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address !== "string" ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function waitFor(ready: () => boolean, child: ChildProcess, stderr: () => string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`listener did not start\n${stderr()}`));
    }, 8000);
    const poll = setInterval(() => {
      if (child.exitCode != null) {
        clearInterval(poll);
        clearTimeout(timer);
        reject(new Error(`listener exited ${child.exitCode}\n${stderr()}`));
        return;
      }
      if (!ready()) return;
      clearInterval(poll);
      clearTimeout(timer);
      resolve();
    }, 50);
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.kill("SIGKILL");
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rpcText(body: string): string {
  const message = JSON.parse(body) as { result?: { content?: Array<{ text?: string }> } };
  const text = message.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error(`missing method result ${body}`);
  return text;
}

function post(
  port: number,
  authorization: string | null,
  body: unknown,
  timeoutMs = 8000,
): Promise<{ status: number; body: string; stderr: string }> {
  const payload = JSON.stringify(body);
  const logs: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(" "));
  };
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: `127.0.0.1:${port}`,
      "content-length": String(Buffer.byteLength(payload)),
    };
    if (authorization) headers.authorization = authorization;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        console.error = orig;
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), stderr: logs.join("\n") });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timed out")));
    req.on("error", (error) => {
      console.error = orig;
      reject(error);
    });
    req.end(payload);
  });
}
