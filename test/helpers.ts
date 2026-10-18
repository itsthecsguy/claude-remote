import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../src/config.js";

process.env.CLAUDE_REMOTE_SPAWN_GUARD ??= "1";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixtureRoot = path.join(repoRoot, "fixtures", "home");
export const desktopRoot = path.join(repoRoot, "fixtures", "desktop");
export const shimPath = path.join(repoRoot, "scripts", "fake-claude.mjs");

export function fixtureConfig(options?: { allowSend?: boolean; timeoutMs?: number }): Config {
  return parseConfig({
    CLAUDE_CONFIG_DIR: fixtureRoot,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
    CLAUDE_REMOTE_ALLOW_SEND: options?.allowSend ? "1" : "0",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    CLAUDE_REMOTE_SEND_TIMEOUT_MS: options?.timeoutMs ? String(options.timeoutMs) : undefined,
  }, { home: path.join(repoRoot, "fixtures"), platform: "linux" });
}

export async function tempDir(prefix: string): Promise<string> {
  const root = process.platform === "win32" ? tmpdir() : "/tmp";
  return realpath(await mkdtemp(path.join(root, `cr-${prefix}`)));
}

export async function tempHome(): Promise<{ home: string; root: string }> {
  const home = await tempDir("h");
  const root = path.join(home, ".claude");
  return { home, root };
}

export function configAt(home: string, root: string, options?: { allowSend?: boolean; timeoutMs?: number; desktop?: string }): Config {
  return parseConfig({
    CLAUDE_CONFIG_DIR: root,
    CLAUDE_REMOTE_DESKTOP_ROOT: options?.desktop,
    CLAUDE_REMOTE_ALLOW_SEND: options?.allowSend ? "1" : "0",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    CLAUDE_REMOTE_SEND_TIMEOUT_MS: options?.timeoutMs ? String(options.timeoutMs) : undefined,
  }, { home, platform: "linux" });
}

export async function captureError(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines.join("\n");
}
