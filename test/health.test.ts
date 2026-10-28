import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { readTail, trimLog } from "../src/files.js";
import { classify, localProbeUrl, looksOffline, parseLaunchctlPrint, probeUrl, quickTunnelUrl, summarizeTunnelLog, type Fetcher, type ProbeResponse } from "../src/health.js";
import { listenHttp } from "../src/http.js";
import { mintToken, writeToken } from "../src/token.js";
import { configAt, tempHome } from "./helpers.js";

function response(status: number, headers: Record<string, string> = {}): ProbeResponse {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return { status, headers: { get: (name) => lower[name.toLowerCase()] ?? null } };
}

test("a probe recognises the helper's challenge and names every other outcome", async () => {
  assert.deepEqual(classify(response(401, { "WWW-Authenticate": 'Bearer realm="claude-remote"' })), { state: "answers", status: 401, detail: null });
  assert.deepEqual(classify(response(401, { "WWW-Authenticate": 'Bearer realm="other"' })), { state: "unexpected", status: 401, detail: "foreign-401" });
  assert.deepEqual(classify(response(403)), { state: "host-rejected", status: 403, detail: "http-403" });
  assert.deepEqual(classify(response(530)), { state: "tunnel-error", status: 530, detail: "http-530" });
  assert.deepEqual(classify(response(502)), { state: "tunnel-error", status: 502, detail: "http-502" });
  assert.deepEqual(classify(response(200)), { state: "unexpected", status: 200, detail: "http-200" });
  const dns = await probeUrl("https://gone.example/mcp", { fetcher: async () => { throw Object.assign(new Error("x"), { code: "ENOTFOUND" }); } });
  assert.deepEqual(dns, { state: "unreachable", status: null, detail: "ENOTFOUND" });
  assert.equal(looksOffline(dns), true);
  const nested = await probeUrl("https://gone.example/mcp", { fetcher: async () => { throw new TypeError("fetch failed", { cause: Object.assign(new Error("y"), { code: "ECONNREFUSED" }) }); } });
  assert.equal(nested.detail, "ECONNREFUSED");
  assert.equal(looksOffline(nested), false);
  const timeout = await probeUrl("https://gone.example/mcp", { fetcher: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
  assert.equal(timeout.detail, "timeout");
});

/** fetch refuses to send a custom Host header, so a forwarded-looking request is made with node:http. */
function viaHost(host: string): Fetcher {
  return (url) => new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: { host, origin: `https://${host}`, accept: "application/json" },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: { get: (name) => {
        const value = res.headers[name.toLowerCase()];
        return Array.isArray(value) ? value[0] ?? null : value ?? null;
      } } }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the real listener answers the local probe without a token, and a probe through a public Host is refused unless allowed", async () => {
  const { home, root } = await tempHome();
  await writeToken(home, mintToken());
  const listener = await listenHttp(configAt(home, root), 0);
  try {
    const probe = await probeUrl(localProbeUrl(listener.port));
    assert.deepEqual(probe, { state: "answers", status: 401, detail: null });
    const foreign = await probeUrl(localProbeUrl(listener.port), { fetcher: viaHost("remote.example.com") });
    assert.equal(foreign.state, "host-rejected");
  } finally {
    await listener.close();
  }
  const allowed = await listenHttp({ ...configAt(home, root), publicHosts: ["remote.example.com"] }, 0);
  try {
    const probe = await probeUrl(localProbeUrl(allowed.port), { fetcher: viaHost("remote.example.com") });
    assert.equal(probe.state, "answers");
    const other = await probeUrl(localProbeUrl(allowed.port), { fetcher: viaHost("other.example.com") });
    assert.equal(other.state, "host-rejected");
  } finally {
    await allowed.close();
  }
});

const LOG = [
  `{"level":"info","time":"2026-10-24T04:31:30Z","message":"Requesting new quick Tunnel on trycloudflare.com..."}`,
  `{"level":"info","time":"2026-10-24T04:31:31Z","message":"|  https://old-name.trycloudflare.com  |"}`,
  `{"level":"info","time":"2026-10-24T04:31:32Z","message":"Registered tunnel connection","connIndex":0}`,
  `2026-10-24T22:08:18Z INF Retrying connection in up to 16s connIndex=0`,
  `{"level":"info","time":"2026-10-24T23:13:28Z","message":"Retrying connection in up to 1m4s","connIndex":0}`,
  `{"level":"info","time":"2026-10-24T23:14:32Z","message":"Retrying connection in up to 1m4s","connIndex":0}`,
  "not json at all",
].join("\n");

test("the tunnel log summary reads both JSON and text lines and knows the newest event", () => {
  const now = Date.parse("2026-10-24T23:20:00Z");
  const summary = summarizeTunnelLog(LOG, now);
  assert.equal(summary.lastRegistered, "2026-10-24T04:31:32Z");
  assert.equal(summary.lastRetry, "2026-10-24T23:14:32Z");
  assert.equal(summary.lastStart, "2026-10-24T04:31:30Z");
  assert.equal(summary.retriesLast10m, 2);
  assert.equal(summary.connected, false);
  assert.equal(summary.url, "https://old-name.trycloudflare.com/mcp");
  const recovered = summarizeTunnelLog(`${LOG}\n{"level":"info","time":"2026-10-24T23:15:00Z","message":"Registered tunnel connection"}`, now);
  assert.equal(recovered.connected, true);
  assert.equal(summarizeTunnelLog("", now).connected, null);
  assert.equal(quickTunnelUrl("none here"), null);
});

test("the live quick-tunnel URL comes from the end of a log larger than a megabyte", async () => {
  const { home } = await tempHome();
  const log = path.join(home, "cloudflared.log");
  const filler = `${JSON.stringify({ level: "error", time: "2026-10-25T00:00:00Z", message: "Serve tunnel error", error: "control stream encountered a failure while serving" })}\n`;
  const head = "https://stale-name.trycloudflare.com\n";
  const tail = "https://live-name.trycloudflare.com\n";
  await writeFile(log, head + filler.repeat(Math.ceil(1_500_000 / filler.length)) + tail);
  assert.equal(quickTunnelUrl(await readTail(log, 1024 * 1024)), "https://live-name.trycloudflare.com/mcp");
  assert.equal(quickTunnelUrl((await readTail(log, 200)).slice(0, 10)), null);
  const link = path.join(home, "link.log");
  await symlink(log, link);
  assert.equal(await readTail(link, 1024), "");
  assert.equal(await readTail(path.join(home, "missing.log"), 1024), "");
});

test("trimLog keeps the tail in a .1 file and truncates in place, and leaves small logs alone", async () => {
  const { home } = await tempHome();
  const dir = path.join(home, "logs");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const log = path.join(dir, "big.log");
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  await writeFile(log, lines, { mode: 0o600 });
  assert.equal(await trimLog(log, 1_000_000, 100), null);
  const trimmed = await trimLog(log, 1000, 100);
  assert.ok(trimmed && trimmed.before > 1000 && trimmed.after === 0);
  const kept = await readTail(`${log}.1`, 10_000);
  assert.match(kept, /^line \d+\n/);
  assert.match(kept, /line 1999\n$/);
  assert.equal(await readTail(log, 10), "");
});

test("launchctl print output is reduced to loaded, state, pid, exit code, and runs", () => {
  const text = [
    "com.claude-remote.tunnel = {",
    "\tactive count = 1",
    "\tpath = /Users/nick/Library/LaunchAgents/com.claude-remote.tunnel.plist",
    "\tstate = running",
    "\tprogram = /opt/homebrew/bin/cloudflared",
    "\truns = 2",
    "\tpid = 9688",
    "\tlast exit code = 0",
    "}",
  ].join("\n");
  assert.deepEqual(parseLaunchctlPrint(0, text), { loaded: true, state: "running", pid: 9688, lastExitCode: 0, runs: 2 });
  assert.deepEqual(parseLaunchctlPrint(0, "\tstate = running\n\tpid = 1380\n\truns = 1\n\tlast exit code = (never exited)\n"), { loaded: true, state: "running", pid: 1380, lastExitCode: null, runs: 1 });
  assert.deepEqual(parseLaunchctlPrint(0, "\tstate = not running\n\tlast exit code = 78\n\truns = 4\n"), { loaded: true, state: "not running", pid: null, lastExitCode: 78, runs: 4 });
  assert.deepEqual(parseLaunchctlPrint(113, ""), { loaded: false, state: null, pid: null, lastExitCode: null, runs: null });
});
