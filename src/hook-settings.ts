import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DeskError } from "./domain.js";

/**
 * Merge the claude-remote hook handlers into Claude Code's user settings.json, and take them out
 * again. Every handler we add carries HOOK_MARKER in its args, so removal touches exactly those
 * handlers and nothing else. The file is only read and written programmatically: it can hold env
 * secrets, so its contents are never printed or put in an error message.
 */

export const HOOK_MARKER = "--from=claude-remote";
export const QUICK_HOOK_TIMEOUT_S = 5;

type Handler = Record<string, unknown>;
type Group = { matcher?: string; hooks: Handler[] } & Record<string, unknown>;

export type HookPlan = Record<string, Group[]>;

/** The hook groups install adds. waitS is the helper's remote-answer timeout in seconds. */
export function hookPlan(nodeBin: string, entry: string, waitS: number): HookPlan {
  const handler = (extra: Record<string, unknown>): Handler => ({
    type: "command",
    command: nodeBin,
    args: [entry, "hook", HOOK_MARKER],
    ...extra,
  });
  const waiting = { timeout: waitS + 15 };
  const quick = { timeout: QUICK_HOOK_TIMEOUT_S };
  const background = { timeout: QUICK_HOOK_TIMEOUT_S, async: true };
  return {
    Notification: [{ hooks: [handler(quick)] }],
    PermissionRequest: [{ hooks: [handler(waiting)] }],
    PreToolUse: [{ matcher: "AskUserQuestion", hooks: [handler(waiting)] }],
    PostToolUse: [{ hooks: [handler(background)] }],
    PostToolUseFailure: [{ hooks: [handler(background)] }],
    PermissionDenied: [{ hooks: [handler(background)] }],
    UserPromptSubmit: [{ hooks: [handler(background)] }],
    Stop: [{ hooks: [handler(background)] }],
    StopFailure: [{ hooks: [handler(background)] }],
    SessionEnd: [{ hooks: [handler(background)] }],
  };
}

export function isOurHandler(handler: unknown): boolean {
  if (!handler || typeof handler !== "object") return false;
  const args = (handler as { args?: unknown }).args;
  return Array.isArray(args) && args.includes(HOOK_MARKER);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Return a copy of settings without our handlers. Groups and events left empty by that go too. */
export function removeOurHooks(settings: Record<string, unknown>): Record<string, unknown> {
  const out = { ...settings };
  if (!isObject(out.hooks)) return out;
  const hooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(out.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) {
        kept.push(group);
        continue;
      }
      const handlers = group.hooks.filter((handler) => !isOurHandler(handler));
      if (handlers.length === group.hooks.length) kept.push(group);
      else if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  else out.hooks = hooks;
  return out;
}

/** Return a copy of settings with exactly one copy of our handlers. */
export function mergeOurHooks(settings: Record<string, unknown>, plan: HookPlan): Record<string, unknown> {
  if (settings.hooks !== undefined && !isObject(settings.hooks)) {
    throw new DeskError("settings-shape", "settings.json has a hooks value that is not an object; not editing it");
  }
  const base = removeOurHooks(settings);
  const hooks: Record<string, unknown> = isObject(base.hooks) ? { ...base.hooks } : {};
  for (const [event, groups] of Object.entries(plan)) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) {
      throw new DeskError("settings-shape", `settings.json hooks.${event} is not an array; not editing it`);
    }
    hooks[event] = [...(existing ?? []), ...groups];
  }
  return { ...base, hooks };
}

export type SettingsEdit = {
  settingsPath: string;
  backupPath: string | null;
  changed: boolean;
  created: boolean;
};

export function settingsPathFor(configRoot: string): string {
  return path.join(configRoot, "settings.json");
}

export function backupStamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export async function installHooks(configRoot: string, plan: HookPlan, now: Date = new Date()): Promise<SettingsEdit> {
  return editSettings(configRoot, (settings) => mergeOurHooks(settings, plan), now, true);
}

export async function uninstallHooks(configRoot: string, now: Date = new Date()): Promise<SettingsEdit> {
  return editSettings(configRoot, removeOurHooks, now, false);
}

/** Report whether our hooks are present, without changing anything. */
export async function hooksInstalled(configRoot: string): Promise<boolean> {
  const loaded = await loadSettings(settingsPathFor(configRoot));
  if (!loaded || !isObject(loaded.settings.hooks)) return false;
  return Object.values(loaded.settings.hooks).some((groups) => Array.isArray(groups)
    && groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOurHandler)));
}

async function loadSettings(file: string): Promise<{ target: string; settings: Record<string, unknown>; mode: number } | null> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const target = info.isSymbolicLink() ? await realpath(file) : file;
  const real = info.isSymbolicLink() ? await lstat(target) : info;
  if (!real.isFile()) throw new DeskError("settings-shape", "settings.json is not a regular file; not editing it");
  if (real.size > 5 * 1024 * 1024) throw new DeskError("settings-shape", "settings.json is too large; not editing it");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(target, "utf8"));
  } catch {
    throw new DeskError("settings-unreadable", "settings.json is not valid JSON; not editing it");
  }
  if (!isObject(parsed)) throw new DeskError("settings-shape", "settings.json is not a JSON object; not editing it");
  return { target, settings: parsed, mode: real.mode & 0o777 };
}

async function editSettings(
  configRoot: string,
  edit: (settings: Record<string, unknown>) => Record<string, unknown>,
  now: Date,
  createIfMissing: boolean,
): Promise<SettingsEdit> {
  const file = settingsPathFor(configRoot);
  const loaded = await loadSettings(file);
  if (!loaded) {
    if (!createIfMissing) return { settingsPath: file, backupPath: null, changed: false, created: false };
    const next = edit({});
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await writeAtomic(file, next, 0o600);
    return { settingsPath: file, backupPath: null, changed: true, created: true };
  }
  const next = edit(loaded.settings);
  if (JSON.stringify(next) === JSON.stringify(loaded.settings)) {
    return { settingsPath: file, backupPath: null, changed: false, created: false };
  }
  const backupPath = `${loaded.target}.bak-claude-remote-${backupStamp(now)}`;
  await copyFile(loaded.target, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, 0o600);
  await writeAtomic(loaded.target, next, loaded.mode || 0o600);
  return { settingsPath: file, backupPath, changed: true, created: false };
}

async function writeAtomic(target: string, value: Record<string, unknown>, mode: number): Promise<void> {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.chmod(mode);
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, target);
}
