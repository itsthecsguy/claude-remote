import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repoRoot, tempDir } from "./helpers.js";

test("a clean machine with an empty home initializes and lists no sessions", async () => {
  const home = await tempDir("clean");
  const env = cleanEnv(home);
  const tokenFile = path.join(home, ".claude-remote", "http", "token");
  let child: ChildProcess | undefined;
  try {
    const rotated = await run(["rotate-token"], env);
    assert.equal(rotated.code, 0, redact(rotated.stderr, ""));
    assert.equal(existsSync(path.join(home, ".claude")), false);
    const token = (await readFile(tokenFile, "utf8")).trim();
    assert.match(token, /^[A-Za-z0-9_-]{43,}$/);
    const port = await freePort();
    const stderr: Buffer[] = [];
    child = spawn(process.execPath, [tsxCli(), sourceEntry(), "http", `--port=${port}`], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    await waitForPort(port, child, stderr);
    const ready = await post(port, token, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "clean-machine", version: "0" },
      },
    });
    assert.equal(ready.status, 200, redact(ready.body, token));
    assert.equal(ready.body.startsWith("event:"), false);
    const initialized = JSON.parse(ready.body) as { result?: { serverInfo?: { name?: string } } };
    assert.equal(initialized.result?.serverInfo?.name, "claude-remote");
    assert.equal(ready.body.includes(token), false);
    const listed = await post(port, token, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_sessions", arguments: {} },
    });
    assert.equal(listed.status, 200, redact(listed.body, token));
    assert.equal(listed.body.startsWith("event:"), false);
    const message = JSON.parse(listed.body) as { result?: { content?: Array<{ text?: string }> } };
    const text = message.result?.content?.[0]?.text;
    assert.equal(typeof text, "string");
    const page = JSON.parse(text ?? "") as { sessions?: unknown[]; scannedFileCount?: number };
    assert.deepEqual(page.sessions, []);
    assert.equal(page.scannedFileCount, 0);
    assert.equal(listed.body.includes(token), false);
    assert.equal(Buffer.concat(stderr).toString("utf8").includes(token), false);
  } finally {
    if (child) await stop(child);
    await rm(home, { recursive: true, force: true });
  }
});

function tsxCli(): string {
  const cli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  if (!existsSync(cli)) throw new Error("tsx is not installed");
  return cli;
}

function sourceEntry(): string {
  return path.join(repoRoot, "src", "index.ts");
}

function cleanEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: "/tmp",
    LANG: "C",
    CLAUDE_REMOTE_SPAWN_GUARD: "1",
  };
  if (process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  return env;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli(), sourceEntry(), ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForPort(port: number, child: ChildProcess, stderr: Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error(`server did not listen: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    }, 15000);
    const poll = (): void => {
      if (settled) return;
      if (child.exitCode != null) {
        finish(new Error(`server exited ${child.exitCode}: ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`));
        return;
      }
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        finish();
      });
      socket.once("error", () => {
        socket.destroy();
        if (!settled) setTimeout(poll, 50);
      });
    };
    poll();
  });
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function post(port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        host: `127.0.0.1:${port}`,
        "content-length": String(Buffer.byteLength(payload)),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}

function redact(text: string, token: string): string {
  return token.length > 0 ? text.split(token).join("<token>") : text;
}
