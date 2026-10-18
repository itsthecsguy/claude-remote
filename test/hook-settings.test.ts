import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { HOOK_MARKER, hookPlan, hooksInstalled, installHooks, isOurHandler, mergeOurHooks, removeOurHooks, uninstallHooks } from "../src/hook-settings.js";
import { tempHome } from "./helpers.js";

const plan = hookPlan("/usr/bin/node", "/opt/claude-remote/dist/index.js", 120);

const existing = {
  model: "opus",
  env: { SOME_SECRET: "do-not-print-me" },
  permissions: { allow: ["Bash(git status)"] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/guard.sh" }] }],
    Notification: [{ hooks: [{ type: "command", command: "say hi" }] }],
    SessionStart: [{ hooks: [{ type: "command", command: "echo start" }] }],
  },
};

test("the plan registers the documented events and waits only on permission and question hooks", () => {
  assert.deepEqual(Object.keys(plan).sort(), [
    "Notification", "PermissionDenied", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
    "PreToolUse", "SessionEnd", "Stop", "StopFailure", "UserPromptSubmit",
  ]);
  const handler = plan.PermissionRequest?.[0]?.hooks[0] as Record<string, unknown>;
  assert.deepEqual(handler.args, ["/opt/claude-remote/dist/index.js", "hook", HOOK_MARKER]);
  assert.equal(handler.timeout, 135);
  assert.equal(handler.async, undefined);
  assert.equal(plan.PreToolUse?.[0]?.matcher, "AskUserQuestion");
  assert.equal((plan.PostToolUse?.[0]?.hooks[0] as Record<string, unknown>).async, true);
  assert.equal((plan.Notification?.[0]?.hooks[0] as Record<string, unknown>).timeout, 5);
  assert.equal(JSON.stringify(plan).includes("bypassPermissions"), false);
});

test("merge keeps every other key and hook, is idempotent, and remove takes out exactly ours", () => {
  const merged = mergeOurHooks(existing, plan);
  assert.equal(merged.model, "opus");
  assert.deepEqual(merged.env, existing.env);
  assert.deepEqual(merged.permissions, existing.permissions);
  const hooks = merged.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>;
  assert.equal(hooks.PreToolUse?.length, 2);
  assert.equal(hooks.PreToolUse?.[0]?.matcher, "Bash");
  assert.equal(hooks.Notification?.length, 2);
  assert.deepEqual(hooks.SessionStart, existing.hooks.SessionStart);
  assert.deepEqual(mergeOurHooks(merged, plan), merged);
  assert.deepEqual(removeOurHooks(merged), existing);
  assert.deepEqual(removeOurHooks(mergeOurHooks({}, plan)), {});
  // A group we share with someone else keeps their handler.
  const shared = { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }, plan.Stop?.[0]?.hooks[0]] }] } };
  assert.deepEqual(removeOurHooks(shared), { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
  assert.equal(isOurHandler({ type: "command", command: "node", args: ["x", "hook"] }), false);
  assert.throws(() => mergeOurHooks({ hooks: [] }, plan), /not an object/);
});

test("install backs up settings.json, writes the merge, and uninstall restores the original content", async () => {
  const { root } = await tempHome();
  await mkdir(root, { recursive: true });
  const file = path.join(root, "settings.json");
  const original = `${JSON.stringify(existing, null, 2)}\n`;
  await writeFile(file, original, { mode: 0o600 });
  const first = await installHooks(root, plan, new Date("2026-10-18T12:00:00Z"));
  assert.equal(first.changed, true);
  assert.equal(first.backupPath, `${file}.bak-claude-remote-20261018T120000Z`);
  assert.equal(await readFile(first.backupPath ?? "", "utf8"), original);
  assert.equal((await stat(first.backupPath ?? "")).mode & 0o777, 0o600);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await hooksInstalled(root), true);
  const again = await installHooks(root, plan, new Date("2026-10-18T12:05:00Z"));
  assert.equal(again.changed, false);
  assert.equal(again.backupPath, null);
  assert.equal((await readdir(root)).filter((name) => name.includes(".bak-claude-remote-")).length, 1);
  const removed = await uninstallHooks(root, new Date("2026-10-18T12:10:00Z"));
  assert.equal(removed.changed, true);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), existing);
  assert.equal(await hooksInstalled(root), false);
  assert.equal((await uninstallHooks(root)).changed, false);
});

test("install creates settings.json when missing, follows a symlink, and refuses invalid JSON without echoing it", async () => {
  const { home, root } = await tempHome();
  const created = await installHooks(root, plan);
  assert.equal(created.created, true);
  assert.equal(created.backupPath, null);
  assert.equal((await stat(path.join(root, "settings.json"))).mode & 0o777, 0o600);

  const other = path.join(home, "dotfiles");
  await mkdir(other, { recursive: true });
  const linkedRoot = path.join(home, "linked");
  await mkdir(linkedRoot, { recursive: true });
  await writeFile(path.join(other, "settings.json"), "{\"theme\":\"dark\"}\n", { mode: 0o644 });
  await symlink(path.join(other, "settings.json"), path.join(linkedRoot, "settings.json"));
  const linked = await installHooks(linkedRoot, plan);
  assert.equal(linked.changed, true);
  assert.ok(linked.backupPath?.startsWith(path.join(other, "settings.json")));
  assert.equal((await lstat(path.join(linkedRoot, "settings.json"))).isSymbolicLink(), true);
  assert.equal(JSON.parse(await readFile(path.join(other, "settings.json"), "utf8")).theme, "dark");

  const badRoot = path.join(home, "bad");
  await mkdir(badRoot, { recursive: true });
  await writeFile(path.join(badRoot, "settings.json"), "{\"env\":{\"TOKEN\":\"SECRET-VALUE\"},");
  await assert.rejects(() => installHooks(badRoot, plan), (error: Error) => {
    assert.match(error.message, /not valid JSON/);
    assert.equal(error.message.includes("SECRET-VALUE"), false);
    return true;
  });
  assert.equal(await readFile(path.join(badRoot, "settings.json"), "utf8"), "{\"env\":{\"TOKEN\":\"SECRET-VALUE\"},");
});
