import type { EntrypointOwner, LiveOwner, RunState } from "./domain.js";
import { assertNever } from "./domain.js";

export const DEV_CHANNELS_FLAG = "--dangerously-load-development-channels";
export const CHANNEL_SERVER = "claude-remote-channel";

const DESKTOP_WARNING =
  "Stop this session in the desktop app before you run this command. Two writers must not resume the same transcript.";
const TERMINAL_WARNING =
  "Stop the terminal process that owns this session before you run this command. Two writers must not resume the same transcript.";
const UNKNOWN_WARNING =
  "Stop the live process that owns this session before you run this command. Two writers must not resume the same transcript.";

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function shellToken(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return shellQuote(value);
}

export function continueCommandLine(bin: string, cwd: string, sessionId: string): string {
  return `cd ${shellQuote(cwd)} && ${shellToken(bin)} --resume ${sessionId} ${DEV_CHANNELS_FLAG} server:${CHANNEL_SERVER}`;
}

export function liveWriterWarning(owner: LiveOwner): string | null {
  switch (owner) {
    case "none":
      return null;
    case "desktop":
      return DESKTOP_WARNING;
    case "terminal":
      return TERMINAL_WARNING;
    case "unknown":
      return UNKNOWN_WARNING;
    default: {
      const _never: never = owner;
      return assertNever(_never);
    }
  }
}

export function classifyLiveOwner(input: {
  runState: RunState;
  sessionId: string;
  registryOwner: EntrypointOwner | undefined;
  cmdlines: readonly string[];
}): LiveOwner {
  switch (input.runState.kind) {
    case "finished":
      return "none";
    case "unknown":
      switch (input.runState.reason) {
        case "tail-open":
          return "none";
        case "sessions-dir-unreadable":
        case "sessions-file-unverified":
          return "unknown";
        default: {
          const _never: never = input.runState.reason;
          return assertNever(_never);
        }
      }
    case "running":
      switch (input.runState.evidence) {
        case "sessions-file":
          return ownerFromRegistry(input.registryOwner, input.sessionId, input.cmdlines);
        case "process-argv":
          return ownerFromCmdlines(input.sessionId, input.cmdlines) ?? "unknown";
        default: {
          const _never: never = input.runState.evidence;
          return assertNever(_never);
        }
      }
    default: {
      const _never: never = input.runState;
      return assertNever(_never);
    }
  }
}

function ownerFromRegistry(
  marked: EntrypointOwner | undefined,
  sessionId: string,
  cmdlines: readonly string[],
): LiveOwner {
  switch (marked) {
    case "desktop":
      return "desktop";
    case "terminal":
      return "terminal";
    case "other":
      return "unknown";
    case "absent":
    case undefined:
      return ownerFromCmdlines(sessionId, cmdlines) ?? "unknown";
    default: {
      const _never: never = marked;
      return assertNever(_never);
    }
  }
}

export function ownerFromCommand(line: string): "desktop" | "terminal" | null {
  if (line.includes("Claude.app") || line.includes("Claude Helper")) return "desktop";
  if (/(^|[\\/\s])claude-desktop([\\/\s]|$)/.test(line)) return "desktop";
  if (/(^|[\\/\s"'`])claude([\\/\s"'`]|$)/.test(line)) return "terminal";
  return null;
}

function ownerFromCmdlines(sessionId: string, cmdlines: readonly string[]): "desktop" | "terminal" | null {
  const id = sessionId.toLowerCase();
  let terminal = false;
  for (const line of cmdlines) {
    if (!line.toLowerCase().includes(id)) continue;
    const owner = ownerFromCommand(line);
    if (owner === "desktop") return "desktop";
    if (owner === "terminal") terminal = true;
  }
  return terminal ? "terminal" : null;
}
