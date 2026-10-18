import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RunState, SessionRegistry, TailEnd } from "./domain.js";
import { assertNever } from "./domain.js";

const execFileAsync = promisify(execFile);

export type TailFlag = "closed" | "open";

export function tailFlag(end: TailEnd, incomplete: boolean): TailFlag {
  if (incomplete) return "open";
  switch (end.kind) {
    case "user-prompt":
    case "tool-open":
      return "open";
    case "closed":
    case "tool-error":
      return "closed";
    default: {
      const _never: never = end;
      return assertNever(_never);
    }
  }
}

export function classifyRunState(input: {
  registry: SessionRegistry;
  sessionId: string;
  cmdlines: readonly string[];
  tail: TailFlag;
}): RunState {
  const id = input.sessionId.toLowerCase();
  switch (input.registry.status) {
    case "unreadable":
      return { kind: "unknown", reason: "sessions-dir-unreadable" };
    case "missing":
      break;
    case "checked":
      if (input.registry.live.some((sessionId) => sessionId === id)) {
        return { kind: "running", evidence: "sessions-file" };
      }
      if (input.registry.unverified.some((sessionId) => sessionId === id)) {
        return { kind: "unknown", reason: "sessions-file-unverified" };
      }
      break;
    default: {
      const _never: never = input.registry;
      return assertNever(_never);
    }
  }
  if (input.cmdlines.some((line) => line.toLowerCase().includes(id) && isClaudeProgram(line, id))) {
    return { kind: "running", evidence: "process-argv" };
  }
  if (input.tail === "open") return { kind: "unknown", reason: "tail-open" };
  return { kind: "finished" };
}

const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);

function baseName(value: string): string {
  const parts = value.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

function isClaudePath(program: string): boolean {
  const base = baseName(program);
  if (base === "claude" || base === "claude.exe") return true;
  return /[\\/]claude[\\/]versions[\\/][^\\/]+$/.test(program);
}

function isClaudeScript(script: string): boolean {
  if (isClaudePath(script)) return true;
  return baseName(script) === "cli.js" && /[\\/]@anthropic-ai[\\/]claude-code[\\/]cli\.js$/.test(script);
}

/**
 * The program a ps command line runs. ps joins argv with spaces and does not quote, so an
 * absolute program path that contains spaces is rebuilt one word at a time. Extension stops
 * at a flag or at the session id, so arguments after the program are never read as its path.
 */
function programCandidates(words: readonly string[], id: string): string[] {
  const first = words[0];
  if (!first) return [];
  const candidates = [first];
  if (!first.startsWith("/")) return candidates;
  let joined = first;
  for (const word of words.slice(1)) {
    if (word.startsWith("-") || (id.length > 0 && word.toLowerCase().includes(id))) break;
    joined = `${joined} ${word}`;
    candidates.push(joined);
  }
  return candidates;
}

/**
 * True only when the program itself is the claude CLI: an executable named claude (or a
 * native install under claude/versions/<version>), or node/bun running a script named claude
 * or the Claude Code package cli.js. A path, folder, or argument that merely contains the
 * word claude does not count.
 */
export function isClaudeProgram(line: string, sessionId = ""): boolean {
  const id = sessionId.toLowerCase();
  const words = line.trim().split(/\s+/).filter((word) => word.length > 0);
  const programs = programCandidates(words, id);
  if (programs.some(isClaudePath)) return true;
  if (!INTERPRETERS.has(baseName(words[0] ?? ""))) return false;
  const script = words.slice(1).find((word) => !word.startsWith("-"));
  return script !== undefined && isClaudeScript(script);
}

/**
 * Parse `ps -ax -o pid=,command=` output and drop the excluded pids (this process and its
 * parent), so the tool never reads its own command line as a live session.
 */
export function cmdlinesFromPs(stdout: string, exclude: ReadonlySet<number>): string[] {
  const lines: string[] = [];
  for (const raw of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(raw);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2] ?? "";
    if (exclude.has(pid) || command.length === 0) continue;
    lines.push(command);
  }
  return lines;
}

export async function listCmdlines(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("ps", ["-ax", "-o", "pid=,command="], {
      timeout: 2000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return cmdlinesFromPs(stdout, new Set([process.pid, process.ppid]));
  } catch {
    return [];
  }
}

export function runStateEvidence(state: RunState): string {
  switch (state.kind) {
    case "running":
      return state.evidence;
    case "finished":
      return "finished";
    case "unknown":
      return state.reason;
    default: {
      const _never: never = state;
      return assertNever(_never);
    }
  }
}
