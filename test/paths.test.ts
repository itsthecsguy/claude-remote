import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { VID } from "../fixtures/ids.js";
import { DeskError } from "../src/domain.js";
import { allowSessionRecord, allowTranscript, rejectCredentialPath } from "../src/paths.js";
import { getSession } from "../src/tools.js";
import { configAt, tempDir, tempHome } from "./helpers.js";

test("a non-uuid session id is rejected before any transcript read", async () => {
  const { home, root } = await tempHome();
  await mkdir(path.join(root, "projects"), { recursive: true });
  const secret = path.join(home, ".claude", ".credentials.json");
  await writeFile(secret, "CREDENTIAL-SENTINEL");
  const before = (await stat(secret)).mtimeMs;
  const config = configAt(home, root);
  await assert.rejects(
    () => getSession(config, { sessionId: "../.credentials.json" }),
    (error: unknown) => {
      assert.ok(error instanceof DeskError);
      assert.equal(error.code, "not-uuid");
      assert.equal(error.message.includes("CREDENTIAL-SENTINEL"), false);
      return true;
    },
  );
  assert.equal((await stat(secret)).mtimeMs, before);
});

test("credential paths are refused and their mtime stays unchanged", async () => {
  const { home, root } = await tempHome();
  await mkdir(path.join(root, "projects", "slug"), { recursive: true });
  await mkdir(path.join(home, ".config", "anthropic"), { recursive: true });
  const files = [
    path.join(root, ".credentials.json"),
    path.join(home, ".claude.json"),
    path.join(home, ".config", "anthropic", "config.json"),
  ];
  for (const file of files) await writeFile(file, "CREDENTIAL-SENTINEL");
  const before = await Promise.all(files.map(async (file) => (await stat(file)).mtimeMs));
  for (const file of files) {
    await assert.rejects(
      () => allowTranscript(root, file, home),
      (error: unknown) => {
        assert.ok(error instanceof DeskError);
        assert.equal(error.code, "denied");
        assert.equal(error.message.includes("CREDENTIAL-SENTINEL"), false);
        return true;
      },
    );
  }
  const after = await Promise.all(files.map(async (file) => (await stat(file)).mtimeMs));
  assert.deepEqual(after, before);
});

test("a uuid-named symlink to a file outside projects is refused", async () => {
  const { home, root } = await tempHome();
  const project = path.join(root, "projects", "slug");
  await mkdir(project, { recursive: true });
  const outside = path.join(home, "outside.txt");
  await writeFile(outside, "OUTSIDE-SENTINEL");
  await symlink(outside, path.join(project, `${VID}.jsonl`));
  const before = (await stat(outside)).mtimeMs;
  const config = configAt(home, root);
  await assert.rejects(
    () => getSession(config, { sessionId: VID }),
    (error: unknown) => {
      assert.ok(error instanceof DeskError);
      assert.equal(error.code, "denied");
      assert.equal(error.message.includes("OUTSIDE-SENTINEL"), false);
      return true;
    },
  );
  assert.equal((await stat(outside)).mtimeMs, before);
});

test("a credential file reached through the real home is refused when home is a symlink", async () => {
  const realHome = await mkdtemp(path.join(tmpdir(), "claude-remote-home-"));
  const parent = await mkdtemp(path.join(tmpdir(), "claude-remote-home-link-"));
  const home = path.join(parent, "home");
  await symlink(realHome, home);
  const file = path.join(realHome, ".config", "anthropic", "config.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "CREDENTIAL-SENTINEL");
  const before = (await stat(file)).mtimeMs;
  assert.throws(
    () => rejectCredentialPath(file, home),
    (error: unknown) => {
      assert.ok(error instanceof DeskError);
      assert.equal(error.code, "denied");
      assert.equal(error.message.includes("CREDENTIAL-SENTINEL"), false);
      return true;
    },
  );
  assert.equal((await stat(file)).mtimeMs, before);
});

test("a symlinked config root still refuses a transcript that leaves projects", async () => {
  const { home, root } = await tempHome();
  await mkdir(root, { recursive: true });
  const parent = await tempDir("claude-remote-cfg-");
  const linkRoot = path.join(parent, "claude");
  await symlink(root, linkRoot);
  const project = path.join(linkRoot, "projects", "slug");
  await mkdir(project, { recursive: true });
  const outside = path.join(home, "outside.txt");
  await writeFile(outside, "OUTSIDE-SENTINEL");
  const before = (await stat(outside)).mtimeMs;
  await symlink(outside, path.join(project, `${VID}.jsonl`));
  await assert.rejects(
    () => getSession(configAt(home, linkRoot), { sessionId: VID }),
    (error: unknown) => {
      assert.ok(error instanceof DeskError);
      assert.equal(error.code, "denied");
      assert.equal(error.message.includes("OUTSIDE-SENTINEL"), false);
      return true;
    },
  );
  assert.equal((await stat(outside)).mtimeMs, before);
});

test("a session key file is refused before it is read", async () => {
  const { home, root } = await tempHome();
  const dir = path.join(root, "sessions");
  await mkdir(dir, { recursive: true });
  const key = path.join(dir, "4242.abc123.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const stale = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(key, stale, stale);
  const before = (await stat(key)).atimeMs;
  await assert.rejects(
    () => allowSessionRecord(root, key, home),
    (error: unknown) => {
      assert.ok(error instanceof DeskError);
      assert.equal(error.code, "denied");
      assert.equal(error.message.includes("SECRET-KEY-BODY"), false);
      return true;
    },
  );
  assert.ok(Math.abs((await stat(key)).atimeMs - before) < 1000);
});

test("a pid json symlink to a key file is refused before the key is opened", async () => {
  const { home, root } = await tempHome();
  const dir = path.join(root, "sessions");
  const locked = path.join(dir, "locked");
  await mkdir(locked, { recursive: true });
  const key = path.join(locked, "4242.abc123.key");
  await writeFile(key, "SECRET-KEY-BODY");
  await chmod(locked, 0);
  const link = path.join(dir, "4242.json");
  await symlink(path.join("locked", "4242.abc123.key"), link);
  try {
    await assert.rejects(
      () => allowSessionRecord(root, link, home),
      (error: unknown) => {
        assert.ok(error instanceof DeskError);
        assert.equal(error.code, "denied");
        assert.equal(error.message.includes("SECRET-KEY-BODY"), false);
        return true;
      },
    );
  } finally {
    await chmod(locked, 0o755);
  }
});
