import { open, stat } from "node:fs/promises";
import path from "node:path";
import type { SessionId, SummaryCoverage, TailEnd, Turn } from "./domain.js";

const WINDOW = 65536;
const MAX_LINE = 1024 * 1024;
const PREFIX = 200;
const TURN_TEXT = 500;
const MAX_TURNS = 20;

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
  const turns = counted.slice(-MAX_TURNS).map(toTurn).filter((turn) => turn.text.length > 0 || turn.toolNames.length > 0);
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
    did: didText(counted),
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

function didText(records: Raw[]): string {
  let last = "";
  const tools: string[] = [];
  for (const rec of records) {
    for (const name of toolNamesOf(rec.message)) {
      if (!tools.includes(name)) tools.push(name);
    }
    if (rec.type !== "assistant") continue;
    const text = textOf(rec.message).trim();
    if (text) last = text.slice(0, TURN_TEXT);
  }
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

function toolResultsOf(message: unknown): { isError: boolean; text: string }[] {
  const blocks = blocksOf(message);
  const results: { isError: boolean; text: string }[] = [];
  for (const block of blocks) {
    if (block.type !== "tool_result") continue;
    results.push({ isError: block.is_error === true, text: blockText(block.content) });
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

async function streamFacts(filePath: string): Promise<{ messageCount: number; maxTimestamp: string | null; lastReply: string }> {
  let messageCount = 0;
  let lastReply = "";
  let maxTimestamp: string | null = null;
  let maxMs = Number.NEGATIVE_INFINITY;
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
    if ((rec.type === "user" || rec.type === "assistant") && rec.isSidechain !== true && rec.isMeta !== true) {
      messageCount += 1;
    }
    if (rec.type === "assistant" && rec.isSidechain !== true && rec.isMeta !== true) {
      const text = textOf(rec.message).trim();
      if (text) lastReply = text;
    }
    if (typeof rec.timestamp === "string") {
      const ms = Date.parse(rec.timestamp);
      if (!Number.isNaN(ms) && ms >= maxMs) {
        maxMs = ms;
        maxTimestamp = rec.timestamp;
      }
    }
  });
  return { messageCount, maxTimestamp, lastReply };
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
