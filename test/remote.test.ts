import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listenHttp, type HttpListener } from "../src/http.js";
import { parseConfig, type Config } from "../src/config.js";
import { mintToken, writeToken } from "../src/token.js";
import { DEV_CHANNEL_ACCEPT, DEV_CHANNEL_EXIT, DEV_CHANNEL_WARNING } from "../src/terminal.js";
import { processIdentity } from "../src/registry.js";
import { desktopRoot, repoRoot, shimPath, tempHome } from "./helpers.js";

const fakeTmux = path.join(repoRoot, "scripts", "fake-tmux.mjs");
const ID = "abcdefab-cdef-4def-8aaa-abcdefabcdef";

test("hidden methods stay unregistered, and rename does not echo a title", async () => {
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const listener = await listenHttp(deskConfig(home, root, {}), 0);
  const previousDir = process.env.FAKE_TMUX_DIR;
  process.env.FAKE_TMUX_DIR = path.join(home, "tmux");
  try {
    const names = await toolNames(listener, token);
    assert.deepEqual(names, ["list_sessions", "get_session", "continue_command", "rename_session", "cleanup_desk", "list_pending"]);
    const renamed = await toolCall(listener, token, "rename_session", { sessionId: ID, title: "SECRET-TITLE" }, 3);
    assert.equal(renamed.isError, true);
    assert.match(renamed.text, /no documented route|does not edit transcript files/);
    assert.equal(renamed.text.includes("SECRET-TITLE"), false);
    const cleaned = JSON.parse(await toolCall(listener, token, "cleanup_desk", {}, 4).then((item) => item.text)) as { sockets: number };
    assert.equal(typeof cleaned.sockets, "number");
    const hidden = await toolCall(listener, token, "new_session", { folder: root }, 5);
    assert.equal(hidden.isError, true);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "new-session"), false);
  } finally {
    restore("FAKE_TMUX_DIR", previousDir);
    await listener.close();
  }
});

test("send still requires confirm, and launch methods appear only behind the gate", async () => {
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const listener = await listenHttp(deskConfig(home, root, { send: true, launch: true }), 0);
  try {
    const names = await toolNames(listener, token);
    assert.deepEqual(names, [
      "list_sessions",
      "get_session",
      "continue_command",
      "rename_session",
      "cleanup_desk",
      "send_followup",
      "queue_status",
      "new_session",
      "continue_session",
      "stop_session",
      "list_pending",
    ]);
    const denied = await toolCall(listener, token, "send_followup", {
      sessionId: ID,
      message: "hello",
      confirm: false,
    }, 3);
    assert.equal(denied.isError, true);
    assert.match(denied.text, /confirm must be true|expected true/);
    const bare = await toolCall(listener, token, "stop_session", {}, 4);
    assert.equal(bare.isError, true);
    assert.match(bare.text, /code=usage/);
  } finally {
    await listener.close();
  }
});

test("new_session sends Enter only when the accept line is highlighted", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const token = mintToken();
  await writeToken(home, token);
  const listener = await listenHttp(deskConfig(home, root, { launch: true }), 0);
  const pane = path.join(home, "tmux", "pane.txt");
  await mkdir(path.dirname(pane), { recursive: true });
  const previousDir = process.env.FAKE_TMUX_DIR;
  process.env.FAKE_TMUX_DIR = path.join(home, "tmux");
  try {
    await writeFile(pane, "Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n");
    const blocked = await toolCall(listener, token, "new_session", {
      folder,
      name: "sdtrust",
      acceptDevChannelPrompt: true,
    }, 3);
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /code=blocked-by-dialog dialog=workspace-trust/);
    assert.equal(blocked.text.includes("trust this folder"), false);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "send-keys"), false);

    await rm(path.join(home, "tmux", "log.jsonl"), { force: true });
    await writeFile(pane, `${DEV_CHANNEL_WARNING}\n  ${DEV_CHANNEL_ACCEPT}\n❯ ${DEV_CHANNEL_EXIT}\n`);
    const other = await toolCall(listener, token, "new_session", {
      folder,
      name: "sdother",
      acceptDevChannelPrompt: true,
    }, 4);
    assert.equal(other.isError, true);
    assert.equal(other.text.includes(DEV_CHANNEL_ACCEPT), false);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "send-keys"), false);

    await rm(path.join(home, "tmux", "log.jsonl"), { force: true });
    await writeFile(pane, `${DEV_CHANNEL_WARNING}\n❯ ${DEV_CHANNEL_ACCEPT}\n  ${DEV_CHANNEL_EXIT}\nNew MCP server found in this project: claude-remote-channel\n`);
    const mcp = await toolCall(listener, token, "new_session", {
      folder,
      name: "sdmcp",
      acceptDevChannelPrompt: true,
    }, 5);
    assert.equal(mcp.isError, true);
    assert.match(mcp.text, /code=blocked-by-dialog dialog=mcp-server/);
    assert.equal(mcp.text.includes("claude-remote-channel"), false);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "send-keys"), false);

    await withSessionEnv(root, async () => {
      await rm(path.join(home, "tmux", "log.jsonl"), { force: true });
      await writeFile(pane, `${DEV_CHANNEL_WARNING}\n❯ ${DEV_CHANNEL_ACCEPT}\n  ${DEV_CHANNEL_EXIT}\n`);
      const started = await toolCall(listener, token, "new_session", {
        folder,
        name: "sdaccept",
        acceptDevChannelPrompt: true,
      }, 6);
      assert.equal(started.isError, false, started.text);
      const body = JSON.parse(started.text) as { sessionId: string };
      assert.equal(body.sessionId, ID);
      const keys = await tmuxCommands(home);
      assert.equal(keys.some((args) => args[0] === "send-keys" && args.includes("Enter")), true);
      await writeFile(pane, "prompt\n");
      const stopped = await toolCall(listener, token, "stop_session", { sessionId: ID }, 7);
      assert.equal(stopped.isError, false, stopped.text);
      const stopBody = JSON.parse(stopped.text) as { stopped: string };
      assert.equal(stopBody.stopped, "exited");
    });
  } finally {
    restore("FAKE_TMUX_DIR", previousDir);
    await listener.close();
  }
});

test("continue_session refuses a live owner until that pid is gone", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  await writeClosed(root, ID, folder);
  const token = mintToken();
  await writeToken(home, token);
  const listener = await listenHttp(deskConfig(home, root, { launch: true }), 0);
  const previousDir = process.env.FAKE_TMUX_DIR;
  process.env.FAKE_TMUX_DIR = path.join(home, "tmux");
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const closed = new Promise((resolve) => child.once("close", resolve));
  try {
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    if (pid == null) return;
    const identity = await processIdentity(pid);
    assert.equal(typeof identity.startToken, "string");
    await writeRecord(root, pid, {
      pid,
      sessionId: ID,
      procStart: identity.startToken,
      entrypoint: "claude-desktop",
      status: "idle",
    });
    const refused = await toolCall(listener, token, "continue_session", { sessionId: ID, name: "sdcont" }, 3);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /code=live-owner/);
    assert.equal(refused.text.includes("closed prompt"), false);
    const forced = await toolCall(listener, token, "continue_session", {
      sessionId: ID,
      name: "sdcont",
      confirmLiveOwner: true,
    }, 4);
    assert.equal(forced.isError, true);
    assert.match(forced.text, /code=live-owner/);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "new-session"), false);
  } finally {
    restore("FAKE_TMUX_DIR", previousDir);
    child.kill("SIGKILL");
    await listener.close();
  }
  await closed;
});

function deskConfig(home: string, root: string, flags: { send?: boolean; launch?: boolean }): Config {
  return parseConfig({
    CLAUDE_CONFIG_DIR: root,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
    CLAUDE_REMOTE_ALLOW_SEND: flags.send ? "1" : "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: flags.launch ? "1" : "0",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    CLAUDE_REMOTE_TMUX_BIN: fakeTmux,
    CLAUDE_REMOTE_LAUNCH_WAIT_MS: "400",
  }, { home, platform: "linux" });
}

async function withSessionEnv(root: string, fn: () => Promise<void>): Promise<void> {
  const previous = {
    dir: process.env.FAKE_TMUX_DIR,
    pid: process.env.FAKE_TMUX_PID,
    session: process.env.FAKE_TMUX_SESSION,
    record: process.env.FAKE_TMUX_RECORD_DIR,
  };
  process.env.FAKE_TMUX_PID = "5151";
  process.env.FAKE_TMUX_SESSION = ID;
  process.env.FAKE_TMUX_RECORD_DIR = root;
  try {
    await fn();
  } finally {
    restore("FAKE_TMUX_DIR", previous.dir);
    restore("FAKE_TMUX_PID", previous.pid);
    restore("FAKE_TMUX_SESSION", previous.session);
    restore("FAKE_TMUX_RECORD_DIR", previous.record);
  }
}

function restore(key: string, value: string | undefined): void {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}

async function toolNames(listener: HttpListener, token: string): Promise<string[]> {
  await post(listener.port, token, initializeBody(1));
  const listed = await post(listener.port, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.equal(listed.status, 200, listed.body);
  const message = JSON.parse(listed.body) as { result?: { tools?: Array<{ name?: string }> } };
  return (message.result?.tools ?? []).flatMap((tool) => typeof tool.name === "string" ? [tool.name] : []);
}

async function toolCall(
  listener: HttpListener,
  token: string,
  name: string,
  args: unknown,
  id: number,
): Promise<{ isError: boolean; text: string }> {
  const response = await post(listener.port, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
  assert.equal(response.status, 200, response.body);
  const message = JSON.parse(response.body) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  if (message.error) return { isError: true, text: message.error.message ?? "" };
  return {
    isError: message.result?.isError === true,
    text: message.result?.content?.[0]?.text ?? "",
  };
}

function initializeBody(id: number): unknown {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-remote-proof", version: "0.1.0" },
    },
  };
}

function post(port: number, authorization: string, body: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${authorization}`,
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

async function tmuxCommands(home: string): Promise<string[][]> {
  try {
    const text = await readFile(path.join(home, "tmux", "log.jsonl"), "utf8");
    return text.trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
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

async function writeRecord(root: string, pid: number, body: unknown): Promise<void> {
  const dir = path.join(root, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${pid}.json`), JSON.stringify(body));
}
