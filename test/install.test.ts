import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DeskError } from "../src/domain.js";
import {
  CLOUDFLARED_SEARCH_DIRS,
  commandVNode,
  executeInstall,
  executeStatus,
  executeUninstall,
  helperLogPath,
  httpPlistPath,
  remoteConnector,
  resolveClaudeBin,
  resolveCloudflared,
  stableNodeBin,
  tunnelLogPath,
  type InstallHooks,
  type InstallInput,
} from "../src/install.js";
import { readToken, tokenPath } from "../src/token.js";
import { repoRoot, shimPath, tempHome } from "./helpers.js";

const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const fakeTmux = path.join(repoRoot, "scripts", "fake-tmux.mjs");
const fakeBin = path.join(repoRoot, "scripts", "fake-bin.mjs");

test("dry-run returns both plists and writes nothing", async () => {
  const { home } = await tempHome();
  const recorded = recorder();
  const report = await executeInstall(input(home, { dryRun: true, platform: "linux", cloudflaredPresent: false }), recorded.hooks);
  assert.equal(recorded.calls.length, 0);
  assert.equal(report.dryRun, true);
  assert.equal(report.url, null);
  assert.equal(report.brew, "install");
  assert.match(report.httpPlist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(report.httpPlist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(report.httpPlist, /<string>http<\/string>/);
  assert.match(report.httpPlist, /CLAUDE_REMOTE_HTTP_PORT<\/key><string>47321<\/string>/);
  assert.match(report.httpPlist, /CLAUDE_REMOTE_ALLOW_SEND<\/key><string>0<\/string>/);
  assert.match(report.httpPlist, /CLAUDE_REMOTE_ALLOW_LAUNCH<\/key><string>0<\/string>/);
  assert.match(report.httpPlist, /CLAUDE_REMOTE_CLAUDE_BIN<\/key><string>\/fake\/claude<\/string>/);
  assert.equal(report.httpPlist.includes("CLAUDE_REMOTE_ALLOW_DELIVER"), false);
  assert.match(report.tunnelPlist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(report.tunnelPlist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(report.tunnelPlist, /--url/);
  assert.match(report.tunnelPlist, /--http-host-header/);
  assert.match(report.tunnelPlist, /127\.0\.0\.1:47321/);
  assert.equal(report.httpPlist.includes("0.0.0.0"), false);
  assert.equal(report.tunnelPlist.includes("0.0.0.0"), false);
  await assert.rejects(() => stat(tokenPath(home)));
  await assert.rejects(() => stat(httpPlistPath(home)));
});

test("install is idempotent, and uninstall leaves user data unless purged", async () => {
  const { home } = await tempHome();
  const launchAgents = path.join(home, "Library", "LaunchAgents");
  await mkdir(launchAgents, { recursive: true });
  await chmod(launchAgents, 0o755);
  const recorded = recorder();
  const first = await executeInstall(input(home, { cloudflaredPresent: false }), recorded.hooks);
  const token = await readToken(home);
  assert.ok(token);
  assert.equal((await stat(tokenPath(home))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(home, ".claude-remote"))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(home, ".claude-remote", "http"))).mode & 0o777, 0o700);
  assert.equal((await stat(launchAgents)).mode & 0o777, 0o755);
  assert.equal((await stat(httpPlistPath(home))).mode & 0o777, 0o600);
  assert.equal(first.httpPlist.includes(token), false);
  assert.equal(first.tunnelPlist.includes(token), false);
  assert.equal(JSON.stringify(first).includes(token), false);
  assert.equal(recorded.calls.some((line) => line.includes("install cloudflared")), true);
  assert.equal(recorded.calls.some((line) => line.includes("mcp add")), true);
  const second = await executeInstall(input(home), recorded.hooks);
  assert.equal(await readToken(home), token);
  assert.equal(second.httpPlist.includes(token), false);
  const adds = recorded.calls.filter((line) => line.includes(" mcp add "));
  assert.equal(adds.length, 1);
  const sentinel = path.join(home, ".claude-remote", "attachments", "keep.txt");
  const nestedKey = path.join(home, ".claude-remote", "attachments", "secret.key");
  await mkdir(path.dirname(sentinel), { recursive: true });
  await writeFile(sentinel, "keep\n");
  await writeFile(nestedKey, "nope\n");
  const claudeKey = path.join(home, ".claude", "sessions", "secret.key");
  await mkdir(path.dirname(claudeKey), { recursive: true });
  await writeFile(claudeKey, "nope\n");
  const keyTime = (await stat(claudeKey)).atimeMs;
  const nestedTime = (await stat(nestedKey)).atimeMs;
  const preview = await executeUninstall({
    home,
    uid: 501,
    dryRun: true,
    purge: false,
    launchctlBin: "/fake/launchctl",
    claudeBin: "/fake/claude",
  }, recorded.hooks);
  assert.equal(preview.dryRun, true);
  await stat(tokenPath(home));
  await stat(sentinel);
  await executeUninstall({
    home,
    uid: 501,
    dryRun: false,
    purge: false,
    launchctlBin: "/fake/launchctl",
    claudeBin: "/fake/claude",
  }, recorded.hooks);
  await assert.rejects(() => stat(tokenPath(home)));
  await assert.rejects(() => stat(httpPlistPath(home)));
  await stat(sentinel);
  await stat(claudeKey);
  assert.equal((await stat(claudeKey)).atimeMs, keyTime);
  assert.equal(recorded.calls.some((line) => line.includes("mcp remove")), true);
  await executeUninstall({
    home,
    uid: 501,
    dryRun: false,
    purge: true,
    launchctlBin: "/fake/launchctl",
    claudeBin: "/fake/claude",
  }, recorded.hooks);
  await assert.rejects(() => stat(sentinel));
  await stat(nestedKey);
  assert.equal((await stat(nestedKey)).atimeMs, nestedTime);
  await stat(claudeKey);
  assert.equal((await stat(claudeKey)).atimeMs, keyTime);
});

test("a failed brew install and a non-mac apply write nothing", async () => {
  const { home } = await tempHome();
  const failed = recorder(1);
  await assert.rejects(
    () => executeInstall(input(home, { cloudflaredPresent: false }), failed.hooks),
    (error: unknown) => error instanceof DeskError && error.code === "brew-failed",
  );
  await assert.rejects(() => stat(tokenPath(home)));
  const quiet = recorder();
  await assert.rejects(
    () => executeInstall(input(home, { platform: "linux", dryRun: false }), quiet.hooks),
    (error: unknown) => error instanceof DeskError && error.code === "unsupported-platform",
  );
  assert.equal(quiet.calls.length, 0);
  await assert.rejects(() => stat(tokenPath(home)));
});

test("status prints the latest tunnel url and not the token", async () => {
  const { home } = await tempHome();
  const recorded = recorder();
  await executeInstall(input(home), recorded.hooks);
  const token = await readToken(home);
  assert.ok(token);
  const log = tunnelLogPath(home);
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(log, "https://old-tunnel.trycloudflare.com\nhttps://your-tunnel.trycloudflare.com extra\n");
  const status = await executeStatus(home, 501, "/fake/launchctl", {
    build: async () => undefined,
    run: async (_bin, args) => ({ code: args.join(" ").includes("tunnel") ? 1 : 0, stdout: "", stderr: "" }),
  });
  assert.equal(status.helper, "running");
  assert.equal(status.tunnel, "stopped");
  assert.equal(status.url, "https://your-tunnel.trycloudflare.com/mcp");
  assert.equal(status.tokenFile, "present");
  assert.equal(status.tokenPath, tokenPath(home));
  assert.equal(JSON.stringify(status).includes(token), false);
});

test("the connector draft names the header and is not packaged", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "remote", "connector.json"), "utf8")) as {
    mcpServers: { "claude-remote": { url: string; headers: Record<string, string> } };
  };
  const server = manifest.mcpServers["claude-remote"];
  assert.equal(server.url, remoteConnector.urlShape);
  assert.equal(server.headers[remoteConnector.headerName], remoteConnector.headerValue);
  assert.equal(JSON.stringify(manifest).includes("Bearer <token>"), true);
  const pkg = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as { files: string[] };
  assert.equal(pkg.files.includes("remote"), false);
  assert.equal(pkg.files.includes("dist"), true);
});

test("install and uninstall dry-run use the injected binaries", async () => {
  const { home } = await tempHome();
  const log = path.join(home, "bins.log");
  const bins = {
    CLAUDE_REMOTE_PLATFORM: "darwin",
    CLAUDE_REMOTE_CLOUDFLARED_BIN: fakeBin,
    CLAUDE_REMOTE_BREW_BIN: fakeBin,
    CLAUDE_REMOTE_LAUNCHCTL_BIN: fakeBin,
    CLAUDE_REMOTE_CLAUDE_BIN: fakeBin,
    FAKE_BIN_LOG: log,
  };
  const preview = await runDesk(home, ["install", "--dry-run", "--port=47321"], bins);
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /dryRun=yes/);
  assert.match(preview.stdout, /brew=skip/);
  assert.match(preview.stdout, /<key>KeepAlive<\/key><true\/>/);
  assert.match(preview.stdout, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(preview.stdout, /127\.0\.0\.1:47321/);
  assert.match(preview.stdout, /--http-host-header/);
  assert.match(preview.stdout, /CLAUDE_REMOTE_ALLOW_SEND<\/key><string>0<\/string>/);
  assert.equal(preview.stdout.includes("0.0.0.0"), false);
  assert.equal(preview.stdout.includes("Bearer"), false);
  await assert.rejects(() => stat(tokenPath(home)));
  await assert.rejects(() => stat(httpPlistPath(home)));
  await assert.rejects(() => stat(log));
  const flagged = await runDesk(home, ["install", "--dry-run", "--allow-send", "--allow-launch"], bins);
  assert.match(flagged.stdout, /CLAUDE_REMOTE_ALLOW_SEND<\/key><string>1<\/string>/);
  assert.match(flagged.stdout, /CLAUDE_REMOTE_ALLOW_LAUNCH<\/key><string>1<\/string>/);
  const missing = await runDesk(home, ["install", "--dry-run"], {
    ...bins,
    CLAUDE_REMOTE_CLOUDFLARED_BIN: path.join(home, "missing-cloudflared"),
  });
  assert.match(missing.stdout, /brew=install/);
  await assert.rejects(() => stat(log));
  const rotated = await runDesk(home, ["rotate-token"]);
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.match(rotated.stdout, /tokenPath=/);
  const token = await readToken(home);
  assert.ok(token);
  assert.equal(rotated.stdout.includes(token), false);
  assert.equal(rotated.stderr.includes(token), false);
  assert.equal((await stat(tokenPath(home))).mode & 0o777, 0o600);
  const again = await runDesk(home, ["rotate-token"]);
  const next = await readToken(home);
  assert.ok(next);
  assert.notEqual(next, token);
  assert.equal(again.stdout.includes(next), false);
  const status = await runDesk(home, ["status"], bins);
  assert.equal(status.code, 0, status.stderr);
  assert.match(status.stdout, /tokenFile=present/);
  assert.match(status.stdout, /tokenPath=/);
  assert.equal(status.stdout.includes(next), false);
  assert.equal(status.stderr.includes(next), false);
  const called = await readFile(log, "utf8");
  assert.match(called, /print/);
  assert.equal(called.includes(next), false);
  const kept = await runDesk(home, ["uninstall", "--dry-run"], bins);
  assert.equal(kept.code, 0, kept.stderr);
  assert.match(kept.stdout, /dryRun=yes/);
  assert.equal(await readToken(home), next);
  const denied = await runDesk(home, ["install"], { ...bins, CLAUDE_REMOTE_PLATFORM: "linux" });
  assert.equal(denied.code, 1);
  assert.match(denied.stdout, /unsupported-platform/);
  assert.equal(await readToken(home), next);
});

test("helper and tunnel logs are mode 0600 before launchd opens them", async () => {
  const { home } = await tempHome();
  const helper = helperLogPath(home);
  const tunnel = tunnelLogPath(home);
  await mkdir(path.dirname(helper), { recursive: true });
  await mkdir(path.dirname(tunnel), { recursive: true });
  await writeFile(helper, "old\n");
  await writeFile(tunnel, "old\n");
  await chmod(helper, 0o644);
  await chmod(tunnel, 0o644);
  await executeInstall(input(home), recorder().hooks);
  assert.equal((await stat(helper)).mode & 0o777, 0o600);
  assert.equal((await stat(tunnel)).mode & 0o777, 0o600);
  assert.equal(await readFile(helper, "utf8"), "old\n");
  assert.equal(await readFile(tunnel, "utf8"), "old\n");
  const fresh = await tempHome();
  await executeInstall(input(fresh.home), recorder().hooks);
  assert.equal((await stat(helperLogPath(fresh.home))).mode & 0o777, 0o600);
  assert.equal((await stat(tunnelLogPath(fresh.home))).mode & 0o777, 0o600);
});

test("a log symlink is refused", async () => {
  const { home } = await tempHome();
  const helper = helperLogPath(home);
  await mkdir(path.dirname(helper), { recursive: true });
  await symlink("/tmp/claude-remote-log-target", helper);
  await assert.rejects(
    () => executeInstall(input(home), recorder().hooks),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  await assert.rejects(() => stat(httpPlistPath(home)));
});

test("cloudflared is found on PATH and in the extra directories", async () => {
  const { home } = await tempHome();
  const dir = path.join(home, "bin");
  const extra = path.join(home, "extra");
  await mkdir(dir);
  await mkdir(extra);
  const fromPath = path.join(dir, "cloudflared");
  const fromExtra = path.join(extra, "cloudflared");
  await writeFile(fromPath, "#!/bin/sh\nexit 0\n");
  await writeFile(fromExtra, "#!/bin/sh\nexit 0\n");
  await chmod(fromPath, 0o755);
  await chmod(fromExtra, 0o755);
  assert.deepEqual([...CLOUDFLARED_SEARCH_DIRS], ["/opt/homebrew/bin", "/usr/local/bin"]);
  const pathHit = await resolveCloudflared({ PATH: dir }, []);
  assert.equal(pathHit.bin, fromPath);
  assert.equal(pathHit.present, true);
  const extraHit = await resolveCloudflared({ PATH: "/usr/bin:/bin" }, [extra]);
  assert.equal(extraHit.bin, fromExtra);
  assert.equal(extraHit.present, true);
  const missing = path.join(home, "missing-cloudflared");
  const override = await resolveCloudflared({
    PATH: dir,
    CLAUDE_REMOTE_CLOUDFLARED_BIN: missing,
  }, [extra]);
  assert.equal(override.bin, missing);
  assert.equal(override.present, false);
  const bare = await resolveCloudflared({ PATH: "/usr/bin:/bin" }, []);
  assert.equal(bare.bin, "cloudflared");
  assert.equal(bare.present, false);
});

test("the node path stays outside the Cellar", async () => {
  const cellar = "/opt/homebrew/Cellar/node@22/22.21.1_4/bin/node";
  assert.equal(stableNodeBin(cellar, null), "/opt/homebrew/opt/node@22/bin/node");
  assert.equal(stableNodeBin(cellar, "/opt/homebrew/bin/node"), "/opt/homebrew/bin/node");
  assert.equal(stableNodeBin(cellar, cellar), "/opt/homebrew/opt/node@22/bin/node");
  assert.equal(stableNodeBin("/usr/local/Cellar/node/22.21.1/bin/node", null), "/usr/local/opt/node/bin/node");
  assert.equal(stableNodeBin("/usr/bin/node", null), "/usr/bin/node");
  const { home } = await tempHome();
  const dir = path.join(home, "node-bin");
  await mkdir(dir);
  const node = path.join(dir, "node");
  await writeFile(node, "#!/bin/sh\nexit 0\n");
  await chmod(node, 0o755);
  const found = await commandVNode({ PATH: `${dir}:/usr/bin:/bin`, HOME: home });
  assert.equal(found, node);
  assert.equal(stableNodeBin(cellar, found), node);
});

test("install dry-run uses PATH cloudflared and the stable node", async () => {
  const { home } = await tempHome();
  const dir = path.join(home, "bin");
  await mkdir(dir);
  const cloudflared = path.join(dir, "cloudflared");
  const node = path.join(dir, "node");
  await writeFile(cloudflared, "#!/bin/sh\nexit 0\n");
  await writeFile(node, "#!/bin/sh\nexit 0\n");
  await chmod(cloudflared, 0o755);
  await chmod(node, 0o755);
  const preview = await runNode(home, ["install", "--dry-run"], {
    PATH: `${dir}:/usr/bin:/bin`,
    HOME: home,
  });
  assert.equal(preview.code, 0, preview.stderr);
  assert.match(preview.stdout, /brew=skip/);
  assert.match(preview.stdout, new RegExp(cloudflared.replaceAll("/", "\\/")));
  assert.match(preview.stdout, new RegExp(node.replaceAll("/", "\\/")));
  assert.equal(preview.stdout.includes("Cellar"), false);
  await assert.rejects(() => stat(tokenPath(home)));
});

test("install pins the claude CLI it found on PATH", async () => {
  const { home } = await tempHome();
  const bin = path.join(home, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "claude"), "#!/bin/sh\n");
  await chmod(path.join(bin, "claude"), 0o755);
  assert.equal(await resolveClaudeBin("claude", `relative:${bin}`), path.join(bin, "claude"));
  assert.equal(await resolveClaudeBin("claude", "/nonexistent"), "claude");
  assert.equal(await resolveClaudeBin("/opt/x/claude", undefined), "/opt/x/claude");
  const report = await executeInstall(input(home, { dryRun: true, claudeBin: "claude" }), recorder().hooks);
  assert.equal(report.httpPlist.includes("CLAUDE_REMOTE_CLAUDE_BIN"), false);
});

function input(home: string, patch: Partial<InstallInput> = {}): InstallInput {
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
    ...patch,
  };
}

function recorder(brewCode = 0): { hooks: InstallHooks; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hooks: {
      build: async () => {
        calls.push("build");
      },
      run: async (bin, args) => {
        const added = calls.some((line) => line.includes(" mcp add "));
        const line = `${bin} ${args.join(" ")}`;
        calls.push(line);
        if (args[0] === "install" && args[1] === "cloudflared") {
          return { code: brewCode, stdout: "", stderr: "" };
        }
        if (args[0] === "mcp" && args[1] === "get") return { code: added ? 0 : 1, stdout: "", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function runNode(
  home: string,
  args: string[],
  extra: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const loader = pathToFileURL(path.join(repoRoot, "node_modules", "tsx", "dist", "loader.mjs")).href;
  const env: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CLAUDE_REMOTE_ALLOW_SEND: "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: "0",
    CLAUDE_REMOTE_SPAWN_GUARD: "1",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    ...extra,
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", loader, path.join(repoRoot, "src", "index.ts"), ...args], {
      cwd: repoRoot,
      env,
    });
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

function runDesk(
  home: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const configDir = path.join(home, ".claude");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_REMOTE_ALLOW_SEND: "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: "0",
    CLAUDE_REMOTE_SPAWN_GUARD: "1",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    CLAUDE_REMOTE_TMUX_BIN: fakeTmux,
    ...extra,
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
