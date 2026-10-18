import os from "node:os";
import path from "node:path";

export type Config = {
  allowSend: boolean;
  allowLaunch: boolean;
  claudeBin: string;
  tmuxBin: string;
  configRoot: string;
  desktopRoot: string | null;
  desktopRootExplicit: boolean;
  sendTimeoutMs: number;
  launchWaitMs: number;
  attachmentMaxBytes: number;
  attachmentMaxTotalBytes: number;
  attachmentTtlMs: number;
  home: string;
  platform: NodeJS.Platform;
  osascriptBin: string;
  agentsJson: boolean;
  allowDeliver: boolean;
};

const PLATFORMS = new Set<NodeJS.Platform>([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "haiku",
  "linux",
  "openbsd",
  "sunos",
  "win32",
  "cygwin",
  "netbsd",
]);

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_LAUNCH_WAIT_MS = 8000;
const HARD_LAUNCH_WAIT_MS = 60_000;
const DEFAULT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const DEFAULT_ATTACHMENT_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
const HARD_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const HARD_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;

export function parseConfig(
  env: NodeJS.ProcessEnv,
  host?: { home?: string; platform?: NodeJS.Platform },
): Config {
  const home = host?.home ?? os.homedir();
  const platform = host?.platform ?? platformFromEnv(env.CLAUDE_REMOTE_PLATFORM);
  const configRoot = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0
    ? env.CLAUDE_CONFIG_DIR
    : path.join(home, ".claude");
  const desktopEnv = env.CLAUDE_REMOTE_DESKTOP_ROOT;
  const desktopRootExplicit = typeof desktopEnv === "string" && desktopEnv.length > 0;
  const timeoutRaw = env.CLAUDE_REMOTE_SEND_TIMEOUT_MS;
  const parsedTimeout = timeoutRaw ? Number(timeoutRaw) : DEFAULT_TIMEOUT_MS;
  const sendTimeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_TIMEOUT_MS;
  return {
    allowSend: env.CLAUDE_REMOTE_ALLOW_SEND === "1",
    allowLaunch: env.CLAUDE_REMOTE_ALLOW_LAUNCH === "1",
    claudeBin: env.CLAUDE_REMOTE_CLAUDE_BIN && env.CLAUDE_REMOTE_CLAUDE_BIN.length > 0
      ? env.CLAUDE_REMOTE_CLAUDE_BIN
      : "claude",
    tmuxBin: env.CLAUDE_REMOTE_TMUX_BIN && env.CLAUDE_REMOTE_TMUX_BIN.length > 0
      ? env.CLAUDE_REMOTE_TMUX_BIN
      : "tmux",
    configRoot,
    desktopRoot: desktopRootExplicit ? desktopEnv : null,
    desktopRootExplicit,
    sendTimeoutMs,
    launchWaitMs: bounded(env.CLAUDE_REMOTE_LAUNCH_WAIT_MS, DEFAULT_LAUNCH_WAIT_MS, HARD_LAUNCH_WAIT_MS),
    attachmentMaxBytes: bounded(env.CLAUDE_REMOTE_ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_BYTES, HARD_ATTACHMENT_BYTES),
    attachmentMaxTotalBytes: bounded(env.CLAUDE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES, DEFAULT_ATTACHMENT_TOTAL_BYTES, HARD_ATTACHMENT_TOTAL_BYTES),
    attachmentTtlMs: bounded(env.CLAUDE_REMOTE_ATTACHMENT_TTL_MS, DEFAULT_ATTACHMENT_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    home,
    platform,
    osascriptBin: env.CLAUDE_REMOTE_OSASCRIPT_BIN && env.CLAUDE_REMOTE_OSASCRIPT_BIN.length > 0
      ? env.CLAUDE_REMOTE_OSASCRIPT_BIN
      : "osascript",
    agentsJson: env.CLAUDE_REMOTE_AGENTS_JSON !== "0",
    allowDeliver: env.CLAUDE_REMOTE_ALLOW_DELIVER === "1",
  };
}

function platformFromEnv(raw: string | undefined): NodeJS.Platform {
  if (raw && PLATFORMS.has(raw as NodeJS.Platform)) return raw as NodeJS.Platform;
  return process.platform;
}

function bounded(raw: string | undefined, fallback: number, hard: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(Math.floor(parsed), hard);
}
