import { DeskError } from "./domain.js";

/**
 * The only --settings value this server ever passes. It turns fast mode on for that one process
 * (fast-mode docs: `claude -p --settings '{"fastMode": true}'`). Any other --settings value is
 * refused, because a settings string can also carry a permission mode.
 */
export const FAST_MODE_SETTINGS = '{"fastMode":true}';

export type LaunchOptions = {
  /** true for `--worktree` with a generated name, or a name for `--worktree <name>`. */
  worktree: true | string | null;
  fastMode: boolean;
  /** A task description for `--cloud "<desc>"`, which creates a new cloud session. */
  cloud: string | null;
  /** A self-hosted environment id for `--environment ccpool_...`. Requires cloud. */
  environment: string | null;
  /** A first prompt. Starts a headless `-p` session that reports the init event. */
  prompt: string | null;
};

export type LaunchMode = "interactive" | "headless" | "cloud" | "environment";

const WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_ID = /^ccpool_[A-Za-z0-9_-]{1,128}$/;
const CLOUD_MAX = 2000;
const PROMPT_MAX = 100_000;

export function parseLaunchOptions(raw: {
  worktree?: unknown;
  fastMode?: unknown;
  cloud?: unknown;
  environment?: unknown;
  prompt?: unknown;
}): LaunchOptions {
  const worktree = worktreeOption(raw.worktree);
  if (raw.fastMode != null && typeof raw.fastMode !== "boolean") {
    throw new DeskError("bad-option", "fastMode must be a boolean");
  }
  const fastMode = raw.fastMode === true;
  const cloud = raw.cloud == null ? null : cloudOption(raw.cloud);
  const environment = raw.environment == null ? null : environmentOption(raw.environment);
  const prompt = raw.prompt == null ? null : promptOption(raw.prompt);
  if (environment && !cloud) throw new DeskError("bad-option", "environment needs a cloud task description");
  if (cloud && (worktree != null || fastMode || prompt != null)) {
    throw new DeskError("bad-option", "cloud sessions do not take worktree, fastMode, or prompt here");
  }
  return { worktree, fastMode, cloud, environment, prompt };
}

export function launchMode(options: LaunchOptions): LaunchMode {
  if (options.environment) return "environment";
  if (options.cloud) return "cloud";
  if (options.prompt != null) return "headless";
  return "interactive";
}

function worktreeOption(value: unknown): true | string | null {
  if (value == null || value === false) return null;
  if (value === true) return true;
  if (typeof value !== "string" || !WORKTREE_NAME.test(value) || value.includes("..")) {
    throw new DeskError("bad-option", "worktree name must be 1-64 letters, digits, dot, dash, or underscore, starting with a letter or digit");
  }
  return value;
}

/**
 * A cloud task description. It is passed as one argv entry, never through a shell. It may not
 * start with a dash (it would read as a flag) or look like a session id or URL, because that form
 * of --cloud sends into an existing cloud session instead of creating one.
 */
function cloudOption(value: unknown): string {
  if (typeof value !== "string") throw new DeskError("bad-option", "cloud must be a task description");
  const text = value.trim();
  if (text.length === 0 || text.length > CLOUD_MAX) {
    throw new DeskError("bad-option", `cloud description must be 1 to ${CLOUD_MAX} characters`);
  }
  if (hasControl(text, false)) throw new DeskError("bad-option", "cloud description may not contain control characters");
  if (text.startsWith("-")) throw new DeskError("bad-option", "cloud description may not start with a dash");
  if (/^(session_|cse_)[A-Za-z0-9]/.test(text) || /^https?:\/\//i.test(text)) {
    throw new DeskError("bad-option", "cloud takes a new task description, not an existing session id or URL");
  }
  return text;
}

function environmentOption(value: unknown): string {
  if (typeof value !== "string" || !ENVIRONMENT_ID.test(value)) {
    throw new DeskError("bad-option", "environment must be a ccpool_ id");
  }
  return value;
}

function promptOption(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > PROMPT_MAX) {
    throw new DeskError("bad-option", `prompt must be 1 to ${PROMPT_MAX} characters`);
  }
  if (hasControl(value, true)) throw new DeskError("bad-option", "prompt may not contain control characters");
  return value;
}

function hasControl(text: string, allowNewlines: boolean): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (allowNewlines && (char === "\n" || char === "\t" || char === "\r")) continue;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Flags that go on a local launch (interactive or headless), in order. */
export function localLaunchFlags(options: LaunchOptions): string[] {
  const flags: string[] = [];
  if (options.worktree === true) flags.push("--worktree");
  else if (typeof options.worktree === "string") flags.push("--worktree", options.worktree);
  if (options.fastMode) flags.push("--settings", FAST_MODE_SETTINGS);
  return flags;
}

/** argv after the binary for a cloud launch: interactive --cloud, or -p with --environment. */
export function cloudArgs(options: LaunchOptions): string[] {
  if (!options.cloud) throw new DeskError("bad-option", "cloud description is required");
  if (options.environment) {
    return ["-p", options.cloud, "--environment", options.environment, "--output-format", "json"];
  }
  return ["--cloud", options.cloud];
}

/**
 * Refuse a permission-bypass flag anywhere in argv. --settings is allowed only when the value
 * right after it is FAST_MODE_SETTINGS.
 */
export function assertNoBypass(args: readonly string[], forbidden: readonly string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--settings") {
      if (args[i + 1] === FAST_MODE_SETTINGS) {
        i += 1;
        continue;
      }
      throw new DeskError("denied", "refusing a settings value other than fast mode");
    }
    const name = arg.split("=")[0] ?? arg;
    if (forbidden.includes(arg) || forbidden.includes(name) || arg.startsWith("--settings=")) {
      throw new DeskError("denied", "refusing a permission-bypass flag");
    }
  }
}

export type InitFacts = {
  sessionId: string | null;
  fastModeState: "on" | "off" | "cooldown" | null;
  fastModeDisabledReason: string | null;
};

/** Read session_id and fast_mode_state from a stream-json system/init line. Other lines are null. */
export function initFromLine(line: string): InitFacts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const msg = parsed as Record<string, unknown>;
  if (msg.type !== "system" || msg.subtype !== "init") return null;
  const state = msg.fast_mode_state;
  const reason = msg.fast_mode_disabled_reason;
  return {
    sessionId: typeof msg.session_id === "string" && /^[0-9a-f-]{36}$/i.test(msg.session_id) ? msg.session_id.toLowerCase() : null,
    fastModeState: state === "on" || state === "off" || state === "cooldown" ? state : null,
    fastModeDisabledReason: typeof reason === "string" && /^[a-z0-9_-]{1,64}$/i.test(reason) ? reason : null,
  };
}

export type CloudCreated = { ok: true; cloudSessionId: string; url: string | null } | { ok: false; code: string };

/** Parse `--environment ... --output-format json` output: {ok, session_id, url}. */
export function parseCloudJson(stdout: string): CloudCreated {
  for (const line of stdout.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const body = parsed as Record<string, unknown>;
    if (body.ok === true && typeof body.session_id === "string" && CLOUD_SESSION.test(body.session_id)) {
      return { ok: true, cloudSessionId: body.session_id, url: cloudUrl(body.url) };
    }
    if (body.ok === false) return { ok: false, code: "cloud-create-failed" };
  }
  return { ok: false, code: "cloud-unparsed" };
}

const CLOUD_SESSION = /^session_[A-Za-z0-9]{6,64}$/;

/** Find the session id and link that interactive `claude --cloud` prints. */
export function parseCloudPane(pane: string): { cloudSessionId: string; url: string | null } | null {
  const match = /Session ID:\s*(session_[A-Za-z0-9]{6,64})/.exec(pane) ?? /\b(session_[A-Za-z0-9]{6,64})\b/.exec(pane);
  if (!match?.[1]) return null;
  const link = /(https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{6,64}[^\s]*)/.exec(pane);
  return { cloudSessionId: match[1], url: cloudUrl(link?.[1]) };
}

function cloudUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]{6,64}([?#][A-Za-z0-9=&_.%-]*)?$/.test(value) ? value : null;
}
