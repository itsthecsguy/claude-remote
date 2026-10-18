import type { Config } from "./config.js";
import { logEvent } from "./log.js";
import { processIdentity, type ProcessIdentityLookup } from "./registry.js";
import { listCmdlines } from "./running.js";
import { getSession, type CommandLister } from "./tools.js";

export const REPLY_LIMIT = 300;

export type ShowView = {
  sessionId: string;
  title: string | null;
  lastActivity: string | null;
  messageCount: number;
  reply: string;
};

export async function showSession(
  config: Config,
  sessionId: string,
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<ShowView> {
  const started = Date.now();
  const detail = await getSession(config, { sessionId }, lister, identity);
  const full = detail.lastReply;
  const reply = full.length > REPLY_LIMIT ? full.slice(0, REPLY_LIMIT) : full;
  logEvent({
    tool: "show",
    sessionId: detail.card.sessionId,
    durationMs: Date.now() - started,
  });
  return {
    sessionId: detail.card.sessionId,
    title: detail.card.title,
    lastActivity: detail.card.lastActivity,
    messageCount: detail.card.messageCount,
    reply,
  };
}
