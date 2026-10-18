import { channelListenerLive } from "./channel.js";
import type { Config } from "./config.js";
import type { LiveOwner } from "./domain.js";
import { observedRegistryStatus, processIdentity, type ProcessIdentityLookup } from "./registry.js";
import { listCmdlines } from "./running.js";
import { listSessions, type CommandLister } from "./tools.js";

export type Activity = "idle" | "busy" | "unknown";

export type DeskRow = {
  sessionId: string;
  title: string | null;
  projectName: string;
  cwd: string | null;
  liveOwner: LiveOwner;
  channelAttached: boolean;
  activity: Activity;
  command: string | null;
  warning: string | null;
};

const PROBE_MS = 200;

export function activityFromStatus(token: string | null): Activity {
  switch (token) {
    case "idle":
      return "idle";
    case "busy":
      return "busy";
    case null:
      return "unknown";
    default:
      return "unknown";
  }
}

export async function listRows(
  config: Config,
  input: { project?: string; limit?: number },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<DeskRow[]> {
  const listed = await listSessions(config, input, lister, identity);
  const rows: DeskRow[] = [];
  for (const card of listed.sessions) {
    const token = await observedRegistryStatus(config.configRoot, config.home, card.sessionId);
    const channelAttached = await channelListenerLive(config.home, card.sessionId, PROBE_MS);
    rows.push({
      sessionId: card.sessionId,
      title: card.title,
      projectName: card.projectName,
      cwd: card.cwd,
      liveOwner: card.liveOwner,
      channelAttached,
      activity: activityFromStatus(token),
      command: card.command,
      warning: card.warning,
    });
  }
  return rows;
}
