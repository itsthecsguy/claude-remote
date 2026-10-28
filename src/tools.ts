import { attachPending } from "./pending.js";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ATTACHMENT_DATA_MAX_CHARS, MAX_ATTACHMENTS, composePrompt, prepareAttachments, removeStaged, sweepAttachments, writeStaged } from "./attachments.js";
import { cleanupDesk } from "./cleanup.js";
import {
  CHANNEL_OFFER_MS,
  HANDED_NOTICE,
  REJECTED_NOTICE,
  UNDELIVERED_NOTICE,
  channelListenerBound,
  channelListenerLive,
  listenerSocket,
  liveSocketIds,
  offerChannel,
} from "./channel.js";
import { classifyLiveOwner, continueCommandLine, liveWriterWarning } from "./continue.js";
import type { Config } from "./config.js";
import type { LiveOwner, ProcessDetailsView, SessionCard, SessionDetail, SessionRegistry, SessionStatus, SubSessionRow, TailEnd, WorktreeLaunch } from "./domain.js";
import { DeskError, assertNever } from "./domain.js";
import { loadDesktopIndex, recordedWorkingFolder, resolveDesktopRoot, sessionTitle, type DesktopMeta } from "./desktop.js";
import { DESKTOP_NOTICE, followupInvocation, resolveSpawnCwd, skipsFolderProbe, spawnClaude } from "./followup.js";
import { readLaunches, type LaunchRecord } from "./launches.js";
import { logEvent, type LogEvent } from "./log.js";
import { claudeChildEnv } from "./oauth.js";
import {
  QUEUE_NOTICE,
  STEER_NOTICE,
  blockReason,
  deliverQueue,
  enqueueTicket,
  listTicketViews,
  soleWriterAllowed,
  type DeliverResult,
  type FollowupMode,
  type FollowupOutcome,
  type QueueReason,
  type StagedAttachmentView,
  type TicketView,
} from "./queue.js";
import { discoverTranscripts, parseSessionId, resolveSessionFile } from "./paths.js";
import { loadLiveRecords, loadSessionRegistry, observedRegistryStatus, processIdentity, type LiveRecord, type ProcessIdentityLookup } from "./registry.js";
import { readTranscript, type TranscriptFacts } from "./read.js";
import { classifyRunState, listCmdlines, runStateEvidence, tailFlag } from "./running.js";
import { summarize } from "./summary.js";
import { loadAgents, resolveStatus, statusFromEntry, statusFromToken, type AgentsLoader, type AgentsSnapshot } from "./agents.js";
import { listSubSessions } from "./subagents.js";

export type ListResult = {
  sessions: SessionCard[];
  scannedFileCount: number;
  pagedBy: "mtime";
};

export type SendResult = FollowupOutcome;

export type ContinueCommandResult = {
  sessionId: string;
  command: string;
  cwd: string;
  worktreeLaunch: WorktreeLaunch | null;
  liveOwner: LiveOwner;
  warning: string | null;
};

export type QueueStatusResult = {
  sessionId: string;
  tickets: TicketView[];
  delivered: { ticketId: string; exitCode: number; state: "sent" }[];
  blocked: boolean;
  reason: QueueReason | null;
};

export type CommandLister = () => Promise<string[]>;

/** Sub-session rows shown per card in list_sessions. get_session returns all of them. */
const LIST_SUB_ROWS = 20;

export function defaultAgentsLoader(config: Config): AgentsLoader {
  return async () => loadAgents(config.claudeBin, { disabled: !config.agentsJson, env: await claudeChildEnv(config) });
}

const LIST_DESCRIPTION = "List local coding sessions. Each row has the sidebar title when the session is joined, otherwise the transcript title, the project name, cwd as the recorded working folder, run state, status, liveOwner, the continue command, and the live-owner warning. status.value comes from claude agents --json: busy is working, waiting is needs-you with waitingFor, idle is idle, and a background session uses its state (working, blocked as needs-you, done as idle, failed, stopped). A session agents --json does not list is not-running. When that command is missing or fails, status falls back to the sessions/<pid>.json token and status.source says so. process carries entrypoint, tmux, bridgeSessionId, and messagingSocketPath from sessions/<pid>.json while the process is live. subSessions lists subagent transcripts under the session (agentType, isFork, spawnDepth, finished, size, last write) from file stats and .meta.json only, up to 20 per row; subSessionCount is the total. pending lists what the session is waiting on when the claude-remote hooks are installed: the permission request (tool name and input summary), the AskUserQuestion text and options, or the notification message, with a requestId and answerable (see list_pending, answer_permission, answer_question). A session with no transcript yet is included when sessions/<pid>.json names it and that pid is alive with a matching procStart, or when its channel socket accepts a connection. liveOwner is desktop, terminal, none, or unknown. cwd is not the encoded project directory name. The page has no transcript text. A running state with evidence sessions-file means the registry file is live. If the start time cannot be checked, the state is unknown. finished means there is no live marker and the tail is closed. It does not mean the coding task succeeded. Transcript rows are paged by file mtime. Live sessions that have no transcript are added after that page.";

const GET_DESCRIPTION = "Read one local coding session. Returns recent tail turns and a short extractive summary. card.pending carries the question, permission request, or notification text the hooks reported, as in list_sessions. The stuck line is session is running, a tool error, a tool call with no result, or waiting on a reply. The first match wins.";

const SEND_DESCRIPTION = `Send a follow-up for a local coding session. Requires confirm set to true. mode defaults to queue. When no live process owns the session and no channel listener is bound, queue spawns the local claude CLI in the session directory. When a live process owns it, or a channel listener accepts, queue hands the message to that listener and does not resume. With no listener the result is undelivered and nothing is stored for a later resume. A listener that rejects the frame returns rejected and does not resume. steer returns unsupported and does not signal a live process. Optional attachments are inline base64 or a path under ~/.claude-remote/inbox. Copies land in ~/.claude-remote/attachments only when a delivery will actually happen, and the prompt names those paths. File bytes are not logged. Does not pass a permission-bypass flag. ${DESKTOP_NOTICE}`;

const QUEUE_DESCRIPTION = "Show follow-up tickets for one session. Tickets do not include the message text. Set deliver to true and confirm to true to resume queued tickets once this server is the only writer. A live process leaves them queued.";

const CONTINUE_DESCRIPTION = "Return the shell command that continues this session in a terminal. The command is text and this tool does not run it. The id is the transcript UUID. cwd is shell-quoted. A linked worktree uses the same directory a resume spawn would use. The command includes --dangerously-load-development-channels server:claude-remote-channel so a later send can reach that terminal. That flag bypasses the channel allowlist. If a live process owns the session, warning is set and liveOwner is desktop, terminal, or unknown. Stop that process before running the command.";

const RENAME_DESCRIPTION = "Report that no documented route sets a session title through this server. This does not edit transcript files.";

export const RENAME_MESSAGE = "/rename is an interactive command. It is also accepted as a -p prompt on Claude Code v2.1.205 or later. A channel notification is event text, not that command. claude -n sets a name only when the process starts. claude-remote does not edit transcript files.";

export async function listSessions(
  config: Config,
  input: { project?: string; limit?: number },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
  agents: AgentsLoader = defaultAgentsLoader(config),
): Promise<ListResult> {
  const started = Date.now();
  try {
    const limit = input.limit ?? 50;
    const candidates = await discoverTranscripts(config.configRoot, config.home);
    const scannedFileCount = candidates.length;
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const page = candidates.slice(0, limit);
    const registry = await loadSessionRegistry(config.configRoot, config.home, identity);
    const cmdlines = await lister();
    const snapshot = await agents();
    const desktop = await loadDesktopIndex(await resolveDesktopRoot(config), config.home);
    const cards: SessionCard[] = [];
    const built = await mapLimited(page, 6, async (candidate) => {
      const facts = await readTranscript(candidate.filePath, candidate.sessionId, candidate.projectSlug, candidate.mtimeMs);
      const runState = classifyRunState({
        registry,
        sessionId: candidate.sessionId,
        cmdlines,
        tail: tailFlag(facts.end, facts.incomplete),
      });
      const meta = desktop.get(candidate.sessionId);
      const subs = await listSubSessions(config.configRoot, candidate.filePath, candidate.sessionId, config.home);
      const card = buildCard(facts, meta, runState, liveOwnerFor(registry, candidate.sessionId, cmdlines, runState), {
        status: statusFor(snapshot, registry, candidate.sessionId, runState),
        process: processFor(registry, candidate.sessionId, runState),
        subSessions: subs.slice(0, LIST_SUB_ROWS),
        subSessionCount: subs.length,
      });
      return decorateCard(config, card);
    });
    for (const card of built) {
      if (matchesProject(card, input.project)) cards.push(attachPending(card));
    }
    const known = new Set(candidates.map((candidate) => candidate.sessionId));
    const extras = await unwrittenCards(config, known, lister, identity, snapshot);
    extras.sort(byActivity);
    for (const extra of extras) {
      if (matchesProject(extra, input.project)) cards.push(attachPending(extra));
    }
    logEvent({ tool: "list_sessions", durationMs: Date.now() - started, evidence: snapshot.available ? "agents-json" : `agents-${snapshot.reason}` });
    return { sessions: cards, scannedFileCount, pagedBy: "mtime" };
  } catch (error) {
    if (error instanceof DeskError) logEvent({ tool: "list_sessions", durationMs: Date.now() - started, code: error.code });
    throw error;
  }
}

export async function getSession(
  config: Config,
  input: { sessionId: string },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
  agents: AgentsLoader = defaultAgentsLoader(config),
): Promise<SessionDetail> {
  const started = Date.now();
  let safeId: string | undefined;
  try {
    const id = parseSessionId(input.sessionId);
    if (!id) throw new DeskError("not-uuid", "session id must be a UUID");
    safeId = id;
    let filePath: string | null = null;
    try {
      filePath = await resolveSessionFile(config.configRoot, id, config.home);
    } catch (error) {
      if (!(error instanceof DeskError) || error.code !== "not-found") throw error;
    }
    if (!filePath) {
      const card = await oneUnwritten(config, id, lister, identity, await agents());
      if (!card) throw new DeskError("not-found", "session not found");
      logEvent({
        tool: "get_session",
        sessionId: id,
        durationMs: Date.now() - started,
        evidence: runStateEvidence(card.runState),
      });
      return { card: attachPending(card), turns: [], summary: { did: "", stuck: null, coverage: "full" }, lastReply: "" };
    }
    const info = await stat(filePath);
    const facts = await readTranscript(filePath, id, path.basename(path.dirname(filePath)), info.mtimeMs);
    const registry = await loadSessionRegistry(config.configRoot, config.home, identity);
    const cmdlines = await lister();
    const runState = classifyRunState({
      registry,
      sessionId: id,
      cmdlines,
      tail: tailFlag(facts.end, facts.incomplete),
    });
    const desktop = await loadDesktopIndex(await resolveDesktopRoot(config), config.home);
    const meta = desktop.get(id);
    const snapshot = await agents();
    const status = statusFor(snapshot, registry, id, runState);
    const subs = await listSubSessions(config.configRoot, filePath, id, config.home);
    const card = await decorateCard(config, buildCard(facts, meta, runState, liveOwnerFor(registry, id, cmdlines, runState), {
      status,
      process: processFor(registry, id, runState),
      subSessions: subs,
      subSessionCount: subs.length,
    }));
    logEvent({
      tool: "get_session",
      sessionId: id,
      durationMs: Date.now() - started,
      evidence: runStateEvidence(runState),
    });
    return { card: attachPending(card), turns: facts.turns, summary: summarize(facts, runState, status), lastReply: facts.lastReply };
  } catch (error) {
    if (error instanceof DeskError) {
      logEvent({ tool: "get_session", sessionId: safeId, durationMs: Date.now() - started, code: error.code });
    }
    throw error;
  }
}

export async function sendFollowup(
  config: Config,
  input: { sessionId: string; message: string; confirm: unknown; mode?: FollowupMode; attachments?: unknown },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<FollowupOutcome> {
  const started = Date.now();
  let safeId: string | undefined;
  let staged: StagedBundle | null = null;
  try {
    if (!config.allowSend) throw new DeskError("send-disabled", "send is disabled");
    if (input.confirm !== true) throw new DeskError("confirm-required", "confirm must be true");
    if (input.message.length < 1 || input.message.length > 100000) {
      throw new DeskError("invalid-message", "message length must be from 1 to 100000");
    }
    const mode = normalizeMode(input.mode);
    const id = parseSessionId(input.sessionId);
    if (!id) throw new DeskError("not-uuid", "session id must be a UUID");
    safeId = id;
    let filePath: string | null = null;
    try {
      filePath = await resolveSessionFile(config.configRoot, id, config.home);
    } catch (error) {
      if (!(error instanceof DeskError) || error.code !== "not-found") throw error;
    }
    if (!filePath) return sendUnwritten(config, id, input, started, mode, lister, identity);
    const info = await stat(filePath);
    await sweepAttachments(config.home, config.attachmentTtlMs, Date.now());
    if (mode === "steer") {
      logEvent({ tool: "send_followup", sessionId: id, durationMs: Date.now() - started, code: "unsupported" });
      return {
        disposition: "unsupported",
        sessionId: id,
        code: "unsupported",
        displayedInDesktop: false,
        notice: STEER_NOTICE,
      };
    }
    const facts = await readTranscript(filePath, id, path.basename(path.dirname(filePath)), info.mtimeMs);
    const runState = await currentRunState(config, id, facts, lister, identity);
    const alone = soleWriterAllowed(runState);
    const bound = await channelListenerBound(config.home, id);
    const reason = blockReason(runState);
    if (!alone && !bound) return undelivered(id, reason, started);
    if (!bound) {
      if (!facts.projectPath) throw new DeskError("missing-cwd", "session directory does not exist");
      await resolveSpawnCwd(facts.projectPath, config.home);
    }
    staged = await stageAttachments(config, id, input.message, input.attachments);
    const message = staged?.message ?? input.message;
    try {
      const offered = await offerIfListening(config, id, message, alone, reason, started, staged);
      if (offered) {
        if (offered.disposition !== "handed" && staged) await removeStaged(config.home, id, staged.ticketId);
        return offered;
      }
      if (!facts.projectPath) throw new DeskError("missing-cwd", "session directory does not exist");
      const projectPath = facts.projectPath;
      await resolveSpawnCwd(projectPath, config.home);
      const ticket = await enqueueTicket(config.home, id, message, staged?.ticketId);
      const outcome = await deliverIfAlone(config, id, projectPath, facts, lister, identity);
      return finishSend(id, ticket.ticketId, outcome, started, staged);
    } catch (error) {
      if (staged) await removeStaged(config.home, id, staged.ticketId);
      throw error;
    }
  } catch (error) {
    if (error instanceof DeskError) {
      logEvent({
        tool: "send_followup",
        sessionId: safeId,
        durationMs: Date.now() - started,
        code: error.code,
        ...attachmentFields(staged),
      });
    }
    throw error;
  }
}

export async function continueCommand(
  config: Config,
  input: { sessionId: string },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<ContinueCommandResult> {
  const started = Date.now();
  let safeId: string | undefined;
  try {
    const id = parseSessionId(input.sessionId);
    if (!id) throw new DeskError("not-uuid", "session id must be a UUID");
    safeId = id;
    let filePath: string | null = null;
    try {
      filePath = await resolveSessionFile(config.configRoot, id, config.home);
    } catch (error) {
      if (!(error instanceof DeskError) || error.code !== "not-found") throw error;
    }
    if (!filePath) {
      const card = await oneUnwritten(config, id, lister, identity, NO_AGENTS);
      if (!card?.cwd) throw new DeskError(card ? "missing-cwd" : "not-found", card ? "session directory does not exist" : "session not found");
      const spawnAt = await commandDirectory(card.cwd, config.home);
      logEvent({
        tool: "continue_command",
        sessionId: id,
        durationMs: Date.now() - started,
        evidence: card.liveOwner,
      });
      return {
        sessionId: id,
        command: continueCommandLine(config.claudeBin, spawnAt.cwd, id),
        cwd: spawnAt.cwd,
        worktreeLaunch: spawnAt.worktreeLaunch,
        liveOwner: card.liveOwner,
        warning: card.warning,
      };
    }
    const info = await stat(filePath);
    const facts = await readTranscript(filePath, id, path.basename(path.dirname(filePath)), info.mtimeMs);
    const desktop = await loadDesktopIndex(await resolveDesktopRoot(config), config.home);
    const meta = desktop.get(id);
    const recorded = recordedWorkingFolder(meta, facts.projectPath);
    if (!recorded) throw new DeskError("missing-cwd", "session directory does not exist");
    const spawnAt = await commandDirectory(recorded, config.home);
    const registry = await loadSessionRegistry(config.configRoot, config.home, identity);
    const cmdlines = await lister();
    const runState = classifyRunState({
      registry,
      sessionId: id,
      cmdlines,
      tail: tailFlag(facts.end, facts.incomplete),
    });
    const owner = liveOwnerFor(registry, id, cmdlines, runState);
    const command = continueCommandLine(config.claudeBin, spawnAt.cwd, id);
    logEvent({
      tool: "continue_command",
      sessionId: id,
      durationMs: Date.now() - started,
      evidence: owner,
    });
    return {
      sessionId: id,
      command,
      cwd: spawnAt.cwd,
      worktreeLaunch: spawnAt.worktreeLaunch,
      liveOwner: owner,
      warning: liveWriterWarning(owner),
    };
  } catch (error) {
    if (error instanceof DeskError) {
      logEvent({ tool: "continue_command", sessionId: safeId, durationMs: Date.now() - started, code: error.code });
    }
    throw error;
  }
}

export async function queueStatus(
  config: Config,
  input: { sessionId: string; deliver?: boolean; confirm?: unknown },
  lister: CommandLister = listCmdlines,
  identity: ProcessIdentityLookup = processIdentity,
): Promise<QueueStatusResult> {
  const started = Date.now();
  let safeId: string | undefined;
  try {
    if (!config.allowSend) throw new DeskError("send-disabled", "send is disabled");
    const id = parseSessionId(input.sessionId);
    if (!id) throw new DeskError("not-uuid", "session id must be a UUID");
    safeId = id;
    const filePath = await resolveSessionFile(config.configRoot, id, config.home);
    const info = await stat(filePath);
    if (input.deliver !== true) {
      const tickets = await listTicketViews(config.home, id);
      logEvent({ tool: "queue_status", sessionId: id, durationMs: Date.now() - started });
      return { sessionId: id, tickets, delivered: [], blocked: false, reason: null };
    }
    if (input.confirm !== true) throw new DeskError("confirm-required", "confirm must be true");
    const facts = await readTranscript(filePath, id, path.basename(path.dirname(filePath)), info.mtimeMs);
    if (!facts.projectPath) throw new DeskError("missing-cwd", "session directory does not exist");
    await resolveSpawnCwd(facts.projectPath, config.home);
    const outcome = await deliverIfAlone(config, id, facts.projectPath, facts, lister, identity);
    const tickets = await listTicketViews(config.home, id);
    logEvent({
      tool: "queue_status",
      sessionId: id,
      durationMs: Date.now() - started,
      code: outcome.blocked ? "busy" : (outcome.reason ?? undefined),
    });
    return {
      sessionId: id,
      tickets,
      delivered: outcome.blocked
        ? []
        : outcome.delivered.map((item) => ({ ticketId: item.ticketId, exitCode: item.exitCode, state: "sent" as const })),
      blocked: outcome.blocked,
      reason: outcome.blocked ? "busy" : outcome.reason,
    };
  } catch (error) {
    if (error instanceof DeskError) {
      logEvent({ tool: "queue_status", sessionId: safeId, durationMs: Date.now() - started, code: error.code });
    }
    throw error;
  }
}

export function registerTools(server: McpServer, config: Config): void {
  server.registerTool(
    "list_sessions",
    {
      description: LIST_DESCRIPTION,
      inputSchema: z.object({
        project: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    },
    async (args) => {
      try {
        const result = await listSessions(config, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "get_session",
    {
      description: GET_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
      }),
    },
    async (args) => {
      try {
        const result = await getSession(config, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "continue_command",
    {
      description: CONTINUE_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
      }),
    },
    async (args) => {
      try {
        const result = await continueCommand(config, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "rename_session",
    {
      description: RENAME_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
        title: z.string().min(1).max(200),
      }),
    },
    async () => toolError(new DeskError("no-documented-route", RENAME_MESSAGE)),
  );
  server.registerTool(
    "cleanup_desk",
    {
      description: "Delete channel socket and token files that are not accepting connections, and delete expired attachment directories. Does not delete key files.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const cleaned = await cleanupDesk(config);
        return { content: [{ type: "text", text: JSON.stringify(cleaned) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  if (!config.allowSend) return;
  server.registerTool(
    "send_followup",
    {
      description: SEND_DESCRIPTION,
      inputSchema: sendFollowupSchema,
    },
    async (args) => {
      try {
        const result = await sendFollowup(config, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    "queue_status",
    {
      description: QUEUE_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
        deliver: z.boolean().optional(),
        confirm: z.boolean().optional(),
      }),
    },
    async (args) => {
      try {
        const result = await queueStatus(config, args);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

export const sendFollowupSchema = z.object({
  sessionId: z.string(),
  message: z.string().min(1).max(100000),
  confirm: z.literal(true),
  mode: z.enum(["queue", "steer"]).optional(),
  attachments: z.array(z.union([
    z.object({
      filename: z.string().min(1).max(80),
      mimeType: z.string().min(1).max(200),
      data: z.string().min(1).max(ATTACHMENT_DATA_MAX_CHARS),
    }).strict(),
    z.object({
      path: z.string().min(1).max(4096),
    }).strict(),
  ])).max(MAX_ATTACHMENTS).optional(),
});

type StagedBundle = {
  ticketId: string;
  message: string;
  views: StagedAttachmentView[];
  count: number;
  bytes: number;
  types: string;
};

async function stageAttachments(
  config: Config,
  sessionId: string,
  message: string,
  raw: unknown,
): Promise<StagedBundle | null> {
  const prepared = await prepareAttachments(config.home, raw, {
    maxBytes: config.attachmentMaxBytes,
    maxTotalBytes: config.attachmentMaxTotalBytes,
  }, config.configRoot);
  if (prepared.length === 0) return null;
  const ticketId = randomUUID();
  const views = await writeStaged(config.home, sessionId, ticketId, prepared);
  const composed = composePrompt(message, views);
  if (composed.length > 100000) {
    await removeStaged(config.home, sessionId, ticketId);
    throw new DeskError("invalid-message", "message length must be from 1 to 100000");
  }
  return {
    ticketId,
    message: composed,
    views,
    count: views.length,
    bytes: views.reduce((sum, view) => sum + view.bytes, 0),
    types: [...new Set(views.map((view) => view.mediaType))].sort().join(","),
  };
}

function attachmentFields(staged: StagedBundle | null): Pick<LogEvent, "attachmentCount" | "attachmentBytes" | "attachmentTypes"> {
  if (!staged) return {};
  return {
    attachmentCount: staged.count,
    attachmentBytes: staged.bytes,
    attachmentTypes: staged.types,
  };
}

function normalizeMode(mode: FollowupMode | undefined): FollowupMode {
  if (mode == null) return "queue";
  switch (mode) {
    case "queue":
    case "steer":
      return mode;
    default: {
      const _never: never = mode;
      return assertNever(_never);
    }
  }
}

async function offerIfListening(
  config: Config,
  id: string,
  message: string,
  alone: boolean,
  reason: QueueReason | null,
  started: number,
  staged: StagedBundle | null,
): Promise<FollowupOutcome | null> {
  const bound = await channelListenerBound(config.home, id);
  if (!bound) {
    if (alone) return null;
    return undelivered(id, reason, started, staged);
  }
  const offer = await offerChannel(listenerSocket(config.home, id), message, id, CHANNEL_OFFER_MS);
  if (offer.accepted) {
    const offerId = randomUUID();
    const observedStatus = await observedSessionStatus(config, id);
    logEvent({
      tool: "send_followup",
      sessionId: id,
      durationMs: Date.now() - started,
      code: "handed",
      ...attachmentFields(staged),
    });
    const handed: FollowupOutcome = {
      disposition: "handed",
      sessionId: id,
      offerId,
      observedStatus,
      displayedInDesktop: false,
      notice: HANDED_NOTICE,
    };
    if (staged && staged.views.length > 0 && handed.disposition === "handed") handed.attachments = staged.views;
    return handed;
  }
  if (offer.code === "auth" || offer.code === "session" || offer.code === "malformed") {
    return rejected(id, offer.code, started, staged);
  }
  if (!alone || await channelListenerLive(config.home, id, CHANNEL_OFFER_MS)) {
    return undelivered(id, reason ?? "running", started, staged);
  }
  return null;
}

/**
 * The mapped status of a session that just took a channel frame: the claude agents --json entry
 * when there is one, otherwise the sessions/<pid>.json token mapped the same way.
 */
async function observedSessionStatus(config: Config, id: string): Promise<SessionStatus["value"] | null> {
  const snapshot = await defaultAgentsLoader(config)();
  if (snapshot.available) {
    const entry = snapshot.bySession.get(id);
    if (entry) return statusFromEntry(entry).value;
  }
  return statusFromToken(await observedRegistryStatus(config.configRoot, config.home, id));
}

function undelivered(id: string, reason: QueueReason | null, started: number, staged: StagedBundle | null = null): FollowupOutcome {
  logEvent({
    tool: "send_followup",
    sessionId: id,
    durationMs: Date.now() - started,
    code: "no-listener",
    evidence: reason ?? undefined,
    ...attachmentFields(staged),
  });
  return {
    disposition: "undelivered",
    sessionId: id,
    code: "no-listener",
    displayedInDesktop: false,
    notice: UNDELIVERED_NOTICE,
  };
}

function rejected(id: string, code: "auth" | "session" | "malformed", started: number, staged: StagedBundle | null = null): FollowupOutcome {
  logEvent({
    tool: "send_followup",
    sessionId: id,
    durationMs: Date.now() - started,
    code,
    ...attachmentFields(staged),
  });
  return {
    disposition: "rejected",
    sessionId: id,
    code,
    displayedInDesktop: false,
    notice: REJECTED_NOTICE,
  };
}

async function deliverIfAlone(
  config: Config,
  id: string,
  projectPath: string,
  facts: { end: TailEnd; incomplete: boolean },
  lister: CommandLister,
  identity: ProcessIdentityLookup,
): Promise<DeliverResult> {
  return deliverQueue({
    home: config.home,
    sessionId: id,
    refresh: async () => {
      const runState = await currentRunState(config, id, facts, lister, identity);
      if (!soleWriterAllowed(runState)) return { allowed: false, reason: blockReason(runState) };
      if (await channelListenerLive(config.home, id, CHANNEL_OFFER_MS)) {
        return { allowed: false, reason: "running" };
      }
      return { allowed: true, reason: null };
    },
    send: async (message, onChild) => {
      const spawnAt = await resolveSpawnCwd(projectPath, config.home);
      const invocation = followupInvocation(id, message);
      const spawned = await spawnClaude({
        bin: config.claudeBin,
        args: invocation.args,
        stdin: invocation.stdin,
        cwd: spawnAt.cwd,
        timeoutMs: config.sendTimeoutMs,
        redact: message,
        onChild,
        env: await claudeChildEnv(config),
      });
      return {
        result: spawned.result,
        exitCode: spawned.exitCode,
        sessionId: spawned.sessionId,
        worktreeLaunch: spawnAt.worktreeLaunch,
      };
    },
  });
}

async function currentRunState(
  config: Config,
  id: string,
  facts: { end: TailEnd; incomplete: boolean },
  lister: CommandLister,
  identity: ProcessIdentityLookup,
) {
  const registry = await loadSessionRegistry(config.configRoot, config.home, identity);
  const cmdlines = await lister();
  return classifyRunState({
    registry,
    sessionId: id,
    cmdlines,
    tail: tailFlag(facts.end, facts.incomplete),
  });
}

function finishSend(
  id: string,
  ticketId: string,
  outcome: DeliverResult,
  started: number,
  staged: StagedBundle | null,
): FollowupOutcome {
  if (!outcome.blocked) {
    const mine = outcome.delivered.find((item) => item.ticketId === ticketId);
    if (mine) {
      logEvent({
        tool: "send_followup",
        sessionId: id,
        ticketId,
        durationMs: Date.now() - started,
        exitCode: mine.exitCode,
        ...attachmentFields(staged),
      });
      const sent: FollowupOutcome = {
        disposition: "sent",
        result: mine.result,
        exitCode: mine.exitCode,
        sessionId: mine.sessionId,
        displayedInDesktop: false,
        notice: DESKTOP_NOTICE,
        worktreeLaunch: mine.worktreeLaunch,
        ticketId,
      };
      if (staged && staged.views.length > 0 && sent.disposition === "sent") sent.attachments = staged.views;
      return sent;
    }
  }
  const reason: QueueReason = outcome.blocked ? "busy" : (outcome.reason ?? "running");
  logEvent({
    tool: "send_followup",
    sessionId: id,
    ticketId,
    durationMs: Date.now() - started,
    code: "queued",
    evidence: reason,
    ...attachmentFields(staged),
  });
  const queued: FollowupOutcome = {
    disposition: "queued",
    ticketId,
    sessionId: id,
    reason,
    displayedInDesktop: false,
    notice: QUEUE_NOTICE,
  };
  if (staged && staged.views.length > 0 && queued.disposition === "queued") queued.attachments = staged.views;
  return queued;
}

async function decorateCard(config: Config, card: SessionCard): Promise<SessionCard> {
  let command: string | null = null;
  if (card.cwd) {
    const spawnAt = await commandDirectory(card.cwd, config.home);
    command = continueCommandLine(config.claudeBin, spawnAt.cwd, card.sessionId);
  }
  return { ...card, command, warning: liveWriterWarning(card.liveOwner) };
}

async function unwrittenCards(
  config: Config,
  known: Set<string>,
  lister: CommandLister,
  identity: ProcessIdentityLookup,
  snapshot: AgentsSnapshot,
): Promise<SessionCard[]> {
  const records = await loadLiveRecords(config.configRoot, config.home, identity);
  const cmdlines = await lister();
  const sockets = await liveSocketIds(config.home, CHANNEL_OFFER_MS);
  const launches = await readLaunches(config.home);
  const cards: SessionCard[] = [];
  const seen = new Set<string>(known);
  for (const record of records) {
    if (seen.has(record.sessionId)) continue;
    seen.add(record.sessionId);
    cards.push(await decorateCard(config, registryCard(record, cmdlines, snapshot)));
  }
  for (const raw of sockets) {
    const id = parseSessionId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cards.push(await decorateCard(config, socketCard(id, launches, cmdlines, snapshot)));
  }
  return cards;
}

const NO_AGENTS: AgentsSnapshot = { available: false, reason: "disabled" };

async function oneUnwritten(
  config: Config,
  id: string,
  lister: CommandLister,
  identity: ProcessIdentityLookup,
  snapshot: AgentsSnapshot,
): Promise<SessionCard | null> {
  const cards = await unwrittenCards(config, new Set(), lister, identity, snapshot);
  return cards.find((card) => card.sessionId === id) ?? null;
}

async function sendUnwritten(
  config: Config,
  id: string,
  input: { message: string; attachments?: unknown },
  started: number,
  mode: FollowupMode,
  lister: CommandLister,
  identity: ProcessIdentityLookup,
): Promise<FollowupOutcome> {
  const card = await oneUnwritten(config, id, lister, identity, NO_AGENTS);
  if (!card) throw new DeskError("not-found", "session not found");
  if (mode === "steer") {
    logEvent({ tool: "send_followup", sessionId: id, durationMs: Date.now() - started, code: "unsupported" });
    return {
      disposition: "unsupported",
      sessionId: id,
      code: "unsupported",
      displayedInDesktop: false,
      notice: STEER_NOTICE,
    };
  }
  const bound = await channelListenerBound(config.home, id);
  if (!bound) return undelivered(id, "running", started);
  await sweepAttachments(config.home, config.attachmentTtlMs, Date.now());
  const staged = await stageAttachments(config, id, input.message, input.attachments);
  const message = staged?.message ?? input.message;
  try {
    const offered = await offerIfListening(config, id, message, false, "running", started, staged);
    if (offered) {
      if (offered.disposition !== "handed" && staged) await removeStaged(config.home, id, staged.ticketId);
      return offered;
    }
    if (staged) await removeStaged(config.home, id, staged.ticketId);
    return undelivered(id, "running", started);
  } catch (error) {
    if (staged) await removeStaged(config.home, id, staged.ticketId);
    throw error;
  }
}

function registryCard(record: LiveRecord, cmdlines: readonly string[], snapshot: AgentsSnapshot): SessionCard {
  const runState: SessionCard["runState"] = { kind: "running", evidence: "sessions-file" };
  return blankCard({
    sessionId: record.sessionId,
    cwd: record.cwd,
    lastActivity: record.mtimeMs > 0 ? new Date(record.mtimeMs).toISOString() : null,
    runState,
    status: resolveStatus({ snapshot, sessionId: record.sessionId, runState, registryToken: record.status }),
    process: record.process,
    liveOwner: classifyLiveOwner({
      runState,
      sessionId: record.sessionId,
      registryOwner: record.entrypoint,
      cmdlines,
    }),
  });
}

function socketCard(
  id: SessionCard["sessionId"],
  launches: readonly LaunchRecord[],
  cmdlines: readonly string[],
  snapshot: AgentsSnapshot,
): SessionCard {
  const cwd = launchCwd(launches, id);
  const runState: SessionCard["runState"] = { kind: "running", evidence: "process-argv" };
  const started = launches.find((record) => record.sessionId === id)?.startedAt ?? null;
  return blankCard({
    sessionId: id,
    cwd,
    lastActivity: started,
    runState,
    status: resolveStatus({ snapshot, sessionId: id, runState, registryToken: null }),
    process: null,
    liveOwner: classifyLiveOwner({
      runState,
      sessionId: id,
      registryOwner: undefined,
      cmdlines,
    }),
  });
}

function launchCwd(launches: readonly LaunchRecord[], id: string): string | null {
  for (let i = launches.length - 1; i >= 0; i -= 1) {
    const record = launches[i];
    if (!record || record.sessionId !== id) continue;
    const cwd = record.cwd.trim();
    if (cwd.length === 0 || cwd.includes(".key") || cwd.includes("\0")) continue;
    return cwd;
  }
  return null;
}

function blankCard(input: {
  sessionId: SessionCard["sessionId"];
  cwd: string | null;
  lastActivity: string | null;
  runState: SessionCard["runState"];
  status: SessionStatus;
  process: ProcessDetailsView | null;
  liveOwner: LiveOwner;
}): SessionCard {
  return {
    sessionId: input.sessionId,
    desktopSessionId: null,
    inDesktopSidebar: false,
    projectName: projectNameOf(input.cwd),
    projectPath: input.cwd,
    cwd: input.cwd,
    title: null,
    liveOwner: input.liveOwner,
    branch: null,
    worktreePath: null,
    lastActivity: input.lastActivity,
    runState: input.runState,
    messageCount: 0,
    command: null,
    warning: null,
    status: input.status,
    process: input.process,
    subSessions: [],
    subSessionCount: 0,
  };
}

function projectNameOf(cwd: string | null): string {
  if (!cwd) return "unknown";
  const base = path.basename(cwd);
  return base.length > 0 ? base : "unknown";
}

function buildCard(
  facts: TranscriptFacts,
  meta: DesktopMeta | undefined,
  runState: SessionCard["runState"],
  liveOwner: LiveOwner,
  extra: {
    status: SessionStatus;
    process: ProcessDetailsView | null;
    subSessions: SubSessionRow[];
    subSessionCount: number;
  },
): SessionCard {
  return {
    sessionId: facts.sessionId,
    desktopSessionId: meta?.desktopSessionId ?? null,
    inDesktopSidebar: meta != null,
    projectName: facts.projectName,
    projectPath: facts.projectPath,
    cwd: recordedWorkingFolder(meta, facts.projectPath),
    title: sessionTitle(meta, facts.title),
    liveOwner,
    branch: facts.branch ?? meta?.branch ?? null,
    worktreePath: meta?.worktreePath ?? null,
    lastActivity: facts.lastActivity,
    runState,
    messageCount: facts.messageCount,
    command: null,
    warning: null,
    ...extra,
  };
}

function statusFor(
  snapshot: AgentsSnapshot,
  registry: SessionRegistry,
  sessionId: string,
  runState: SessionCard["runState"],
): SessionStatus {
  const registryToken = registry.status === "checked" ? (registry.tokens?.[sessionId] ?? null) : null;
  return resolveStatus({ snapshot, sessionId, runState, registryToken });
}

function processFor(registry: SessionRegistry, sessionId: string, runState: SessionCard["runState"]): ProcessDetailsView | null {
  if (runState.kind !== "running" || registry.status !== "checked") return null;
  return registry.details?.[sessionId] ?? null;
}

function liveOwnerFor(
  registry: SessionRegistry,
  sessionId: string,
  cmdlines: readonly string[],
  runState: SessionCard["runState"],
): LiveOwner {
  const registryOwner = registry.status === "checked" ? registry.owners[sessionId] : undefined;
  return classifyLiveOwner({ runState, sessionId, registryOwner, cmdlines });
}

async function commandDirectory(
  recorded: string,
  home: string,
): Promise<{ cwd: string; worktreeLaunch: WorktreeLaunch | null }> {
  if (skipsFolderProbe(recorded, home)) return { cwd: recorded, worktreeLaunch: null };
  try {
    return await resolveSpawnCwd(recorded, home);
  } catch (error) {
    if (error instanceof DeskError && error.code === "missing-cwd") return { cwd: recorded, worktreeLaunch: null };
    throw error;
  }
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0 || limit < 1) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await run(item);
    }
  }));
  return results;
}

function matchesProject(card: SessionCard, project: string | undefined): boolean {
  if (!project) return true;
  if (card.projectName === project) return true;
  if (card.projectPath != null && card.projectPath.includes(project)) return true;
  return card.cwd != null && card.cwd.includes(project);
}

function byActivity(a: SessionCard, b: SessionCard): number {
  if (a.lastActivity === b.lastActivity) return 0;
  if (a.lastActivity == null) return 1;
  if (b.lastActivity == null) return -1;
  return Date.parse(b.lastActivity) - Date.parse(a.lastActivity);
}

function toolError(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
  const text = error instanceof DeskError ? error.message : "unexpected failure";
  return { isError: true, content: [{ type: "text", text }] };
}
