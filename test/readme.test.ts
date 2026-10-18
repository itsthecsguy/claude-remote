import assert from "node:assert/strict";
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listenHttp } from "../src/http.js";
import { parseConfig } from "../src/config.js";
import { mintToken, writeToken } from "../src/token.js";
import { desktopRoot, repoRoot, shimPath, tempHome } from "./helpers.js";

const fakeTmux = path.join(repoRoot, "scripts", "fake-tmux.mjs");

test("the threat model lists the same methods as tools/list", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  const marked = readme.split("With both flags the registered methods are ")[1]?.split(".")[0];
  assert.ok(marked);
  const documented = marked.replaceAll("`", "").split(",").map((part) => part.replace(/^\s*and\s+/, "").trim());
  assert.ok(documented.includes("queue_status"));
  assert.match(readme, /`install --allow-send` registers `send_followup` and `queue_status`/);
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const listener = await listenHttp(parseConfig({
    CLAUDE_CONFIG_DIR: root,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
    CLAUDE_REMOTE_ALLOW_SEND: "1",
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    CLAUDE_REMOTE_TMUX_BIN: fakeTmux,
  }, { home, platform: "linux" }), 0);
  try {
    const names = await toolNames(listener.port, token);
    assert.deepEqual(documented, names);
  } finally {
    await listener.close();
  }
});

async function toolNames(port: number, token: string): Promise<string[]> {
  const ready = await post(port, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-remote-proof", version: "0.1.0" },
    },
  });
  assert.equal(ready.status, 200, ready.body);
  const listed = await post(port, token, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.status, 200, listed.body);
  const message = JSON.parse(listed.body) as { result?: { tools?: Array<{ name?: string }> } };
  return (message.result?.tools ?? []).map((item) => item.name ?? "");
}

function post(port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
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
