import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { VID } from "../fixtures/ids.js";
import { listenerSocket, serveChannel } from "../src/channel.js";
import { continueCommandLine } from "../src/continue.js";
import { assertSpawnAllowed, startNew } from "../src/launch.js";
import { prepareProject } from "../src/prepare.js";
import { launchesRoot } from "../src/launches.js";
import { processIdentity } from "../src/registry.js";
import { DEV_CHANNEL_ACCEPT, DEV_CHANNEL_EXIT, DEV_CHANNEL_WARNING } from "../src/terminal.js";
import { configAt, desktopRoot, fixtureRoot, repoRoot, shimPath, tempHome } from "./helpers.js";

const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const fakeTmux = path.join(repoRoot, "scripts", "fake-tmux.mjs");
const fakeOsascript = path.join(repoRoot, "scripts", "fake-osascript.mjs");
const ID = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
const SECRET = "CLI-REPLY-SECRET";

test("list and show print the row and the last reply, and logs omit that reply", async () => {
  const home = await tempHome();
  const listed = await runDesk(home.home, ["list", "--json"], {
    CLAUDE_CONFIG_DIR: fixtureRoot,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
  });
  assert.equal(listed.code, 0);
  const rows = JSON.parse(listed.stdout) as { sessions: Array<Record<string, unknown>> };
  const vid = rows.sessions.find((row) => row.sessionId === VID);
  assert.ok(vid);
  assert.equal(vid.title, "Audio desk");
  assert.equal(vid.projectName, "demo-app");
  assert.equal(vid.cwd, "/tmp/fixture/demo-app/.claude/worktrees/audio");
  assert.equal(vid.liveOwner, "none");
  assert.equal(vid.channelAttached, false);
  assert.equal(vid.activity, "unknown");
  assert.equal(vid.command, continueCommandLine(shimPath, "/tmp/fixture/demo-app/.claude/worktrees/audio", VID));
  assert.equal(vid.warning, null);
  assert.equal(listed.stdout.includes("Shortened the lead-in"), false);
  assert.equal(listed.stderr.includes("Shortened the lead-in"), false);
  assert.equal(listed.stderr.includes("Audio desk"), false);

  const text = await runDesk(home.home, ["list"], {
    CLAUDE_CONFIG_DIR: fixtureRoot,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
  });
  assert.equal(text.code, 0);
  const row = text.stdout.trim().split("\n").find((line) => line.startsWith(VID));
  assert.equal(row, [
    VID,
    "Audio desk",
    "demo-app",
    "/tmp/fixture/demo-app/.claude/worktrees/audio",
    "none",
    "no",
    "unknown",
    continueCommandLine(shimPath, "/tmp/fixture/demo-app/.claude/worktrees/audio", VID),
    "-",
  ].join("\t"));

  const shown = await runDesk(home.home, ["show", VID], {
    CLAUDE_CONFIG_DIR: fixtureRoot,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
  });
  assert.equal(shown.code, 0);
  assert.match(shown.stdout, /title=Audio desk/);
  assert.match(shown.stdout, /messageCount=2/);
  assert.match(shown.stdout, /reply=Shortened the lead-in by 200ms\./);
  assert.equal(shown.stderr.includes("Shortened the lead-in"), false);
});

test("show truncates the reply and does not log it", async () => {
  const { home, root } = await tempHome();
  const reply = `${SECRET}${"q".repeat(400)}`;
  await writeClosed(root, ID, path.join(home, "proj"), reply);
  const shown = await runDesk(home, ["show", ID, "--json"]);
  assert.equal(shown.code, 0);
  const body = JSON.parse(shown.stdout) as { reply: string; messageCount: number };
  assert.equal(body.reply, reply.slice(0, 300));
  assert.equal(shown.stderr.includes(SECRET), false);
});

test("new refuses without the launch gate and starts under tmux when it is on", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const blocked = await runDesk(home, ["new", folder, "--name", "sdscratch"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stdout, /code=launch-disabled/);
  await assert.rejects(() => readFile(path.join(home, "tmux", "log.jsonl"), "utf8"));

  const started = await runDesk(home, ["new", folder, "--name", "sdscratch", "--json"], launchEnv(ID));
  assert.equal(started.code, 0, started.stderr);
  const body = JSON.parse(started.stdout) as { sessionId: string; tmuxTarget: string; kind: string };
  assert.equal(body.sessionId, ID);
  assert.equal(body.tmuxTarget, "sdscratch");
  assert.equal(body.kind, "tmux");
  const log = await readFile(path.join(home, "tmux", "log.jsonl"), "utf8");
  assert.match(log, /new-session/);
  assert.match(log, /--dangerously-load-development-channels/);
  assert.match(log, /server:claude-remote-channel/);
  assert.match(log, /--add-dir/);
  assert.match(log, /--mcp-config/);
  assert.match(log, /--no-chrome/);
  assert.equal(log.includes("--dangerously-skip-permissions"), false);
  assert.equal(log.includes("--strict-mcp-config"), false);
  assert.equal(log.includes("--resume"), false);
  const names = await readdir(launchesRoot(home));
  const recordName = names.find((name) => name.endsWith(".json"));
  assert.ok(recordName);
  const recordInfo = await stat(path.join(launchesRoot(home), recordName));
  const dirInfo = await stat(launchesRoot(home));
  assert.equal(recordInfo.mode & 0o777, 0o600);
  assert.equal(dirInfo.mode & 0o777, 0o700);
  const record = JSON.parse(await readFile(path.join(launchesRoot(home), recordName), "utf8")) as { sessionId: string };
  assert.equal(record.sessionId, ID);
});

test("the dev-channel flag answers only the documented warning", async () => {
  const { home } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const pane = path.join(home, "tmux", "pane.txt");
  await mkdir(path.join(home, "tmux"), { recursive: true });
  await writeFile(pane, `${DEV_CHANNEL_WARNING}\n❯ ${DEV_CHANNEL_ACCEPT}\n  ${DEV_CHANNEL_EXIT}\n`);
  const accepted = await runDesk(home, ["new", folder, "--name", "sdwarn", "--accept-dev-channel-prompt"], launchEnv(ID));
  assert.equal(accepted.code, 0, accepted.stderr);
  const keys = await tmuxCommands(home);
  assert.equal(keys.some((args) => args[0] === "send-keys" && args.includes("Enter")), true);

  await rm(path.join(home, "tmux", "log.jsonl"));
  await writeFile(pane, `${DEV_CHANNEL_WARNING}\n❯ ${DEV_CHANNEL_ACCEPT}\n  ${DEV_CHANNEL_EXIT}\nNew MCP server found in this project: claude-remote-channel\n`);
  const mcp = await runDesk(home, ["new", folder, "--name", "sdmcp", "--accept-dev-channel-prompt"], launchEnv("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  assert.equal(mcp.code, 0, mcp.stderr);
  const mcpKeys = await tmuxCommands(home);
  assert.equal(mcpKeys.some((args) => args[0] === "send-keys"), false);

  await rm(path.join(home, "tmux", "log.jsonl"));
  await writeFile(pane, `${DEV_CHANNEL_WARNING}\n  ${DEV_CHANNEL_ACCEPT}\n❯ ${DEV_CHANNEL_EXIT}\n`);
  const other = await runDesk(home, ["new", folder, "--name", "sdother", "--accept-dev-channel-prompt"], launchEnv("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
  assert.equal(other.code, 0, other.stderr);
  const otherKeys = await tmuxCommands(home);
  assert.equal(otherKeys.some((args) => args[0] === "send-keys"), false);

  await rm(path.join(home, "tmux", "log.jsonl"));
  await writeFile(pane, `${DEV_CHANNEL_WARNING}\n❯ ${DEV_CHANNEL_ACCEPT}\n  ${DEV_CHANNEL_EXIT}\n`);
  const silent = await runDesk(home, ["new", folder, "--name", "sdsilent"], launchEnv("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
  assert.equal(silent.code, 0, silent.stderr);
  const silentKeys = await tmuxCommands(home);
  assert.equal(silentKeys.some((args) => args[0] === "send-keys"), false);
});

test("continue refuses a live desktop owner, including after --i-stopped-it, until that pid is gone", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  await writeClosed(root, ID, folder, "closed reply");
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
    const refused = await runDesk(home, ["continue", ID, "--name", "sdcont"], launchEnv(ID));
    assert.equal(refused.code, 1);
    assert.match(refused.stdout, /code=live-owner/);
    assert.match(refused.stdout, /desktop app/);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "new-session"), false);

    const forced = await runDesk(home, ["continue", ID, "--name", "sdcont", "--i-stopped-it"], launchEnv(ID));
    assert.equal(forced.code, 1);
    assert.match(forced.stdout, /code=live-owner/);
    const alias = await runDesk(home, ["continue", ID, "--force-live-owner"], launchEnv(ID));
    assert.equal(alias.code, 1);
    assert.match(alias.stdout, /code=live-owner/);
    assert.equal((await tmuxCommands(home)).some((args) => args[0] === "new-session"), false);
  } finally {
    child.kill("SIGKILL");
  }
  await closed;
  const launched = await runDesk(home, ["continue", ID, "--name", "sdcont", "--i-stopped-it", "--json"], launchEnv(ID));
  assert.equal(launched.code, 0, launched.stderr);
  const body = JSON.parse(launched.stdout) as { sessionId: string; tmuxTarget: string };
  assert.equal(body.sessionId, ID);
  assert.equal(body.tmuxTarget, "sdcont");
  const log = await readFile(path.join(home, "tmux", "log.jsonl"), "utf8");
  assert.match(log, /--resume/);
  assert.match(log, new RegExp(ID));
  assert.equal(log.includes("--dangerously-skip-permissions"), false);
});

test("send prints handed while busy, sent when idle, and keeps the message out of the log", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  await writeClosed(root, ID, folder, "closed reply");
  await writeRecord(root, 99999999, { pid: 99999999, sessionId: ID, status: "busy" });
  const server = await serveChannel(listenerSocket(home, ID), { sessionId: ID });
  try {
    const handed = await runDesk(home, ["send", ID, "--message", SECRET, "--yes", "--json"], {
      CLAUDE_REMOTE_ALLOW_SEND: "1",
    });
    assert.equal(handed.code, 0, handed.stderr);
    const body = JSON.parse(handed.stdout) as { disposition: string; observedStatus: string; attachmentCount: number };
    assert.equal(body.disposition, "handed");
    assert.equal(body.observedStatus, "busy");
    assert.equal(body.attachmentCount, 0);
    assert.equal(handed.stdout.includes(SECRET), false);
    assert.equal(handed.stderr.includes(SECRET), false);
  } finally {
    await server.close();
  }

  const missingYes = await runDesk(home, ["send", ID, "--message", "hello"], { CLAUDE_REMOTE_ALLOW_SEND: "1" });
  assert.match(missingYes.stdout, /code=confirm-required/);
  const disabled = await runDesk(home, ["send", ID, "--message", "hello", "--yes"]);
  assert.match(disabled.stdout, /code=send-disabled/);

  const sent = await runDesk(home, ["send", ID, "--message", "Say hello and stop.", "--yes", "--json"], {
    CLAUDE_REMOTE_ALLOW_SEND: "1",
  });
  assert.equal(sent.code, 0, sent.stderr);
  const sentBody = JSON.parse(sent.stdout) as { disposition: string };
  assert.equal(sentBody.disposition, "sent");
  assert.equal(sent.stderr.includes("Say hello and stop."), false);
  const record = JSON.parse(await readFile(path.join(folder, "fake-claude-record.json"), "utf8")) as { argv: string[] };
  assert.equal(record.argv.includes("--resume"), true);
  assert.equal(record.argv.includes(ID), true);
  assert.equal(record.argv.includes("Say hello and stop."), true);
  assert.equal(record.argv.includes("--dangerously-skip-permissions"), false);

  const inbox = path.join(home, ".claude-remote", "inbox");
  await mkdir(inbox, { recursive: true });
  const notes = path.join(inbox, "notes.txt");
  await writeFile(notes, "hello notes\n");
  const attached = await runDesk(home, ["send", ID, "--message", "Read the notes.", "--attach", notes, "--yes", "--json"], {
    CLAUDE_REMOTE_ALLOW_SEND: "1",
  });
  assert.equal(attached.code, 0, attached.stderr);
  const attachedBody = JSON.parse(attached.stdout) as { disposition: string; attachmentCount: number };
  assert.equal(attachedBody.disposition, "sent");
  assert.equal(attachedBody.attachmentCount, 1);
  assert.equal(attached.stderr.includes("hello notes"), false);
  assert.equal(attached.stdout.includes("hello notes"), false);
});

test("rename reports that no documented route exists and leaves the transcript untouched", async () => {
  const { home, root } = await tempHome();
  const file = await writeClosed(root, ID, path.join(home, "proj"), "closed reply");
  const before = await stat(file);
  const renamed = await runDesk(home, ["rename", ID, "A new title"]);
  assert.equal(renamed.code, 1);
  assert.match(renamed.stdout, /code=no-documented-route/);
  assert.match(renamed.stdout, /does not edit transcript files/);
  const after = await stat(file);
  assert.equal(before.mtimeMs, after.mtimeMs);
  assert.equal(renamed.stdout.includes("A new title"), false);
});

test("stop ends only a recorded tmux session, and a second stop is not ours", async () => {
  const { home } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const started = await runDesk(home, ["new", folder, "--name", "sdstop", "--json"], launchEnv(ID));
  assert.equal(started.code, 0, started.stderr);
  const pane = path.join(home, "tmux", "pane.txt");
  await writeFile(pane, "prompt\n");
  const stopped = await runDesk(home, ["stop", ID], { CLAUDE_REMOTE_ALLOW_LAUNCH: "1" });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /stopped=exited/);
  const commands = await tmuxCommands(home);
  assert.equal(commands.some((args) => args[0] === "send-keys" && args.includes("/exit")), true);
  assert.equal(commands.some((args) => args[0] === "kill-session" && args.includes("sdstop")), true);
  const again = await runDesk(home, ["stop", ID], { CLAUDE_REMOTE_ALLOW_LAUNCH: "1" });
  assert.match(again.stdout, /code=not-ours/);

  const blockedPane = path.join(home, "tmux", "pane.txt");
  await writeFile(blockedPane, "New MCP server found\n");
  const second = await runDesk(home, ["new", folder, "--name", "sdblock", "--json"], launchEnv("dddddddd-dddd-4ddd-8ddd-dddddddddddd"));
  assert.equal(second.code, 0, second.stderr);
  await rm(path.join(home, "tmux", "log.jsonl"));
  const killed = await runDesk(home, ["stop", "--target", "sdblock"], { CLAUDE_REMOTE_ALLOW_LAUNCH: "1" });
  assert.match(killed.stdout, /stopped=killed/);
  const killLog = await tmuxCommands(home);
  assert.equal(killLog.some((args) => args.includes("/exit")), false);
  assert.equal(killLog.some((args) => args[0] === "kill-session"), true);

  const stranger = await runDesk(home, ["stop", "--target", "not-ours"], { CLAUDE_REMOTE_ALLOW_LAUNCH: "1" });
  assert.match(stranger.stdout, /code=not-ours/);
});

test("cleanup removes a stale socket and an expired attachment, and leaves a live socket and a key file", async () => {
  const { home } = await tempHome();
  const channel = path.join(home, ".claude-remote", "channel");
  await mkdir(channel, { recursive: true });
  const staleId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const staleSock = path.join(channel, `${staleId}.sock`);
  await writeFile(staleSock, "");
  await writeFile(path.join(channel, `${staleId}.token`), "token");
  const key = path.join(channel, "secret.key");
  await writeFile(key, "nope");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, old, old);
  const before = (await stat(key)).atimeMs;
  const ticket = path.join(home, ".claude-remote", "attachments", ID, "ffffffff-ffff-4fff-8fff-ffffffffffff");
  await mkdir(ticket, { recursive: true });
  await writeFile(path.join(ticket, "01-notes.txt"), "stale");
  await utimes(ticket, old, old);
  const live = await serveChannel(listenerSocket(home, ID), { sessionId: ID });
  try {
    const cleaned = await runDesk(home, ["cleanup", "--json"], { CLAUDE_REMOTE_ATTACHMENT_TTL_MS: "1000" });
    assert.equal(cleaned.code, 0, cleaned.stderr);
    const body = JSON.parse(cleaned.stdout) as { sockets: number; tokens: number };
    assert.equal(body.sockets, 1);
    assert.equal(body.tokens, 1);
    await assert.rejects(() => stat(staleSock));
    await assert.rejects(() => stat(path.join(channel, `${staleId}.token`)));
    await stat(listenerSocket(home, ID));
    assert.equal((await stat(key)).atimeMs, before);
    await assert.rejects(() => stat(ticket));
  } finally {
    await live.close();
  }
});

test("linux without tmux prints the install hint and does not open Terminal", async () => {
  const { home } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const missing = await runDesk(home, ["new", folder], {
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    CLAUDE_REMOTE_PLATFORM: "linux",
    CLAUDE_REMOTE_TMUX_BIN: "/bin/false",
    CLAUDE_REMOTE_OSASCRIPT_BIN: "osascript",
  });
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /code=tmux-missing/);
  assert.match(missing.stdout, /brew install tmux/);
  assert.equal(missing.stdout.includes("terminal-app"), false);
});

test("darwin without tmux runs a fake osascript and refuses the real one", async () => {
  const { home } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const log = path.join(home, "osascript.log");
  const started = await runDesk(home, ["new", folder, "--json"], {
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    CLAUDE_REMOTE_PLATFORM: "darwin",
    CLAUDE_REMOTE_TMUX_BIN: "/bin/false",
    CLAUDE_REMOTE_OSASCRIPT_BIN: fakeOsascript,
    FAKE_OSASCRIPT_LOG: log,
  });
  assert.equal(started.code, 0, started.stderr);
  const body = JSON.parse(started.stdout) as { kind: string; sessionId: string | null };
  assert.equal(body.kind, "terminal-app");
  assert.equal(body.sessionId, null);
  const recorded = JSON.parse(await readFile(log, "utf8")) as string[];
  const script = recorded[1] ?? "";
  assert.match(script, /tell application "Terminal" to do script/);
  assert.match(script, /--dangerously-load-development-channels/);
  assert.match(script, /--add-dir/);
  assert.match(script, /--no-chrome/);
  assert.equal(script.includes("--dangerously-skip-permissions"), false);

  const refused = await runDesk(home, ["new", folder], {
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    CLAUDE_REMOTE_PLATFORM: "darwin",
    CLAUDE_REMOTE_TMUX_BIN: "/bin/false",
    CLAUDE_REMOTE_OSASCRIPT_BIN: "osascript",
  });
  assert.equal(refused.code, 1);
  assert.match(refused.stdout, /code=denied/);
  assert.match(refused.stdout, /refusing a real terminal launcher/);
  assert.equal(refused.stdout.includes("terminal-app"), false);
  const guarded = execFileCb as typeof execFileCb & { claudeRemoteSpawnGuard?: boolean };
  assert.equal(guarded.claudeRemoteSpawnGuard, true);
  assert.throws(() => execFileCb("tmux", ["-V"], () => undefined), /refusing a real terminal launcher/);
  assert.throws(() => execFileCb("osascript", ["-e", "return 1"], () => undefined), /refusing a real terminal launcher/);
  assert.throws(() => execFileCb("open", ["-a", "Terminal"], () => undefined), /refusing a real terminal launcher/);
  assert.throws(() => execFileCb("cloudflared", ["tunnel"], () => undefined), /refusing a real terminal launcher/);
  assert.throws(() => execFileCb("brew", ["install", "cloudflared"], () => undefined), /refusing a real terminal launcher/);
  assert.throws(() => execFileCb("launchctl", ["print"], () => undefined), /refusing a real terminal launcher/);
  assert.throws(() => assertSpawnAllowed("tmux"), (error: { code?: string }) => error.code === "denied");
});

test("startup dialogs are named and are not answered", async () => {
  const { home } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const pane = path.join(home, "tmux", "pane.txt");
  await mkdir(path.join(home, "tmux"), { recursive: true });
  const panes: Array<[string, string]> = [
    ["workspace-trust", "Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n"],
    ["mcp-server", "New MCP server found in this project: claude-remote-channel\n"],
    ["chrome-extension", "Claude in Chrome extension detected\n"],
  ];
  for (const [dialog, text] of panes) {
    await writeFile(pane, text);
    await rm(path.join(home, "tmux", "log.jsonl"), { force: true });
    const blocked = await runDesk(home, ["new", folder, "--name", `sd${dialog.slice(0, 6)}`, "--accept-dev-channel-prompt", "--json"], {
      CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    });
    assert.equal(blocked.code, 1, blocked.stderr);
    const body = JSON.parse(blocked.stdout) as { code: string; dialog: string };
    assert.equal(body.code, "blocked-by-dialog");
    assert.equal(body.dialog, dialog);
    assert.equal(blocked.stdout.includes("trust this folder"), false);
    assert.equal(blocked.stdout.includes("claude-remote-channel"), false);
    assert.equal(blocked.stdout.includes("Chrome extension"), false);
    const keys = await tmuxCommands(home);
    assert.equal(keys.some((args) => args[0] === "send-keys"), false);
  }
});

test("prepare-project writes only the local settings file", async () => {
  const { home } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(path.join(folder, ".claude"), { recursive: true });
  const settings = path.join(folder, ".claude", "settings.local.json");
  await writeFile(settings, `${JSON.stringify({ theme: "dark", enabledMcpjsonServers: ["other-server"] })}\n`);
  const started = await runDesk(home, ["new", folder, "--name", "sdprep", "--prepare-project", "--json"], launchEnv(ID));
  assert.equal(started.code, 0, started.stderr);
  const body = JSON.parse(started.stdout) as { prepared: string[] | null };
  assert.deepEqual(body.prepared, ["enabledMcpjsonServers", "permissions.additionalDirectories"]);
  const written = JSON.parse(await readFile(settings, "utf8")) as {
    theme?: string;
    hasTrustDialogAccepted?: boolean;
    enabledMcpjsonServers?: string[];
    permissions?: { additionalDirectories?: string[] };
  };
  assert.equal(written.theme, "dark");
  assert.equal(written.hasTrustDialogAccepted, undefined);
  assert.deepEqual(written.enabledMcpjsonServers, ["other-server", "claude-remote-channel"]);
  assert.equal(written.permissions?.additionalDirectories?.[0], path.join(home, ".claude-remote", "attachments"));
  await assert.rejects(() => stat(path.join(folder, ".mcp.json")));
  await assert.rejects(() => stat(path.join(home, ".claude.json")));
  const mcp = JSON.parse(await readFile(path.join(home, ".claude-remote", "mcp", "channel.json"), "utf8")) as {
    mcpServers?: { "claude-remote-channel"?: { args?: string[] } };
  };
  assert.equal(mcp.mcpServers?.["claude-remote-channel"]?.args?.includes("channel"), true);
  const log = await readFile(path.join(home, "tmux", "log.jsonl"), "utf8");
  assert.match(log, /--add-dir/);
  assert.match(log, /--mcp-config/);
  assert.equal(log.includes("--strict-mcp-config"), false);

  const denied = await runDesk(home, ["new", home, "--prepare-project"], launchEnv("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
  assert.match(denied.stdout, /code=denied/);
  const target = path.join(home, "kept.json");
  await writeFile(target, "{\"keep\":true}\n");
  await rm(settings);
  await symlink(target, settings);
  await assert.rejects(
    () => prepareProject(folder, home, path.join(home, ".claude-remote", "attachments")),
    (error: { code?: string }) => error.code === "denied",
  );
  assert.equal(await readFile(target, "utf8"), "{\"keep\":true}\n");
});

test("darwin falls back to Terminal.app when tmux is absent", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const scripts: string[] = [];
  const config = {
    ...configAt(home, root),
    allowLaunch: true,
    platform: "darwin" as const,
    tmuxBin: "/no/such/tmux",
  };
  const started = await startNew(config, { folder, acceptDevChannelPrompt: false }, {
    probeTmux: async () => false,
    openTerminal: async (script) => {
      scripts.push(script);
    },
  });
  assert.equal(started.kind, "terminal-app");
  assert.equal(started.sessionId, null);
  assert.equal(scripts.length, 1);
  const script = scripts[0] ?? "";
  assert.match(script, /tell application "Terminal" to do script/);
  assert.match(script, /--dangerously-load-development-channels/);
  assert.match(script, /server:claude-remote-channel/);
  assert.equal(script.includes("--dangerously-skip-permissions"), false);
  assert.match(script, new RegExp(folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("a session with no transcript is listed and a live socket can take a send", async () => {
  const { home, root } = await tempHome();
  const folder = path.join(home, "proj");
  await mkdir(folder, { recursive: true });
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const id = "abababab-abab-4aba-8aba-abababababab";
  const socketId = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
  const deadId = "dededede-dede-4ded-8ded-dededededede";
  try {
    const pid = child.pid;
    assert.equal(typeof pid, "number");
    if (pid == null) return;
    const identity = await processIdentity(pid);
    await writeRecord(root, pid, {
      pid,
      sessionId: id,
      procStart: identity.startToken,
      entrypoint: "cli",
      cwd: folder,
      status: "idle",
    });
    await writeRecord(root, 99999999, {
      pid: 99999999,
      sessionId: deadId,
      procStart: "1",
      entrypoint: "cli",
      cwd: folder,
    });
    const listed = await runDesk(home, ["list", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    const rows = JSON.parse(listed.stdout) as { sessions: Array<Record<string, unknown>> };
    const row = rows.sessions.find((item) => item.sessionId === id);
    assert.ok(row);
    assert.equal(row.title, null);
    assert.equal(row.command, continueCommandLine(shimPath, folder, id));
    assert.match(String(row.warning), /Stop the terminal process/);
    assert.equal(rows.sessions.some((item) => item.sessionId === deadId), false);
    assert.equal(rows.sessions.filter((item) => item.sessionId === id).length, 1);

    const shown = await runDesk(home, ["show", id]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /title=-/);
    assert.match(shown.stdout, /messageCount=0/);
    assert.match(shown.stdout, /reply=-/);
    const missing = await runDesk(home, ["show", deadId]);
    assert.match(missing.stdout, /code=not-found/);

    const outside = path.join(home, "notes.txt");
    await writeFile(outside, "not in the inbox\n");
    const undelivered = await runDesk(home, ["send", id, "--message", "PING-UNWRITTEN", "--attach", outside, "--yes", "--json"], {
      CLAUDE_REMOTE_ALLOW_SEND: "1",
    });
    assert.equal(undelivered.code, 0, undelivered.stderr);
    const undeliveredBody = JSON.parse(undelivered.stdout) as { disposition: string; attachmentCount: number };
    assert.equal(undeliveredBody.disposition, "undelivered");
    assert.equal(undeliveredBody.attachmentCount, 0);
    assert.equal(undelivered.stdout.includes("PING-UNWRITTEN"), false);
    assert.equal(undelivered.stderr.includes("PING-UNWRITTEN"), false);
    await assert.rejects(() => stat(path.join(home, ".claude-remote", "attachments", id)));

    const server = await serveChannel(listenerSocket(home, id), { sessionId: id });
    const socketServer = await serveChannel(listenerSocket(home, socketId), { sessionId: socketId });
    try {
      const both = await runDesk(home, ["list", "--json"]);
      const bothRows = JSON.parse(both.stdout) as { sessions: Array<Record<string, unknown>> };
      assert.equal(bothRows.sessions.filter((item) => item.sessionId === id).length, 1);
      const socketRow = bothRows.sessions.find((item) => item.sessionId === socketId);
      assert.ok(socketRow);
      assert.equal(socketRow.title, null);
      assert.equal(socketRow.command, null);
      assert.equal(socketRow.projectName, "unknown");
      const handed = await runDesk(home, ["send", socketId, "--message", "PING-SOCKET", "--yes", "--json"], {
        CLAUDE_REMOTE_ALLOW_SEND: "1",
      });
      assert.equal(handed.code, 0, handed.stderr);
      assert.equal((JSON.parse(handed.stdout) as { disposition: string }).disposition, "handed");
      assert.equal(handed.stdout.includes("PING-SOCKET"), false);
      assert.equal(handed.stderr.includes("PING-SOCKET"), false);
      assert.deepEqual(socketServer.received, ["PING-SOCKET"]);
    } finally {
      await server.close();
      await socketServer.close();
    }
  } finally {
    child.kill("SIGKILL");
  }
  await closed;
});

test("an unknown command exits 2", async () => {
  const { home } = await tempHome();
  const result = await runDesk(home, ["nope"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: claude-remote/);
});

function launchEnv(sessionId: string): Record<string, string> {
  return {
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    FAKE_TMUX_PID: "5151",
    FAKE_TMUX_SESSION: sessionId,
  };
}

async function tmuxCommands(home: string): Promise<string[][]> {
  try {
    const text = await readFile(path.join(home, "tmux", "log.jsonl"), "utf8");
    return text.trim().split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as string[]);
  } catch {
    return [];
  }
}

function runDesk(
  home: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const configDir = extra.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_REMOTE_ALLOW_SEND: "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: "0",
    CLAUDE_REMOTE_SPAWN_GUARD: "1",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    CLAUDE_REMOTE_TMUX_BIN: fakeTmux,
    CLAUDE_REMOTE_LAUNCH_WAIT_MS: "1500",
    FAKE_TMUX_DIR: path.join(home, "tmux"),
    ...extra,
    FAKE_TMUX_RECORD_DIR: extra.FAKE_TMUX_RECORD_DIR ?? configDir,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(tsx, ["src/index.ts", ...args], { cwd: repoRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function writeClosed(root: string, id: string, cwd: string, reply: string): Promise<string> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const user = "a1111111-1111-4111-8111-111111111101";
  const assistant = "a1111111-1111-4111-8111-111111111102";
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: user,
      parentUuid: null,
      sessionId: id,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd,
      message: { role: "user", content: "closed prompt" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: assistant,
      parentUuid: user,
      sessionId: id,
      timestamp: "2024-01-01T00:00:01.000Z",
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: reply }] },
    }),
  ];
  await writeFile(file, `${lines.join("\n")}\n`);
  return file;
}

async function writeRecord(root: string, pid: number, body: unknown): Promise<void> {
  const dir = path.join(root, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${pid}.json`), JSON.stringify(body));
}
