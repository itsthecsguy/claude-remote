import assert from "node:assert/strict";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { spawnClaude } from "../src/followup.js";
import { claudeChildEnv, inspectOauthToken, oauthTokenPath, OAUTH_TOKEN_ENV, readOauthToken } from "../src/oauth.js";
import { parseConfig } from "../src/config.js";
import { captureError, shimPath, tempHome } from "./helpers.js";

const TOKEN = "sk-ant-oat01-test-token-value-that-is-long-enough-0123456789";

test("the token file path defaults under ~/.config and can be overridden", () => {
  assert.equal(oauthTokenPath("/Users/nick"), "/Users/nick/.config/claude-remote/oauth-token");
  assert.equal(oauthTokenPath("/Users/nick", { CLAUDE_REMOTE_OAUTH_TOKEN_FILE: "/tmp/elsewhere" }), "/tmp/elsewhere");
  assert.equal(parseConfig({}, { home: "/Users/nick", platform: "linux" }).oauthTokenFile, "/Users/nick/.config/claude-remote/oauth-token");
});

test("only a regular 0600 file with one token line is usable, and nothing reports its contents", async () => {
  const { home } = await tempHome();
  const file = oauthTokenPath(home);
  assert.equal((await inspectOauthToken(file)).state, "missing");
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${TOKEN}\n`, { mode: 0o644 });
  await chmod(file, 0o644);
  const loose = await inspectOauthToken(file);
  assert.equal(loose.state, "bad-mode");
  assert.equal(loose.mode, "0644");
  assert.equal(loose.usable, false);
  assert.equal(await readOauthToken(file), null);
  await chmod(file, 0o600);
  // Three and a half days ahead: APFS can stamp the file a few milliseconds past Date.now().
  const good = await inspectOauthToken(file, Date.now() + 3.5 * 86_400_000);
  assert.equal(good.state, "present");
  assert.equal(good.mode, "0600");
  assert.equal(good.ageDays, 3);
  assert.equal(good.usable, true);
  assert.equal(JSON.stringify(good).includes(TOKEN), false);
  assert.equal(await readOauthToken(file), TOKEN);
  await writeFile(file, "\n", { mode: 0o600 });
  assert.equal((await inspectOauthToken(file)).state, "empty");
  await writeFile(file, "not a token\n", { mode: 0o600 });
  assert.equal((await inspectOauthToken(file)).state, "bad-shape");
  const link = path.join(home, "link");
  await symlink(file, link);
  assert.equal((await inspectOauthToken(link)).state, "symlink");
  assert.equal(await readOauthToken(link), null);
  assert.equal((await inspectOauthToken(path.dirname(file))).state, "not-a-file");
});

test("the child environment carries the token only when the file is usable, and an explicit variable wins", async () => {
  const { home } = await tempHome();
  const config = { oauthTokenFile: oauthTokenPath(home) };
  const base = { PATH: "/usr/bin:/bin", HOME: home };
  assert.equal(OAUTH_TOKEN_ENV in await claudeChildEnv(config, base), false);
  await mkdir(path.dirname(config.oauthTokenFile), { recursive: true, mode: 0o700 });
  await writeFile(config.oauthTokenFile, `${TOKEN}\n`, { mode: 0o600 });
  await chmod(config.oauthTokenFile, 0o644);
  const logs = await captureError(async () => {
    const ignored = await claudeChildEnv(config, base);
    assert.equal(OAUTH_TOKEN_ENV in ignored, false);
  });
  assert.match(logs, /"tool":"oauth-token","code":"ignored-bad-mode"/);
  assert.equal(logs.includes(TOKEN), false);
  await chmod(config.oauthTokenFile, 0o600);
  const used = await claudeChildEnv(config, base);
  assert.equal(used[OAUTH_TOKEN_ENV], TOKEN);
  assert.equal(used.PATH, base.PATH);
  assert.equal(OAUTH_TOKEN_ENV in base, false, "the parent environment is not changed");
  const explicit = await claudeChildEnv(config, { ...base, [OAUTH_TOKEN_ENV]: "explicit" });
  assert.equal(explicit[OAUTH_TOKEN_ENV], "explicit");
});

test("a headless claude child sees the token from the file, and the shim records only that it was set", async () => {
  const { home } = await tempHome();
  const cwd = path.join(home, "proj");
  await mkdir(cwd, { recursive: true });
  const config = { oauthTokenFile: oauthTokenPath(home) };
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home };
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--resume", "abcdefab-cdef-4def-8aaa-abcdefabcdef", "hello"];
  const without = await spawnClaude({ bin: shimPath, args, stdin: null, cwd, timeoutMs: 20_000, redact: "", env: await claudeChildEnv(config, base) });
  assert.equal(without.exitCode, 0);
  assert.equal(JSON.parse(await readFile(path.join(cwd, "fake-claude-record.json"), "utf8")).oauth, "unset");
  await mkdir(path.dirname(config.oauthTokenFile), { recursive: true, mode: 0o700 });
  await writeFile(config.oauthTokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const withToken = await spawnClaude({ bin: shimPath, args, stdin: null, cwd, timeoutMs: 20_000, redact: "", env: await claudeChildEnv(config, base) });
  assert.equal(withToken.exitCode, 0);
  const record = await readFile(path.join(cwd, "fake-claude-record.json"), "utf8");
  assert.equal(JSON.parse(record).oauth, "set");
  assert.equal(record.includes(TOKEN), false);
});
