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
import { MAX_CALL_TIMEOUT_MS, type Config } from "./config.js";
import type { LiveOwner, ProcessDetailsView, SessionCard, SessionDetail, SessionRegistry, SessionStatus, SubSessionRow, TailEnd, WorktreeLaunch } from "./domain.js";
import { DeskError, assertNever } from "./domain.js";
import type { GitFacts, TurnFacts, WaitResult } from "./domain.js";
import { gitFacts } from "./gitfacts.js";
import { pendingStore } from "./pending.js";
import { runStore, sessionSignals } from "./runs.js";
import { loadDesktopIndex, recordedWorkingFolder, resolveDesktopRoot, sessionTitle, type DesktopMeta } from "./desktop.js";
import { DESKTOP_NOTICE, followupInvocation, resolveSpawnCwd, skipsFolderProbe, spawnClaude } from "./followup.js";
import { readLaunches, type LaunchRecord } from "./launches.js";
import { logEvent, type LogEvent } from "./log.js";
import { claudeChildEnv } from "./oauth.js";
import {
  QUEUE_NOTICE,
  STARTED_NOTICE,
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
import { phaseOf, summarize } from "./summary.js";
import { briefList, briefSend, briefSession, type BriefSession } from "./brief.js";
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

const LIST_DESCRIPTION = "List local Claude Code sessions, newest first: id, title, project, status (working, needs-you, idle, not-running, failed, stopped, unknown), branch, last activity, and the number of pending requests. limit defaults to 10. detail full returns every recorded field per row (cwd, run state, process, subagents, the continue command) and defaults to 50 rows.";

const GET_DESCRIPTION = "Read one session. phase is working, needs-input (answer what pending lists), done (reply is the final text), interrupted (the turn stopped with no final reply), failed, stopped, idle, or unknown. Also returns the title, the prompt, tool-call counts, pending requests, and git (branch, head, ahead, dirty, pushed) read at call time. To wait for a change, call wait_session. detail full adds the turn list, every step, the run record, and the session card.";

const SEND_DESCRIPTION = "Send a message to a session. confirm must be true. A closed session is resumed with the local claude CLI, outside the desktop app window: sent carries the result when the run ends within about 20 seconds, and started means it is still running or needs an answer, so call wait_session. A live session gets the message through its channel listener (handed); without one the result is queued, undelivered, or rejected with a reason, and nothing is resumed under a live process. mode steer is unsupported. attachments are inline base64 or a path under ~/.claude-remote/inbox. No permission-bypass flag is passed.";

const QUEUE_DESCRIPTION = "Show follow-up tickets for one session. Tickets do not include the message text. Set deliver to true and confirm to true to resume queued tickets once this server is the only writer. A live process leaves them queued.";

const CONTINUE_DESCRIPTION = "Return the shell command that continues this session in a terminal. The command is not run. warning is set when a live process owns the session; stop that process first.";

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
      const bare = attachPending(card);
      return {
        card: bare,
        turns: [],
        summary: { did: "", stuck: null, coverage: "full" },
        lastReply: "",
        phase: phaseOf({ status: bare.status, run: bare.runState, turn: null, pending: bare.pending, owned: await runStore.get(config.home, id), handoffAt: runStore.handoffAt(id) }),
        turn: null,
        run: await runStore.get(config.home, id),
        git: await gitFor(config, bare.cwd),
      };
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
    const withPending = attachPending(card);
    const owned = await runStore.get(config.home, id);
    return {
      card: withPending,
      turns: facts.turns,
      summary: summarize(facts, runState, status),
      lastReply: facts.lastReply,
      phase: phaseOf({ status, run: runState, turn: facts.turn, pending: withPending.pending, owned, handoffAt: runStore.handoffAt(id) }),
      turn: stepView(config, facts.turn),
      run: owned,
      git: await gitFor(config, withPending.worktreePath ?? withPending.cwd),
    };
  } catch (error) {
    if (error instanceof DeskError) {
      logEvent({ tool: "get_session", sessionId: safeId, durationMs: Date.now() - started, code: error.code });
    }
    throw error;
  }
}

export async function sendFollowup(
  config: Config,
  input: { sessionId: string; message: string; confirm: unknown; mode?: FollowupMode; attachments?: unknown; /** Wait for a resumed run to exit however long it takes, as the CLI does. */ waitForExit?: boolean },
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
      const delivery = deliverIfAlone(config, id, projectPath, facts, lister, identity);
      const outcome = input.waitForExit === true ? await delivery : await withinInline(delivery, config.sendInlineMs, id);
      if (outcome === STILL_RUNNING) {
        // The resume outlived the inline wait. It keeps running; the run store has its result when it ends.
        const held = staged;
        delivery.then(
          (late) => {
            const mine = late.blocked ? undefined : late.delivered.find((item) => item.ticketId === ticket.ticketId);
            logEvent({ tool: "send_followup", sessionId: id, ticketId: ticket.ticketId, durationMs: Date.now() - started, exitCode: mine?.exitCode, code: "late-end" });
          },
          async (error: unknown) => {
            if (held) await removeStaged(config.home, id, held.ticketId).catch(() => undefined);
            logEvent({ tool: "send_followup", sessionId: id, ticketId: ticket.ticketId, durationMs: Date.now() - started, code: error instanceof DeskError ? error.code : "error" });
          },
        );
        logEvent({ tool: "send_followup", sessionId: id, ticketId: ticket.ticketId, durationMs: Date.now() - started, code: "started", ...attachmentFields(staged) });
        const begun: FollowupOutcome = {
          disposition: "started",
          ticketId: ticket.ticketId,
          sessionId: id,
          displayedInDesktop: false,
          notice: STARTED_NOTICE,
        };
        if (staged && staged.views.length > 0 && begun.disposition === "started") begun.attachments = staged.views;
        return begun;
      }
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

const STILL_RUNNING = Symbol("still-running");

/**
 * The delivery if it settles within the inline wait, otherwise STILL_RUNNING. A rejection passes
 * through. A permission request or question from the resumed session ends the wait at once: the
 * caller is the one who has to answer it, and cannot while this call is still open.
 */
function withinInline<T>(delivery: Promise<T>, ms: number, sessionId: string): Promise<T | typeof STILL_RUNNING> {
  return new Promise((resolve, reject) => {
    const stop = (): void => {
      clearTimeout(timer);
      unsubscribe();
    };
    const timer = setTimeout(() => {
      stop();
      resolve(STILL_RUNNING);
    }, ms);
    const unsubscribe = pendingStore.subscribe((change) => {
      if (change.type !== "added" || change.view.sessionId !== sessionId || change.view.kind === "notification") return;
      stop();
      resolve(STILL_RUNNING);
    });
    delivery.then(
      (value) => {
        stop();
        resolve(value);
      },
      (error: unknown) => {
        stop();
        reject(error);
      },
    );
  });
}

/** Tool-result text leaves the machine only when CLAUDE_REMOTE_STEP_RESULTS=1. The outcome always does. */
function stepView(config: Config, turn: TurnFacts | null): TurnFacts | null {
  if (!turn || config.stepResults) return turn;
  return { ...turn, steps: turn.steps.map((step) => ({ ...step, result: "" })) };
}

async function gitFor(config: Config, cwd: string | null): Promise<GitFacts | null> {
  if (!cwd || skipsFolderProbe(cwd, config.home)) return null;
  return gitFacts(cwd);
}

const WAIT_POLL_MS = 2000;

const WAIT_DESCRIPTION = "Block until a session stops working or timeoutMs passes (default and maximum: the server wait limit, 25000 unless configured). Returns the same view as get_session without the title and prompt. timedOut true means it is still working: call again. Use it after new_session, after send_followup returns started or handed, and after an answer.";

/**
 * Long-poll one session. It re-reads the session when a hook event, a run exit, or a new prompt
 * arrives for it, and every two seconds otherwise, and returns as soon as phase is not working.
 */
export async function waitSession(
  config: Config,
  input: { sessionId: string; timeoutMs?: number },
  deps: { read?: (sessionId: string) => Promise<SessionDetail>; pollMs?: number; clock?: () => number } = {},
): Promise<WaitResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const id = parseSessionId(input.sessionId);
  if (!id) throw new DeskError("not-uuid", "session id must be a UUID");
  const read = deps.read ?? ((sessionId: string) => getSession(config, { sessionId }));
  const budget = Math.max(0, Math.min(input.timeoutMs ?? config.waitMaxMs, config.waitMaxMs));
  const deadline = started + budget;
  let woken = false;
  let wake: (() => void) | null = null;
  const poke = (sessionId: string): void => {
    if (sessionId.toLowerCase() !== id) return;
    woken = true;
    wake?.();
  };
  const stops = [
    sessionSignals.subscribe((signal) => poke(signal.sessionId)),
    pendingStore.subscribe((change) => poke(change.view.sessionId)),
  ];
  try {
    for (;;) {
      woken = false;
      const detail = await read(id);
      const now = clock();
      if (detail.phase.value !== "working" || now >= deadline) {
        const timedOut = detail.phase.value === "working";
        logEvent({ tool: "wait_session", sessionId: id, durationMs: now - started, code: timedOut ? "timeout" : detail.phase.value });
        return {
          sessionId: id,
          timedOut,
          waitedMs: now - started,
          phase: detail.phase,
          status: detail.card.status,
          turn: detail.turn,
          run: detail.run,
          pending: detail.card.pending ?? [],
          git: detail.git,
          next: nextStep(detail, timedOut),
        };
      }
      if (woken) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(deps.pollMs ?? WAIT_POLL_MS, deadline - now));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
  } finally {
    for (const stop of stops) stop();
  }
}

function nextStep(detail: SessionDetail, timedOut: boolean): string {
  if (timedOut) return "Still working. Call wait_session again.";
  switch (detail.phase.value) {
    case "needs-input":
      return (detail.card.pending ?? []).some((entry) => entry.answerable)
        ? "Answer pending with answer_permission or answer_question, then call wait_session again."
        : "The session is waiting for an answer that can only be given in the app or terminal on the machine.";
    case "done":
      return detail.run?.result ? "Finished. Read run.result.text, and check git if the task was to commit or push." : "Finished. Read turn.reply, and check git if the task was to commit or push.";
    case "failed":
      return "The run ended in an error. Read run.result, when there is one, and turn.steps for the cause.";
    case "interrupted":
      return "The turn stopped without a final reply. Read turn.steps for how far it got, then send_followup to continue.";
    case "stopped":
      return "The run was stopped. send_followup resumes the session.";
    case "idle":
      return "The session is idle with nothing to report. send_followup gives it work.";
    case "working":
    case "unknown":
      return "The state could not be determined. Read phase.reason, then try get_session.";
    default: {
      const _never: never = detail.phase.value;
      return assertNever(_never);
    }
  }
}

const DETAIL = z.enum(["brief", "full"]).optional();
const BRIEF_LIST_ROWS = 10;
/** Tools a remote caller does not need to run and watch sessions. CLAUDE_REMOTE_TOOLS=core leaves them out. */
const core = (config: Config): boolean => config.toolset === "core";

export function briefDetail(config: Config, detail: SessionDetail): BriefSession {
  return briefSession(
    { phase: detail.phase, turn: detail.turn, run: detail.run, git: detail.git, pending: detail.card.pending ?? [], title: detail.card.title, project: detail.card.projectName },
    { replyChars: config.replyChars, identity: true },
  );
}

export function briefWait(config: Config, result: WaitResult): BriefSession {
  return briefSession(result, { replyChars: config.replyChars, timedOut: result.timedOut });
}

const ANSWER_SETTLE_MS = 1000;

/**
 * What an answer tool does after it has answered, in brief mode: give the session a moment to pick
 * the answer up, then wait as wait_session does, so the caller needs no second call.
 */
export function answerFollow(config: Config): ((sessionId: string) => Promise<BriefSession>) | undefined {
  if (config.detail !== "brief") return undefined;
  return async (sessionId) => {
    await new Promise((resolve) => setTimeout(resolve, ANSWER_SETTLE_MS));
    const budget = Math.max(0, config.waitMaxMs - ANSWER_SETTLE_MS - 1000);
    return briefWait(config, await waitSession(config, { sessionId, timeoutMs: budget }));
  };
}

/**
 * What new_session does after a headless start, in brief mode: wait for the run inside the same
 * call. The transcript file can be a moment behind the init event, so a session that cannot be
 * read yet counts as still working.
 */
export function launchFollow(config: Config): ((sessionId: string, elapsedMs: number) => Promise<BriefSession>) | undefined {
  if (config.detail !== "brief") return undefined;
  return async (sessionId, elapsedMs) => {
    const deadline = Date.now() + Math.max(0, config.waitMaxMs - elapsedMs - 1000);
    for (;;) {
      try {
        return briefWait(config, await waitSession(config, { sessionId, timeoutMs: Math.max(0, deadline - Date.now()) }));
      } catch (error) {
        if (!(error instanceof DeskError) || error.code !== "not-found" || Date.now() + 500 >= deadline) {
          return { phase: "working", timedOut: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
}

export function registerTools(server: McpServer, config: Config): void {
  server.registerTool(
    "list_sessions",
    {
      description: LIST_DESCRIPTION,
      inputSchema: z.object({
        project: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        detail: DETAIL,
      }),
    },
    async (args) => {
      try {
        const brief = (args.detail ?? config.detail) === "brief";
        const result = await listSessions(config, { project: args.project, limit: args.limit ?? (brief ? BRIEF_LIST_ROWS : undefined) });
        return { content: [{ type: "text", text: JSON.stringify(brief ? briefList(result.sessions, result.scannedFileCount) : result) }] };
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
        detail: DETAIL,
      }),
    },
    async (args) => {
      try {
        const result = await getSession(config, { sessionId: args.sessionId });
        const brief = (args.detail ?? config.detail) === "brief";
        return { content: [{ type: "text", text: JSON.stringify(brief ? briefDetail(config, result) : result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  if (!core(config)) server.registerTool(
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
  if (!core(config)) server.registerTool(
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
  if (!core(config)) server.registerTool(
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
  server.registerTool(
    "wait_session",
    {
      description: WAIT_DESCRIPTION,
      inputSchema: z.object({
        sessionId: z.string(),
        timeoutMs: z.number().int().min(0).max(MAX_CALL_TIMEOUT_MS).optional(),
        detail: DETAIL,
      }),
    },
    async (args) => {
      try {
        const result = await waitSession(config, { sessionId: args.sessionId, timeoutMs: args.timeoutMs });
        const brief = (args.detail ?? config.detail) === "brief";
        return { content: [{ type: "text", text: JSON.stringify(brief ? briefWait(config, result) : result) }] };
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
        const view = config.detail === "brief" ? briefSend(result, args.sessionId, config.replyChars) : result;
        return { content: [{ type: "text", text: JSON.stringify(view) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );
  if (!core(config)) server.registerTool(
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
    runStore.noteHandoff(id);
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
      let spawned;
      try {
        spawned = await spawnClaude({
          bin: config.claudeBin,
          args: invocation.args,
          stdin: invocation.stdin,
          cwd: spawnAt.cwd,
          timeoutMs: config.sendTimeoutMs,
          redact: message,
          onChild: async (pid) => {
            await onChild(pid);
            await runStore.begin(config.home, id, "followup");
          },
          env: await claudeChildEnv(config),
        });
      } catch (error) {
        await runStore.end(config.home, id, null);
        throw error;
      }
      await runStore.end(config.home, id, spawned.exitCode, spawned.run);
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
