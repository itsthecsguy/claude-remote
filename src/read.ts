import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionId, SummaryCoverage, TailEnd, Turn, TurnFacts, TurnStep } from "./domain.js";

const WINDOW = 65536;
const MAX_LINE = 1024 * 1024;
const PREFIX = 200;
const TURN_TEXT = 500;
const MAX_TURNS = 20;
const MAX_STEPS = 15;
const STEP_TEXT = 200;
const REPLY_MAX = 8000;
/** The text Claude Code records when a turn needed no answer. It is never the reply a reader wants. */
export const FILLER_REPLY = "No response requested.";
const END_REASONS: ReadonlySet<unknown> = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"]);

export type TranscriptFacts = {
  sessionId: SessionId;
  projectName: string;
  projectPath: string | null;
  title: string | null;
  branch: string | null;
  lastActivity: string | null;
  messageCount: number;
  lastReply: string;
  turns: Turn[];
  coverage: SummaryCoverage;
  end: TailEnd;
  incomplete: boolean;
  did: string;
  turn: TurnFacts | null;
};

type Raw = Record<string, unknown>;

export async function readTranscript(
  filePath: string,
  sessionId: SessionId,
  projectSlug: string,
  mtimeMs: number,
): Promise<TranscriptFacts> {
  const fileStat = await stat(filePath);
  const headWindow = await readWindow(filePath, fileStat.size, "head");
  const tail = await readWindow(filePath, fileStat.size, "tail");
  const streamed = await streamFacts(filePath);
  const head = parseRecords(headWindow.text);
  const tailRecords = parseRecords(tail.text);
  const projectPath = lastString(tailRecords, "cwd") ?? firstString(head, "cwd");
  const branch = lastString(tailRecords, "gitBranch") ?? firstString(head, "gitBranch");
  const title = pickTitle(head, tailRecords);
  const counted = tailRecords.filter(isMessageRecord);
  // The turns come from the whole-file scan. A 64 KB tail of a current transcript often holds
  // two or three message records, because tool results and bookkeeping records fill it.
  const turns = streamed.turns;
  const end = walkEnd(counted);
  const coverage = parentCoverage(counted);
  const lastActivity = streamed.maxTimestamp ?? new Date(mtimeMs).toISOString();
  return {
    sessionId,
    projectName: projectPath ? path.basename(projectPath) || projectSlug : projectSlug,
    projectPath,
    title,
    branch,
    lastActivity,
    messageCount: streamed.messageCount,
    lastReply: streamed.lastReply,
    turns,
    coverage,
    end,
    incomplete: tail.incomplete,
    did: didText(turns, streamed.turn),
    turn: streamed.turn,
  };
}

function pickTitle(head: Raw[], tail: Raw[]): string | null {
  return lastString(tail, "customTitle")
    ?? lastString(head, "customTitle")
    ?? lastString(tail, "aiTitle")
    ?? lastString(head, "aiTitle")
    ?? lastString(tail, "lastPrompt")
    ?? lastString(tail, "summary")
    ?? firstUserPrompt(head);
}

function firstUserPrompt(records: Raw[]): string | null {
  for (const rec of records) {
    if (rec.type !== "user" || rec.isMeta === true || rec.isSidechain === true) continue;
    const text = textOf(rec.message).trim();
    if (text) return text;
  }
  return null;
}

function didText(turns: readonly Turn[], turn: TurnFacts | null): string {
  let last = "";
  const tools: string[] = [];
  for (const item of turns) {
    for (const name of item.toolNames) {
      if (!tools.includes(name)) tools.push(name);
    }
    if (item.role === "assistant" && item.text.trim() && item.text.trim() !== FILLER_REPLY) last = item.text.trim();
  }
  if (!last) last = (turn?.reply ?? turn?.narration ?? "").slice(0, TURN_TEXT);
  if (last && tools.length > 0) return `${last} Tools: ${tools.join(", ")}.`;
  if (last) return last;
  if (tools.length > 0) return `Tools: ${tools.join(", ")}.`;
  return "";
}

function walkEnd(records: Raw[]): TailEnd {
  let end: TailEnd = { kind: "closed" };
  for (const rec of records) {
    if (rec.type === "user") {
      const results = toolResultsOf(rec.message);
      const text = textOf(rec.message).trim();
      const last = results[results.length - 1];
      if (last) {
        end = last.isError ? { kind: "tool-error", text: last.text.slice(0, 200) } : { kind: "closed" };
      } else if (text) {
        end = { kind: "user-prompt" };
      }
    } else if (rec.type === "assistant") {
      const names = toolNamesOf(rec.message);
      const text = textOf(rec.message).trim();
      if (names.length > 0) end = { kind: "tool-open" };
      else if (text) end = { kind: "closed" };
    }
  }
  return end;
}

function parentCoverage(records: Raw[]): SummaryCoverage {
  const ids = new Set<string>();
  for (const rec of records) {
    if (typeof rec.uuid === "string") ids.add(rec.uuid);
  }
  for (const rec of records) {
    if (typeof rec.parentUuid === "string" && rec.parentUuid.length > 0 && !ids.has(rec.parentUuid)) {
      return "tail";
    }
  }
  return "full";
}

function toTurn(rec: Raw): Turn {
  const role = rec.type === "assistant" ? "assistant" : "user";
  return {
    role,
    text: textOf(rec.message).slice(0, TURN_TEXT),
    toolNames: toolNamesOf(rec.message),
  };
}

function isMessageRecord(rec: Raw): boolean {
  if (rec.type !== "user" && rec.type !== "assistant") return false;
  if (rec.isSidechain === true || rec.isMeta === true) return false;
  return true;
}

function textOf(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown; content?: unknown };
    if (typed.type !== "text" && typed.type !== "output_text") continue;
    if (typeof typed.text === "string") parts.push(typed.text);
    else if (typeof typed.content === "string") parts.push(typed.content);
  }
  return parts.join("\n");
}

function jsonObject(text: string): boolean {
  if (text.length === 0) return false;
  try {
    const value: unknown = JSON.parse(text);
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  } catch {
    return false;
  }
}

function toolNamesOf(message: unknown): string[] {
  const blocks = blocksOf(message);
  const names: string[] = [];
  for (const block of blocks) {
    if (block.type === "tool_use" && typeof block.name === "string") names.push(block.name);
  }
  return names;
}

function toolResultsOf(message: unknown): { isError: boolean; text: string; id: string | null }[] {
  const blocks = blocksOf(message);
  const results: { isError: boolean; text: string; id: string | null }[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    results.push({
      isError: block.is_error === true,
      text: blockText(block.content),
      id: typeof block.tool_use_id === "string" ? block.tool_use_id : null,
    });
  }
  return results;
}

function blocksOf(message: unknown): Record<string, unknown>[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object");
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
  }
  return parts.join("\n");
}

function lastString(records: Raw[], key: string): string | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const value = records[i]?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function firstString(records: Raw[], key: string): string | null {
  for (const rec of records) {
    const value = rec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function parseRecords(text: string): Raw[] {
  const records: Raw[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const parsed = tryParse(line);
    if (parsed) records.push(parsed);
  }
  return records;
}

function tryParse(line: string): Raw | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Raw;
  } catch {
    return null;
  }
}

async function streamFacts(filePath: string): Promise<{ messageCount: number; maxTimestamp: string | null; lastReply: string; turns: Turn[]; turn: TurnFacts | null }> {
  let messageCount = 0;
  let lastReply = "";
  let maxTimestamp: string | null = null;
  let maxMs = Number.NEGATIVE_INFINITY;
  const turns: Turn[] = [];
  const tracker = new TurnTracker();
  await scanLines(filePath, (line) => {
    if (line.oversized) {
      const flags = flagsFromPrefix(line.text);
      if ((flags.type === "user" || flags.type === "assistant") && !flags.sidechain && !flags.meta) {
        messageCount += 1;
      }
      return;
    }
    const rec = tryParse(line.text);
    if (!rec) return;
    if (isMessageRecord(rec)) {
      messageCount += 1;
      tracker.add(rec);
      const turn = toTurn(rec);
      if (turn.text.length > 0 || turn.toolNames.length > 0) {
        turns.push(turn);
        if (turns.length > MAX_TURNS) turns.shift();
      }
    }
    if (rec.type === "assistant" && rec.isSidechain !== true && rec.isMeta !== true) {
      const text = textOf(rec.message).trim();
      if (text && text !== FILLER_REPLY) lastReply = text;
    }
    if (typeof rec.timestamp === "string") {
      const ms = Date.parse(rec.timestamp);
      if (!Number.isNaN(ms) && ms >= maxMs) {
        maxMs = ms;
        maxTimestamp = rec.timestamp;
      }
    }
  });
  return { messageCount, maxTimestamp, lastReply, turns, turn: tracker.finish() };
}

type Building = {
  prompt: string;
  startedAt: string | null;
  lastActivity: string | null;
  reply: string | null;
  explicitEnd: boolean;
  narration: string | null;
  toolCalls: number;
  toolErrors: number;
  steps: TurnStep[];
  open: Map<string, TurnStep>;
  replied: boolean;
};

/**
 * Follows the newest prompt through the file: its tool calls paired with their results, the text
 * written between them, and the final reply. A turn whose whole answer is the filler reply is
 * dropped in favour of the turn before it, so a notification that needed no answer does not hide
 * the result of the work.
 */
class TurnTracker {
  private current: Building | null = null;
  private previous: Building | null = null;

  add(rec: Raw): void {
    const stamp = typeof rec.timestamp === "string" ? rec.timestamp : null;
    if (rec.type === "user") {
      const results = toolResultsOf(rec.message);
      if (results.length > 0) {
        const turn = this.ensure(stamp);
        for (const result of results) {
          if (result.isError) turn.toolErrors += 1;
          const step = result.id ? turn.open.get(result.id) : undefined;
          if (!step) continue;
          step.outcome = result.isError ? "error" : "ok";
          step.result = clip(result.text, STEP_TEXT);
          if (result.id) turn.open.delete(result.id);
        }
        turn.replied = false;
        turn.lastActivity = stamp ?? turn.lastActivity;
        return;
      }
      const text = textOf(rec.message).trim();
      if (!text) return;
      if (this.current && !isFiller(this.current)) this.previous = this.current;
      this.current = blankTurn(text.slice(0, TURN_TEXT), stamp);
      return;
    }
    if (rec.type !== "assistant") return;
    const message = rec.message as { stop_reason?: unknown } | undefined;
    const calls = toolCallsOf(rec.message);
    const text = textOf(rec.message).trim();
    if (calls.length === 0 && !text) return;
    const turn = this.ensure(stamp);
    turn.lastActivity = stamp ?? turn.lastActivity;
    for (const call of calls) {
      const step: TurnStep = { tool: call.name, input: call.input, outcome: "running", result: "" };
      turn.toolCalls += 1;
      turn.steps.push(step);
      if (turn.steps.length > MAX_STEPS) turn.steps.shift();
      if (call.id) turn.open.set(call.id, step);
    }
    if (calls.length > 0 || message?.stop_reason === "tool_use") {
      if (text) turn.narration = text.slice(0, TURN_TEXT);
      turn.reply = null;
      turn.replied = false;
      return;
    }
    turn.reply = text;
    turn.explicitEnd = END_REASONS.has(message?.stop_reason);
    turn.replied = true;
  }

  finish(): TurnFacts | null {
    const pick = this.current && isFiller(this.current) && this.previous ? this.previous : this.current;
    if (!pick) return null;
    const reply = pick.replied ? pick.reply : null;
    return {
      state: pick.replied ? "replied" : "in-progress",
      explicitEnd: pick.replied && pick.explicitEnd,
      prompt: pick.prompt,
      startedAt: pick.startedAt,
      lastActivity: pick.lastActivity,
      reply: reply == null ? null : reply.slice(0, REPLY_MAX),
      replyTruncated: reply != null && reply.length > REPLY_MAX,
      narration: pick.narration,
      toolCalls: pick.toolCalls,
      toolErrors: pick.toolErrors,
      openTools: [...pick.open.values()].map((step) => step.tool),
      steps: pick.steps,
    };
  }

  private ensure(stamp: string | null): Building {
    if (!this.current) this.current = blankTurn("", stamp);
    return this.current;
  }
}

function blankTurn(prompt: string, stamp: string | null): Building {
  return {
    prompt,
    startedAt: stamp,
    lastActivity: stamp,
    reply: null,
    explicitEnd: false,
    narration: null,
    toolCalls: 0,
    toolErrors: 0,
    steps: [],
    open: new Map(),
    replied: false,
  };
}

function isFiller(turn: Building): boolean {
  return turn.replied && turn.toolCalls === 0 && turn.reply === FILLER_REPLY;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const INPUT_KEYS = ["command", "file_path", "path", "notebook_path", "pattern", "url", "query", "skill", "description", "prompt"] as const;

/** The one argument that says what a tool call does: the command, the file, the pattern. */
function inputSummary(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "";
  const fields = input as Record<string, unknown>;
  for (const key of INPUT_KEYS) {
    const value = fields[key];
    if (typeof value === "string" && value.length > 0) return clip(value, STEP_TEXT);
  }
  const names = Object.keys(fields).slice(0, 6).join(", ");
  return names ? `(${names})` : "";
}

function toolCallsOf(message: unknown): { id: string | null; name: string; input: string }[] {
  const calls: { id: string | null; name: string; input: string }[] = [];
  for (const block of blocksOf(message)) {
    if (block.type !== "tool_use" || typeof block.name !== "string") continue;
    calls.push({ id: typeof block.id === "string" ? block.id : null, name: block.name, input: inputSummary(block.input) });
  }
  return calls;
}

function flagsFromPrefix(prefix: string): { type: string | null; sidechain: boolean; meta: boolean } {
  const type = /"type"\s*:\s*"([^"]+)"/.exec(prefix)?.[1] ?? null;
  return {
    type,
    sidechain: /"isSidechain"\s*:\s*true/.test(prefix),
    meta: /"isMeta"\s*:\s*true/.test(prefix),
  };
}

function findByte(buffer: Buffer, byte: number, start: number, end: number): number {
  for (let i = start; i < end; i += 1) {
    if (buffer[i] === byte) return i;
  }
  return -1;
}

type LineEvent = { text: string; oversized: boolean };

export async function scanLines(filePath: string, onLine: (line: LineEvent) => void | Promise<void>): Promise<void> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(WINDOW);
    let acc: Buffer[] = [];
    let accLen = 0;
    let oversized = false;
    let prefix = Buffer.alloc(0);
    const emit = async (): Promise<void> => {
      if (oversized) await onLine({ text: prefix.toString("utf8"), oversized: true });
      else await onLine({ text: Buffer.concat(acc).toString("utf8"), oversized: false });
    };
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      let offset = 0;
      while (offset < bytesRead) {
        const nl = findByte(buf, 0x0a, offset, bytesRead);
        const end = nl === -1 ? bytesRead : nl;
        const piece = buf.subarray(offset, end);
        if (!oversized) {
          if (accLen + piece.length > MAX_LINE) {
            oversized = true;
            const kept = Buffer.concat([...acc, piece]);
            prefix = kept.subarray(0, PREFIX);
            acc = [];
            accLen = 0;
          } else if (piece.length > 0) {
            acc.push(Buffer.from(piece));
            accLen += piece.length;
          }
        } else if (prefix.length < PREFIX && piece.length > 0) {
          const need = PREFIX - prefix.length;
          prefix = Buffer.concat([prefix, piece.subarray(0, need)]);
        }
        if (nl === -1) {
          offset = bytesRead;
        } else {
          await emit();
          oversized = false;
          prefix = Buffer.alloc(0);
          acc = [];
          accLen = 0;
          offset = nl + 1;
        }
      }
    }
    if (oversized || accLen > 0) await emit();
  } finally {
    await fh.close();
  }
}

async function readWindow(
  filePath: string,
  size: number,
  which: "head" | "tail",
): Promise<{ text: string; incomplete: boolean }> {
  const fh = await open(filePath, "r");
  try {
    const len = Math.min(WINDOW, size);
    const start = which === "head" ? 0 : size - len;
    const buf = Buffer.alloc(len);
    if (len > 0) await fh.read(buf, 0, len, start);
    let text = buf.toString("utf8");
    const incomplete = size > 0 && buf[buf.length - 1] !== 0x0a;
    if (which === "tail" && start > 0) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1);
    }
    if (which === "head" && size > WINDOW) {
      const nl = text.lastIndexOf("\n");
      text = nl === -1 ? "" : text.slice(0, nl + 1);
    }
    if (incomplete) {
      const nl = text.lastIndexOf("\n");
      const head = nl === -1 ? "" : text.slice(0, nl + 1);
      const rest = nl === -1 ? text : text.slice(nl + 1);
      text = jsonObject(rest) ? `${head}${rest}` : head;
    }
    return { text, incomplete: which === "tail" ? incomplete : false };
  } finally {
    await fh.close();
  }
}
