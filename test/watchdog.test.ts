import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readTail } from "../src/files.js";
import type { Probe } from "../src/health.js";
import { HTTP_LABEL, TUNNEL_LABEL } from "../src/launchd.js";
import { writeTunnelSettings } from "../src/tunnel.js";
import { readWatchdogState, runWatchdog, sendTunnelEvent, tunnelLogPath, watchdogStatePath, type TunnelEvent, type WatchdogInput } from "../src/watchdog.js";
import { captureError, tempHome } from "./helpers.js";

const ANSWERS: Probe = { state: "answers", status: 401, detail: null };
const DEAD: Probe = { state: "tunnel-error", status: 530, detail: "http-530" };
const OFFLINE: Probe = { state: "unreachable", status: null, detail: "ENOTFOUND" };

function harness(home: string, answers: { local: Probe; remote: Probe | ((url: string) => Probe) }, patch: Partial<WatchdogInput> = {}) {
  const calls: string[] = [];
  const events: TunnelEvent[] = [];
  let clock = Date.parse("2026-10-25T10:00:00Z");
  const input: WatchdogInput = {
    home,
    uid: 501,
    port: 47321,
    launchctlBin: "/fake/launchctl",
    settings: { mode: "quick" },
    run: async (bin, args) => {
      calls.push(`${path.basename(bin)} ${args.join(" ")}`);
      return { code: 0, stdout: "", stderr: "" };
    },
    probe: async (url) => {
      if (url.startsWith("http://127.0.0.1:")) return answers.local;
      return typeof answers.remote === "function" ? answers.remote(url) : answers.remote;
    },
    notify: async (event) => {
      events.push(event);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    urlWaitMs: 2000,
    ...patch,
  };
  return { input, calls, events, advance: (ms: number) => { clock += ms; } };
}

async function writeTunnelLog(home: string, lines: string[]): Promise<void> {
  const file = tunnelLogPath(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, lines.map((line) => `${line}\n`).join(""), { mode: 0o600 });
}

const url = (name: string, time: string): string[] => [
  JSON.stringify({ level: "info", time, message: "Requesting new quick Tunnel on trycloudflare.com..." }),
  JSON.stringify({ level: "info", time, message: `|  https://${name}.trycloudflare.com  |` }),
  JSON.stringify({ level: "info", time, message: "Registered tunnel connection" }),
];

test("a healthy run restarts nothing and records the URL", async () => {
  const { home } = await tempHome();
  await writeTunnelLog(home, url("live-name", "2026-10-25T09:00:00Z"));
  const h = harness(home, { local: ANSWERS, remote: ANSWERS });
  const logs = await captureError(async () => {
    const report = await runWatchdog(h.input);
    assert.equal(report.verdict, "ok");
    assert.equal(report.url, "https://live-name.trycloudflare.com/mcp");
    assert.equal(report.publicFailures, 0);
  });
  assert.deepEqual(h.calls, []);
  assert.match(logs, /"tool":"watchdog".*"code":"ok"/);
  const state = await readWatchdogState(home);
  assert.equal(state.lastUrl, "https://live-name.trycloudflare.com/mcp");
  assert.equal(state.lastVerdict, "ok");
  assert.equal((await stat(watchdogStatePath(home))).mode & 0o777, 0o600);
});

test("a helper that stops answering on 127.0.0.1 is kickstarted, and the tunnel is left alone that run", async () => {
  const { home } = await tempHome();
  await writeTunnelLog(home, url("live-name", "2026-10-25T09:00:00Z"));
  const h = harness(home, { local: { state: "unreachable", status: null, detail: "ECONNREFUSED" }, remote: DEAD });
  const report = await runWatchdog(h.input);
  assert.equal(report.verdict, "helper-restarted");
  assert.equal(report.helperRestarted, true);
  assert.equal(report.public, null);
  assert.deepEqual(h.calls, [`launchctl kickstart -k gui/501/${HTTP_LABEL}`]);
  assert.equal((await readWatchdogState(home)).helperRestarts, 1);
  const unloaded = harness(home, { local: { state: "unreachable", status: null, detail: "ECONNREFUSED" }, remote: DEAD }, {
    run: async (_bin, args) => ({ code: args[0] === "kickstart" ? 113 : 0, stdout: "", stderr: "" }),
  });
  const booted = await runWatchdog(unloaded.input);
  assert.equal(booted.verdict, "helper-restarted");
});

test("a dead quick tunnel is restarted on the second consecutive failure, the new URL is read from the log, and a cooldown prevents churn", async () => {
  const { home } = await tempHome();
  await writeTunnelLog(home, url("dead-name", "2026-10-25T09:00:00Z"));
  const h = harness(home, { local: ANSWERS, remote: DEAD });
  const first = await runWatchdog(h.input);
  assert.equal(first.verdict, "tunnel-failing");
  assert.equal(first.publicFailures, 1);
  assert.equal(first.tunnelRestarted, false);
  assert.deepEqual(h.calls, []);
  h.advance(120_000);
  // The restart hook appends the new hostname to the log, as cloudflared does when it comes back.
  h.input.run = async (bin, args) => {
    h.calls.push(`${path.basename(bin)} ${args.join(" ")}`);
    if (args[0] === "kickstart") {
      const file = tunnelLogPath(home);
      await writeFile(file, (await readFile(file, "utf8")) + url("fresh-name", "2026-10-25T10:02:05Z").map((line) => `${line}\n`).join(""));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  const second = await runWatchdog(h.input);
  assert.equal(second.verdict, "tunnel-restarted");
  assert.equal(second.tunnelRestarted, true);
  assert.equal(second.newUrl, "https://fresh-name.trycloudflare.com/mcp");
  assert.equal(second.urlChanged, true);
  assert.deepEqual(h.calls, [`launchctl kickstart -k gui/501/${TUNNEL_LABEL}`]);
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]?.event, "url-changed");
  assert.equal(h.events[0]?.url, "https://fresh-name.trycloudflare.com/mcp");
  assert.equal(h.events[0]?.previousUrl, "https://dead-name.trycloudflare.com/mcp");
  const state = await readWatchdogState(home);
  assert.equal(state.tunnelRestarts, 1);
  assert.equal(state.publicFailures, 0);
  assert.equal(state.lastUrl, "https://fresh-name.trycloudflare.com/mcp");
  // Still failing right after a restart: count, but wait out the cooldown before restarting again.
  h.calls.length = 0;
  h.advance(120_000);
  await runWatchdog(h.input);
  h.advance(120_000);
  const held = await runWatchdog(h.input);
  assert.equal(held.verdict, "tunnel-failing");
  assert.equal(held.skipped, "cooldown");
  assert.deepEqual(h.calls, []);
  h.advance(10 * 60_000);
  const again = await runWatchdog(h.input);
  assert.equal(again.tunnelRestarted, true);
});

test("no network means no restart, a named tunnel keeps its URL, and funnel or none never restart", async () => {
  const { home } = await tempHome();
  const h = harness(home, { local: ANSWERS, remote: OFFLINE });
  await writeTunnelLog(home, url("live-name", "2026-10-25T09:00:00Z"));
  for (let i = 0; i < 3; i += 1) {
    const report = await runWatchdog(h.input);
    assert.equal(report.verdict, "offline");
    assert.equal(report.skipped, "offline");
    h.advance(120_000);
  }
  assert.deepEqual(h.calls, []);

  const named = harness(home, { local: ANSWERS, remote: DEAD }, { settings: { mode: "named", name: "claude-remote", hostname: "remote.example.com", credentialsFile: null } });
  await writeFile(watchdogStatePath(home), JSON.stringify({ publicFailures: 1 }));
  const restarted = await runWatchdog(named.input);
  assert.equal(restarted.url, "https://remote.example.com/mcp");
  assert.equal(restarted.tunnelRestarted, true);
  assert.equal(restarted.newUrl, "https://remote.example.com/mcp");
  assert.equal(restarted.urlChanged, false);
  assert.equal(named.events[0]?.event, "tunnel-restarted");

  const funnel = harness(home, { local: ANSWERS, remote: DEAD }, { settings: { mode: "funnel", hostname: "mac.tail1234.ts.net" } });
  await writeFile(watchdogStatePath(home), JSON.stringify({ publicFailures: 5 }));
  const funnelReport = await runWatchdog(funnel.input);
  assert.equal(funnelReport.verdict, "funnel-failing");
  assert.equal(funnelReport.skipped, "no-process");
  assert.deepEqual(funnel.calls, []);

  const none = harness(home, { local: ANSWERS, remote: DEAD }, { settings: { mode: "none", hostname: null } });
  const noneReport = await runWatchdog(none.input);
  assert.equal(noneReport.verdict, "no-tunnel");
  assert.equal(noneReport.public, null);
  assert.deepEqual(none.calls, []);
});

test("the watchdog trims an oversized tunnel log and keeps its tail", async () => {
  const { home } = await tempHome();
  const filler = `${JSON.stringify({ level: "error", time: "2026-10-25T00:00:00Z", message: "Serve tunnel error" })}\n`;
  const file = tunnelLogPath(home);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, filler.repeat(400) + url("live-name", "2026-10-25T09:00:00Z").map((line) => `${line}\n`).join(""), { mode: 0o600 });
  const h = harness(home, { local: ANSWERS, remote: ANSWERS }, { maxLogBytes: 10_000, keepLogBytes: 2_000 });
  const report = await runWatchdog(h.input);
  assert.deepEqual(report.trimmed, ["cloudflared.log"]);
  assert.equal(report.url, "https://live-name.trycloudflare.com/mcp");
  assert.equal((await stat(file)).size, 0);
  assert.match(await readTail(`${file}.1`, 10_000), /live-name/);
});

test("a tunnel event goes to the alert URL with the same signing as pending alerts", async () => {
  const { home } = await tempHome();
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  assert.equal(await sendTunnelEvent(home, { type: "claude-remote.tunnel", event: "url-changed", url: "https://x/mcp", previousUrl: null, at: "2026-10-25T10:00:00Z" }, async () => 200, {}), false);
  const notify = path.join(home, ".claude-remote", "http", "notify.json");
  await mkdir(path.dirname(notify), { recursive: true, mode: 0o700 });
  await writeFile(notify, JSON.stringify({ url: "https://alerts.example/hook", secret: "0123456789abcdef0123" }), { mode: 0o600 });
  const ok = await sendTunnelEvent(home, { type: "claude-remote.tunnel", event: "url-changed", url: "https://x/mcp", previousUrl: null, at: "2026-10-25T10:00:00Z" }, async (target, init) => {
    sent.push({ url: target, headers: init.headers, body: init.body });
    return 204;
  }, {});
  assert.equal(ok, true);
  assert.equal(sent[0]?.url, "https://alerts.example/hook");
  assert.equal(sent[0]?.headers["x-claude-remote-delivery"], "tunnel.2026-10-25T10:00:00Z");
  assert.match(sent[0]?.headers["x-claude-remote-signature"] ?? "", /^sha256=[0-9a-f]{64}$/);
  assert.equal(JSON.parse(sent[0]?.body ?? "{}").event, "url-changed");
});
