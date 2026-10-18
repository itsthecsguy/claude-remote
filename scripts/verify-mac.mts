import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { offerChannel, serveChannel } from "../src/channel.js";
import { allowSessionRecord, discoverTranscripts, sessionRecordName } from "../src/paths.js";
import { sessionRecordKeys } from "../src/registry.js";
import { loadDesktopIndex, resolveDesktopRoot } from "../src/desktop.js";
import { DeskError, assertNever } from "../src/domain.js";
import { followupInvocation } from "../src/followup.js";
import { parseConfig } from "../src/config.js";
import { runStateEvidence } from "../src/running.js";
import { listSessions, queueStatus, sendFollowup } from "../src/tools.js";

const config = parseConfig(process.env);
const executeAt = process.argv.indexOf("--execute");
const messageAt = process.argv.indexOf("--message");
const deliverAt = process.argv.indexOf("--deliver");
const loopback = process.argv.includes("--loopback");
const steer = process.argv.includes("--steer");
const executeId = executeAt >= 0 ? process.argv[executeAt + 1] : undefined;
const message = messageAt >= 0 ? process.argv[messageAt + 1] : undefined;
const deliverId = deliverAt >= 0 ? process.argv[deliverAt + 1] : undefined;

console.log("Claude Code 2.1.293 stores sessions/<pid>.json. The JSON sessionId matched the running transcript id. A sibling <pid>.<hash>.key file is not opened. This is an internal format and it can change. The lines below print JSON key names only.");
console.log("Read-only unless CLAUDE_REMOTE_ALLOW_SEND=1. --execute <sessionId> --message <text> sends when no live process owns the session and no channel listener is running. A live process is handed to the channel listener that session spawned and is not resumed. No listener prints undelivered. --steer asks for an interrupt. --deliver <sessionId> resumes tickets already on disk once no channel listener and no other claude process is writing that session. --loopback checks the channel frame on this machine and does not touch a session. Use a throwaway session. Do not paste transcript text.");

if (loopback && (deliverAt >= 0 || executeAt >= 0)) {
  console.error("Pass --loopback on its own.");
  process.exit(2);
}
if (loopback) {
  const dir = await mkdtemp(path.join(tmpdir(), "cr-loop-"));
  const socketPath = path.join(dir, "listener.sock");
  const server = await serveChannel(socketPath);
  let accepted = false;
  try {
    const offer = await offerChannel(socketPath, "loopback", "loopback", 1000);
    accepted = offer.accepted && server.received.length === 1 && server.received[0] === "loopback";
    console.log(`loopback accepted=${accepted}`);
  } finally {
    await server.close();
  }
  process.exit(accepted ? 0 : 1);
}

const candidates = await discoverTranscripts(config.configRoot, config.home);
const listed = await listSessions(config, { limit: 200 });
console.log(`transcripts=${candidates.length} shown=${listed.sessions.length} scanned=${listed.scannedFileCount} pagedBy=${listed.pagedBy}`);
for (const session of listed.sessions) {
  const title = (session.title ?? "").replace(/\s+/g, " ").slice(0, 80);
  console.log(`session=${session.sessionId} project=${session.projectName} cwd=${session.cwd ?? ""} liveOwner=${session.liveOwner} title=${title} run=${session.runState.kind} evidence=${runStateEvidence(session.runState)} messages=${session.messageCount}`);
}

const sessionsDir = path.join(config.configRoot, "sessions");
let sessionNames: string[];
try {
  sessionNames = await readdir(sessionsDir);
} catch (error) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  console.log(code === "ENOENT" ? "sessions/ missing" : "sessions/ unreadable");
  sessionNames = [];
}
if (sessionNames.length > 0) console.log(`sessions/ count=${sessionNames.length}`);
for (const name of sessionNames) {
  const kind = sessionRecordName(name);
  switch (kind) {
    case "key":
      console.log("sessions/ unread=key");
      break;
    case "other":
      console.log(`sessions/ file=${name} unread=${kind}`);
      break;
    case "pid-json": {
      let real: string;
      try {
        real = await allowSessionRecord(config.configRoot, path.join(sessionsDir, name), config.home);
      } catch {
        console.log(`sessions/ file=${name} unread=denied`);
        break;
      }
      const keys = await sessionRecordKeys(real);
      console.log(`sessions/ file=${name} keys=${keys ? keys.join(",") : "unreadable"}`);
      break;
    }
    default: {
      const _never: never = kind;
      assertNever(_never);
    }
  }
}

const desktopRoot = await resolveDesktopRoot(config);
const desktop = await loadDesktopIndex(desktopRoot, config.home);
const known = new Set<string>(candidates.map((candidate) => candidate.sessionId));
let matched = 0;
for (const id of desktop.keys()) {
  if (known.has(id)) matched += 1;
}
console.log(`desktopRoot=${desktopRoot ?? "none"} localJson=${desktop.size} cliSessionIdsMatchingTranscripts=${matched}`);

const sample = listed.sessions[0];
if (sample) {
  const invocation = followupInvocation(sample.sessionId, "<message>");
  console.log(`send argv not run: ${config.claudeBin} ${invocation.args.join(" ")}`);
} else {
  console.log("send argv not run: no session to show");
}

if (deliverAt >= 0 && executeAt >= 0) {
  console.error("Pass either --deliver or --execute, not both.");
  process.exit(2);
}
if (deliverAt >= 0) {
  if (!deliverId || deliverId.startsWith("--")) {
    console.error("Pass --deliver <sessionId>.");
    process.exit(2);
  }
  if (!config.allowSend) {
    console.error("CLAUDE_REMOTE_ALLOW_SEND is not 1. Refusing to send.");
    process.exit(2);
  }
  try {
    const status = await queueStatus(config, { sessionId: deliverId, deliver: true, confirm: true });
    console.log(`queue session=${status.sessionId} blocked=${status.blocked} reason=${status.reason ?? "none"}`);
    for (const ticket of status.tickets) {
      const exit = ticket.exitCode == null ? "none" : String(ticket.exitCode);
      console.log(`ticket id=${ticket.ticketId} state=${ticket.state} exit=${exit}`);
    }
  } catch (error) {
    if (error instanceof DeskError) {
      console.error(`deliver failed code=${error.code}`);
      process.exit(1);
    }
    console.error("deliver failed");
    process.exit(1);
  }
  process.exit(0);
}

if (executeAt < 0) process.exit(0);
if (!executeId || executeId.startsWith("--") || !message) {
  console.error("Pass --execute <sessionId> --message <text>. Use a throwaway session.");
  process.exit(2);
}
if (!config.allowSend) {
  console.error("CLAUDE_REMOTE_ALLOW_SEND is not 1. Refusing to send.");
  process.exit(2);
}
try {
  const result = await sendFollowup(config, {
    sessionId: executeId,
    message,
    confirm: true,
    mode: steer ? "steer" : "queue",
  });
  switch (result.disposition) {
    case "sent":
      console.log(`send disposition=sent exit=${result.exitCode} displayedInDesktop=${result.displayedInDesktop} worktreeLaunch=${result.worktreeLaunch} ticket=${result.ticketId}`);
      console.log(result.notice);
      console.log("Local result follows. Do not copy it into another session.");
      console.log(result.result);
      break;
    case "queued":
      console.log(`send disposition=queued ticket=${result.ticketId} reason=${result.reason} displayedInDesktop=${result.displayedInDesktop}`);
      console.log(result.notice);
      break;
    case "handed":
      console.log(`send disposition=handed offer=${result.offerId} displayedInDesktop=${result.displayedInDesktop} observedStatus=${result.observedStatus ?? "none"}`);
      console.log(result.notice);
      await printHeld(executeId);
      break;
    case "undelivered":
      console.log(`send disposition=undelivered code=${result.code} displayedInDesktop=${result.displayedInDesktop}`);
      console.log(result.notice);
      console.log("The open Code tab will not show this message.");
      await printHeld(executeId);
      break;
    case "rejected":
      console.log(`send disposition=rejected code=${result.code} displayedInDesktop=${result.displayedInDesktop}`);
      console.log(result.notice);
      await printHeld(executeId);
      break;
    case "unsupported":
      console.log(`send disposition=unsupported code=${result.code} displayedInDesktop=${result.displayedInDesktop}`);
      console.log(result.notice);
      break;
    default: {
      const _never: never = result;
      assertNever(_never);
    }
  }
} catch (error) {
  if (error instanceof DeskError) {
    console.error(`send failed code=${error.code}`);
    process.exit(1);
  }
  console.error("send failed");
  process.exit(1);
}

async function printHeld(sessionId: string): Promise<void> {
  const status = await queueStatus(config, { sessionId });
  console.log(`held tickets not resumed count=${status.tickets.length}`);
  for (const ticket of status.tickets) {
    console.log(`ticket id=${ticket.ticketId} state=${ticket.state}`);
  }
}
