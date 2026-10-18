import assert from "node:assert/strict";
import http from "node:http";
import { stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { listenHttp } from "../src/http.js";
import { bearerMatches, mintToken, readToken, tokenDirectory, tokenPath, writeToken } from "../src/token.js";
import { captureError, configAt, tempHome } from "./helpers.js";

test("a bearer mismatch and a foreign origin are rejected", async () => {
  const { home, root } = await tempHome();
  await writeToken(home, mintToken());
  const token = await readToken(home);
  assert.ok(token);
  assert.equal((await stat(tokenPath(home))).mode & 0o777, 0o600);
  assert.equal((await stat(tokenDirectory(home))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(home, ".claude-remote"))).mode & 0o777, 0o700);
  assert.equal(bearerMatches(null, token), false);
  assert.equal(bearerMatches(`Bearer ${"a".repeat(43)}`, token), false);
  assert.equal(bearerMatches(`Bearer ${token}`, token), true);
  const listener = await listenHttp(configAt(home, root), 0);
  const next = mintToken();
  try {
    const logs = await captureError(async () => {
      const missing = await post(listener.port, null);
      assert.equal(missing.status, 401);
      const wrong = await post(listener.port, `Bearer ${"b".repeat(43)}`);
      assert.equal(wrong.status, 401);
      const foreignHost = await post(listener.port, `Bearer ${token}`, { host: "evil.example" });
      assert.equal(foreignHost.status, 403);
      const foreignOrigin = await post(listener.port, `Bearer ${token}`, { origin: "https://evil.example" });
      assert.equal(foreignOrigin.status, 403);
      const ready = await post(listener.port, `Bearer ${token}`, {}, initializeBody());
      assert.equal(ready.status, 200, ready.body);
      assert.equal(ready.body.includes(token), false);
      const listed = await post(listener.port, `Bearer ${token}`, {}, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_sessions", arguments: {} },
      });
      assert.equal(listed.status, 200, listed.body);
      const page = JSON.parse(rpcText(listed.body)) as { sessions?: unknown };
      assert.equal(Array.isArray(page.sessions), true);
      assert.equal(listed.body.includes(token), false);
      await writeToken(home, next);
      const stale = await post(listener.port, `Bearer ${token}`);
      assert.equal(stale.status, 401);
      const fresh = await post(listener.port, `Bearer ${next}`, {}, initializeBody());
      assert.equal(fresh.status, 200, fresh.body);
    });
    assert.equal(logs.includes(token), false);
    assert.equal(logs.includes(next), false);
  } finally {
    await listener.close();
  }
});

function rpcText(body: string): string {
  const message = JSON.parse(body) as { result?: { content?: Array<{ text?: string }> } };
  const text = message.result?.content?.[0]?.text;
  if (typeof text !== "string") throw new Error("missing method result");
  return text;
}

function initializeBody(): unknown {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "claude-remote-proof", version: "0.1.0" },
    },
  };
}

function post(
  port: number,
  authorization: string | null,
  extra: { host?: string; origin?: string } = {},
  body: unknown = initializeBody(),
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      host: extra.host ?? `127.0.0.1:${port}`,
      "content-length": String(Buffer.byteLength(payload)),
    };
    if (authorization) headers.authorization = authorization;
    if (extra.origin) headers.origin = extra.origin;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/mcp",
      method: "POST",
      headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
