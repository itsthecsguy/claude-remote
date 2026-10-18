import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VID } from "../fixtures/ids.js";
import { initialize, startServer, toolNames, type RpcMessage } from "./stdio-client.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureRoot = path.join(repoRoot, "fixtures", "home");
const desktopRoot = path.join(repoRoot, "fixtures", "desktop");
const shimPath = path.join(repoRoot, "scripts", "fake-claude.mjs");
const spawnCwd = "/tmp/fixture/demo-app";
const proofMessage = "proof-ping";
const lines: string[] = [];

const base = {
  CLAUDE_CONFIG_DIR: fixtureRoot,
  CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
  CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
};

const off = startServer({ ...base, CLAUDE_REMOTE_ALLOW_SEND: "0" });
let stderr = "";
try {
  const init = await initialize(off);
  const info = serverInfo(init);
  lines.push(`initialize allowSend=0 status=ok server=${info.name} version=${info.version}`);
  const listed = await off.request("tools/list", {}, 2);
  lines.push(`tools/list allowSend=0 status=ok tools=${toolNames(listed).join(",")}`);
  stderr += off.stderr();
} finally {
  off.close();
}

const proofHome = await mkdtemp(path.join(tmpdir(), "claude-remote-proof-"));
const on = startServer({ ...base, CLAUDE_REMOTE_ALLOW_SEND: "1", HOME: proofHome });
try {
  const init = await initialize(on);
  const info = serverInfo(init);
  lines.push(`initialize allowSend=1 status=ok server=${info.name} version=${info.version}`);
  const listed = await on.request("tools/list", {}, 2);
  lines.push(`tools/list allowSend=1 status=ok tools=${toolNames(listed).join(",")}`);
  const sessions = await on.request("tools/call", { name: "list_sessions", arguments: { limit: 50 } }, 3);
  const sessionPayload = payload(sessions) as { sessions?: { sessionId?: string }[]; scannedFileCount?: number; pagedBy?: string };
  const ids = (sessionPayload.sessions ?? []).map((session) => session.sessionId).join(",");
  lines.push(`list_sessions status=ok scanned=${sessionPayload.scannedFileCount} page=${sessionPayload.sessions?.length ?? 0} pagedBy=${sessionPayload.pagedBy} ids=${ids}`);
  const detail = await on.request("tools/call", { name: "get_session", arguments: { sessionId: VID } }, 4);
  const detailPayload = payload(detail) as { summary?: { coverage?: string; stuck?: string | null }; card?: { runState?: { kind?: string } } };
  lines.push(`get_session status=ok session=${VID} coverage=${detailPayload.summary?.coverage} run=${detailPayload.card?.runState?.kind} stuck=${detailPayload.summary?.stuck ?? "null"}`);
  await mkdir(spawnCwd, { recursive: true });
  const sent = await on.request("tools/call", {
    name: "send_followup",
    arguments: { sessionId: VID, message: proofMessage, confirm: true },
  }, 5);
  const sentPayload = payload(sent) as { exitCode?: number; displayedInDesktop?: boolean; worktreeLaunch?: string; sessionId?: string | null };
  const record = JSON.parse(await readFile(path.join(spawnCwd, "fake-claude-record.json"), "utf8")) as { argv: string[]; stdin: string; cwd: string };
  const known = new Set(["-p", "--resume", VID, "--output-format", "stream-json", "--verbose"]);
  const argv = record.argv.map((arg) => known.has(arg) ? arg : "<redacted>").join(" ");
  lines.push(`send_followup status=ok exit=${sentPayload.exitCode} displayedInDesktop=${sentPayload.displayedInDesktop} worktreeLaunch=${sentPayload.worktreeLaunch} session=${sentPayload.sessionId} cwd=${record.cwd} stdinBytes=${Buffer.byteLength(record.stdin)} argv=${argv}`);
  const continued = await on.request("tools/call", { name: "continue_command", arguments: { sessionId: VID } }, 6);
  const continuedPayload = payload(continued) as {
    command?: string;
    liveOwner?: string;
    warning?: string | null;
    sessionId?: string;
  };
  const command = continuedPayload.command ?? "";
  if (command.includes("local_")) throw new Error("continue command used a desktop id");
  if (command.includes(proofMessage) || command.includes("Audio")) throw new Error("continue command included transcript text");
  lines.push(`continue_command status=ok session=${continuedPayload.sessionId} liveOwner=${continuedPayload.liveOwner} warning=${continuedPayload.warning ?? "none"} localId=absent`);
  stderr += on.stderr();
} finally {
  on.close();
}

lines.push("server stderr:");
lines.push(stderr.trim());
const text = `${lines.join("\n")}\n`;
const leaks = ["Tighten the audio lead-in", "Shortened the lead-in", "proof-ping", "Audio lead-in", "meta command"];
for (const leak of leaks) {
  if (text.includes(leak)) throw new Error(`proof log would include ${leak}`);
}
const logPath = path.join(repoRoot, "docs", "proof", "run.log");
await mkdir(path.dirname(logPath), { recursive: true });
await writeFile(logPath, text);
process.stdout.write(`wrote ${logPath}\n`);

function serverInfo(message: RpcMessage): { name: string; version: string } {
  const result = message.result;
  if (!result || typeof result !== "object") return { name: "", version: "" };
  const info = (result as { serverInfo?: { name?: string; version?: string } }).serverInfo;
  return { name: info?.name ?? "", version: info?.version ?? "" };
}

function payload(message: RpcMessage): unknown {
  const result = message.result;
  if (!result || typeof result !== "object") throw new Error("missing tool result");
  const typed = result as { isError?: boolean; content?: { text?: string }[] };
  const text = typed.content?.[0]?.text ?? "";
  if (typed.isError) throw new Error(text);
  return JSON.parse(text) as unknown;
}
