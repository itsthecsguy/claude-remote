import { channelListenerLive } from "./channel.js";
import type { Config } from "./config.js";
import type { LiveOwner, SessionStatus } from "./domain.js";
import { processIdentity, type ProcessIdentityLookup } from "./registry.js";
import { listCmdlines } from "./running.js";
import { listSessions, type CommandLister } from "./tools.js";
import type { AgentsLoader } from "./agents.js";

export type Activity = "working" | "needs-you" | "idle" | "unknown";

export type DeskRow = {
  sessionId: string;
  title: string | null;
  projectName: string;
  cwd: string | null;
  liveOwner: LiveOwner;
  channelAttached: boolean;
  activity: Activity;
  status: SessionStatus;
  subSessionCount: number;
  command: string | null;
  warning: string | null;
};

const PROBE_MS = 200;

/** working, needs-you, and idle pass through. Everything else, including not-running, is unknown. */
export function activityFromStatus(status: SessionStatus): Activity {
  switch (status.value) {
    case "working":
    case "needs-you":
    case "idle":
      return status.value;
    default:
      return "unknown";
  }
}

export async function listRows(
  config: Config,
  input: { project?: string; limit?: number },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
  agents?: AgentsLoader,
): Promise<DeskRow[]> {
  const listed = await listSessions(config, input, lister, identity, agents);
  const rows: DeskRow[] = [];
  for (const card of listed.sessions) {
    const channelAttached = await channelListenerLive(config.home, card.sessionId, PROBE_MS);
    rows.push({
      sessionId: card.sessionId,
      title: card.title,
      projectName: card.projectName,
      cwd: card.cwd,
      liveOwner: card.liveOwner,
      channelAttached,
      activity: activityFromStatus(card.status),
      status: card.status,
      subSessionCount: card.subSessionCount,
      command: card.command,
      warning: card.warning,
    });
  }
  return rows;
}
