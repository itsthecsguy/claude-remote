import { DEV_CHANNELS_FLAG, CHANNEL_SERVER, shellQuote, shellToken } from "./continue.js";
import { DeskError } from "./domain.js";
import { FORBIDDEN_FLAGS } from "./followup.js";

export const DEV_CHANNEL_WARNING = "WARNING: Loading development channels";
export const DEV_CHANNEL_ACCEPT = "1. I am using this for local development";
export const DEV_CHANNEL_EXIT = "2. Exit";
export const MCP_SERVER_PROMPT = "New MCP server found";
export const CHROME_EXTENSION_PROMPT = "Claude in Chrome extension detected";
export const TRUST_EXIT = "No, exit";
export const TMUX_INSTALL_HINT = "tmux is not installed. Install it with brew install tmux.";

export type BlockingDialog = "workspace-trust" | "mcp-server" | "chrome-extension";

export function blockingDialog(pane: string): BlockingDialog | null {
  if (pane.includes(CHROME_EXTENSION_PROMPT)) return "chrome-extension";
  if (pane.includes(MCP_SERVER_PROMPT)) return "mcp-server";
  if (pane.includes(TRUST_EXIT) && /trust/i.test(pane)) return "workspace-trust";
  return null;
}

export function devPromptReady(pane: string): boolean {
  const highlighted = pane.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed.startsWith("❯") && trimmed.includes(DEV_CHANNEL_ACCEPT) && !trimmed.includes(DEV_CHANNEL_EXIT);
  });
  return pane.includes(DEV_CHANNEL_WARNING)
    && highlighted
    && pane.includes(DEV_CHANNEL_EXIT)
    && !pane.includes(MCP_SERVER_PROMPT);
}

export function paneBlocksExit(pane: string): boolean {
  return pane.includes(DEV_CHANNEL_WARNING) || blockingDialog(pane) != null;
}

export function terminalArgs(
  bin: string,
  sessionId: string | null,
  extra: { addDir: string; mcpConfig: string },
): string[] {
  const args = [bin, "--add-dir", extra.addDir, "--mcp-config", extra.mcpConfig, "--no-chrome"];
  if (sessionId) args.push("--resume", sessionId);
  args.push(DEV_CHANNELS_FLAG, `server:${CHANNEL_SERVER}`);
  for (const arg of args) {
    if ((FORBIDDEN_FLAGS as readonly string[]).includes(arg)) {
      throw new DeskError("denied", "refusing a permission-bypass flag");
    }
  }
  return args;
}

export function shellLine(cwd: string, args: readonly string[]): string {
  return `cd ${shellQuote(cwd)} && ${args.map((arg) => shellToken(arg)).join(" ")}`;
}

export function appleScriptDo(line: string): string {
  const quoted = `"${line.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `tell application "Terminal" to do script ${quoted}`;
}
