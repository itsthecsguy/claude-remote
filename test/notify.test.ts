import assert from "node:assert/strict";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { executeInstall, executeUninstall, type InstallHooks, type InstallInput } from "../src/install.js";
import { listenHttp } from "../src/http.js";
import {
  checkNotifyUrl,
  describeNotifyUrl,
  loadNotifySettings,
  notifyFilePath,
  notifyPayload,
  Notifier,
  signBody,
  startNotifier,
  type NotifySend,
  type NotifySettings,
} from "../src/notify.js";
import { PendingStore, pendingStore } from "../src/pending.js";
import { mintToken, writeToken } from "../src/token.js";
import { tempHome } from "./helpers.js";

const SESSION = "56565656-5656-4565-8565-565656565656";
const SECRET = "s3cret-value-for-tests-0123456789";
const WAIT = { allowApprove: false, waitMs: 0 };

function settings(patch: Partial<NotifySettings> = {}): NotifySettings {
  return { url: "https://example.test/hook?key=abc", secret: null, auth: "hmac", includeText: false, cleared: false, ...patch };
}

function permission(session = SESSION, command = "rm -rf build"): Record<string, unknown> {
  return { session_id: session, hook_event_name: "PermissionRequest", cwd: "/work/demo-app", tool_name: "Bash", tool_input: { command } };
}

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function capture(statuses: number[] = []): { send: NotifySend; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return statuses.shift() ?? 200;
    },
  };
}

function quietLogs(): { lines: string[]; restore: () => void } {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return { lines, restore: () => { console.error = original; } };
}

test("an alert carries ids and names only unless text is opted in", async () => {
  const store = new PendingStore();
  const out = capture();
  const { notifier, stop } = startNotifier(store, settings(), { send: out.send });
  const logs = quietLogs();
  try {
    const { requestId } = store.record(permission(), WAIT);
    await notifier.idle();
    assert.equal(out.sent.length, 1);
    const body = out.sent[0]!.body;
    assert.equal(body.type, "claude-remote.pending");
    assert.equal(body.event, "pending");
    assert.equal(body.requestId, requestId);
    assert.equal(body.sessionId, SESSION);
    assert.equal(body.projectName, "demo-app");
    assert.equal(body.kind, "permission");
    assert.equal(body.toolName, "Bash");
    assert.equal("text" in body, false);
    assert.equal(JSON.stringify(body).includes("rm -rf"), false);
    assert.equal(out.sent[0]!.headers["x-claude-remote-signature"], undefined);
  } finally {
    stop();
    logs.restore();
  }
  const view = new PendingStore();
  view.record(permission(), WAIT);
  const withText = notifyPayload(view.list()[0]!, "pending", { includeText: true }, 0);
  assert.equal(withText.text, "Bash: rm -rf build");
});

test("a secret signs the body with HMAC-SHA256, or goes as a bearer when asked", async () => {
  const store = new PendingStore();
  const out = capture();
  const now = Date.UTC(2026, 9, 18, 16, 0, 0);
  const { notifier, stop } = startNotifier(store, settings({ secret: SECRET }), { send: out.send, clock: () => now });
  const logs = quietLogs();
  store.record(permission(), WAIT);
  await notifier.idle();
  stop();
  const headers = out.sent[0]!.headers;
  assert.equal(headers["x-claude-remote-timestamp"], String(now / 1000));
  const raw = JSON.stringify(out.sent[0]!.body);
  assert.equal(headers["x-claude-remote-signature"], `sha256=${signBody(SECRET, String(now / 1000), raw)}`);
  assert.equal(headers.authorization, undefined);
  const bearer = capture();
  const second = startNotifier(store, settings({ secret: SECRET, auth: "bearer" }), { send: bearer.send });
  store.record(permission(SESSION, "ls"), WAIT);
  await second.notifier.idle();
  second.stop();
  logs.restore();
  assert.equal(bearer.sent[0]!.headers.authorization, `Bearer ${SECRET}`);
  assert.equal(bearer.sent[0]!.headers["x-claude-remote-signature"], undefined);
  for (const line of logs.lines) {
    assert.equal(line.includes(SECRET), false);
    assert.equal(line.includes("key=abc"), false);
    assert.equal(line.includes("example.test"), false);
  }
});

test("one entry gives one alert; the follow-up permission_prompt notification and cleared events are deduped", async () => {
  const store = new PendingStore();
  const out = capture();
  const logs = quietLogs();
  const { notifier, stop } = startNotifier(store, settings({ cleared: true }), { send: out.send });
  store.record(permission(), WAIT);
  store.record({ session_id: SESSION, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, WAIT);
  await notifier.idle();
  assert.deepEqual(out.sent.map((item) => `${item.body.event}:${item.body.kind}`), ["pending:permission"]);
  store.record({ session_id: SESSION, hook_event_name: "Stop" }, WAIT);
  store.record({ session_id: SESSION, hook_event_name: "Stop" }, WAIT);
  await notifier.idle();
  assert.deepEqual(out.sent.map((item) => `${item.body.event}:${item.body.kind}`), ["pending:permission", "cleared:permission"]);
  store.record({ session_id: SESSION, hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" }, WAIT);
  await notifier.idle();
  assert.equal(out.sent.at(-1)!.body.kind, "notification");
  assert.equal(out.sent.length, 3);
  stop();
  logs.restore();
  const quiet = capture();
  const other = new PendingStore();
  const off = startNotifier(other, settings(), { send: quiet.send });
  const logs2 = quietLogs();
  other.record(permission(), WAIT);
  other.record({ session_id: SESSION, hook_event_name: "Stop" }, WAIT);
  await off.notifier.idle();
  off.stop();
  logs2.restore();
  assert.deepEqual(quiet.sent.map((item) => item.body.event), ["pending"]);
});

test("delivery retries a network error or 5xx a couple of times, but not a 4xx", async () => {
  const logs = quietLogs();
  const flaky = capture([0, 503, 200]);
  const store = new PendingStore();
  const a = startNotifier(store, settings(), { send: flaky.send, retryDelaysMs: [5, 5] });
  store.record(permission(), WAIT);
  await a.notifier.idle();
  a.stop();
  assert.equal(flaky.sent.length, 3);
  const refused = capture([400, 200]);
  const s2 = new PendingStore();
  const c = new Notifier(settings(), s2, { send: refused.send, retryDelaysMs: [5, 5] });
  s2.subscribe((change) => c.handle(change));
  s2.record(permission(), WAIT);
  await c.idle();
  c.close();
  assert.equal(refused.sent.length, 1);
  const down = capture([0, 0, 0, 0]);
  const s3 = new PendingStore();
  const d = startNotifier(s3, settings(), { send: down.send, retryDelaysMs: [5, 5] });
  s3.record(permission(), WAIT);
  await d.notifier.idle();
  d.stop();
  logs.restore();
  assert.equal(down.sent.length, 3);
  assert.ok(logs.lines.some((line) => line.includes("failed-network")));
});

test("a slow or hung receiver never delays recording the hook event", async () => {
  const logs = quietLogs();
  const store = new PendingStore();
  let release: () => void = () => undefined;
  const hung: NotifySend = () => new Promise((resolve) => {
    release = () => resolve(200);
  });
  const { stop } = startNotifier(store, settings(), { send: hung });
  const started = Date.now();
  for (let i = 0; i < 20; i += 1) store.record(permission(SESSION, `echo ${i}`), WAIT);
  assert.ok(Date.now() - started < 200);
  release();
  stop();
  logs.restore();
});

test("settings come from the environment or a private notify.json, and refuse plain http off this machine", async () => {
  const { home } = await tempHome();
  assert.equal(await loadNotifySettings({}, home), null);
  assert.equal(checkNotifyUrl("http://example.test/x"), null);
  assert.equal(checkNotifyUrl("https://user:pw@example.test/x"), null);
  assert.ok(checkNotifyUrl("http://127.0.0.1:9000/x"));
  assert.equal(describeNotifyUrl("https://example.test/hook/abc?key=secret#frag"), "https://example.test/hook/abc");
  const logs = quietLogs();
  assert.equal(await loadNotifySettings({ CLAUDE_REMOTE_NOTIFY_URL: "http://example.test/x" }, home), null);
  const fromEnv = await loadNotifySettings({ CLAUDE_REMOTE_NOTIFY_URL: "https://example.test/x", CLAUDE_REMOTE_NOTIFY_SECRET: SECRET, CLAUDE_REMOTE_NOTIFY_INCLUDE_TEXT: "1" }, home);
  assert.deepEqual(fromEnv, { url: "https://example.test/x", secret: SECRET, auth: "hmac", includeText: true, cleared: false });
  await writeToken(home, mintToken());
  const file = notifyFilePath(home);
  await writeFile(file, JSON.stringify({ url: "https://example.test/y", secret: SECRET, cleared: true }), { mode: 0o644 });
  await chmod(file, 0o644);
  assert.equal(await loadNotifySettings({}, home), null, "a group- or world-readable notify.json is ignored");
  await chmod(file, 0o600);
  assert.deepEqual(await loadNotifySettings({}, home), { url: "https://example.test/y", secret: SECRET, auth: "hmac", includeText: false, cleared: true });
  logs.restore();
  for (const line of logs.lines) assert.equal(line.includes(SECRET), false);
});

test("install writes the endpoint and secret to a 0600 file, not the plist, and uninstall removes it", async () => {
  const { home } = await tempHome();
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  await chmod(launchAgents, 0o755);
  const report = await executeInstall(installInput(home, { notify: { url: "https://example.test/hook?key=abc", secret: SECRET, includeText: true } }), fakeRun());
  assert.deepEqual(report.notify, { url: "https://example.test/hook", signed: true, auth: "hmac", includeText: true, cleared: false });
  assert.equal(report.httpPlist.includes(SECRET), false);
  assert.equal(report.httpPlist.includes("example.test"), false);
  const file = notifyFilePath(home);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { url: "https://example.test/hook?key=abc", secret: SECRET, includeText: true });
  await executeInstall(installInput(home), fakeRun());
  await assert.rejects(() => stat(file), "install without --notify-url turns alerts off");
  await assert.rejects(() => executeInstall(installInput(home, { notify: { url: "http://example.test/x" } }), fakeRun()), /must be https/);
  await assert.rejects(() => executeInstall(installInput(home, { notify: { url: "https://example.test/x", secret: "short" } }), fakeRun()), /16 to 512/);
  await executeInstall(installInput(home, { notify: { url: "https://example.test/hook" } }), fakeRun());
  const removed = await executeUninstall({ home, uid: 501, dryRun: false, purge: false, launchctlBin: "/fake/launchctl", claudeBin: "/fake/claude", configRoot: path.join(home, "cfg") }, fakeRun());
  assert.ok(removed.removed.includes(file));
  await assert.rejects(() => stat(file));
});

test("the helper posts an alert to a local receiver when a hook records a permission request", async () => {
  const { home, root } = await tempHome();
  const token = mintToken();
  await writeToken(home, token);
  const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const receiverPort = (receiver.address() as AddressInfo).port;
  const logs = quietLogs();
  const listener = await listenHttp(parseConfig({ CLAUDE_CONFIG_DIR: root }, { home, platform: "linux" }), 0, {
    env: { CLAUDE_REMOTE_NOTIFY_URL: `http://127.0.0.1:${receiverPort}/alert?k=v`, CLAUDE_REMOTE_NOTIFY_SECRET: SECRET },
  });
  try {
    const reply = await post(listener.port, token, permission("78787878-7878-4787-8787-787878787878"));
    assert.equal(reply.status, 200);
    const deadline = Date.now() + 5000;
    while (received.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 1);
    const body = JSON.parse(received[0]!.body) as Record<string, unknown>;
    assert.equal(body.kind, "permission");
    assert.equal(body.projectName, "demo-app");
    const ts = String(received[0]!.headers["x-claude-remote-timestamp"]);
    assert.equal(received[0]!.headers["x-claude-remote-signature"], `sha256=${signBody(SECRET, ts, received[0]!.body)}`);
  } finally {
    pendingStore.record({ session_id: "78787878-7878-4787-8787-787878787878", hook_event_name: "SessionEnd" }, WAIT);
    await listener.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    logs.restore();
  }
  for (const line of logs.lines) {
    assert.equal(line.includes(SECRET), false);
    assert.equal(line.includes("k=v"), false);
    assert.equal(line.includes(String(receiverPort)), false);
  }
});

function installInput(home: string, patch: Partial<InstallInput> = {}): InstallInput {
  return {
    home,
    platform: "darwin",
    uid: 501,
    port: 47321,
    allowSend: false,
    allowLaunch: false,
    dryRun: false,
    nodeBin: "/usr/bin/node",
    entry: "/opt/claude-remote/dist/index.js",
    cloudflaredBin: "/fake/cloudflared",
    cloudflaredPresent: true,
    brewBin: "/fake/brew",
    launchctlBin: "/fake/launchctl",
    claudeBin: "/fake/claude",
    urlWaitMs: 0,
    configRoot: path.join(home, "cfg"),
    ...patch,
  };
}

function fakeRun(): InstallHooks {
  return { build: async () => undefined, run: async () => ({ code: 0, stdout: "", stderr: "" }) };
}

function post(port: number, token: string, body: unknown): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: "127.0.0.1",
      port,
      path: "/hook/event",
      method: "POST",
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(payload);
  });
}
