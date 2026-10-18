import { createServer, type Socket } from "node:net";
import { Readable, Writable } from "node:stream";
import {
  answerOffer,
  channelCapability,
  channelNotification,
  closeListener,
  ensureChannelDir,
  freshToken,
  channelDirectory,
  listenerSocket,
  openListener,
  readLineOn,
} from "./channel.js";
import { parseConfig } from "./config.js";
import { DeskError, type SessionId } from "./domain.js";
import { parseSessionId } from "./paths.js";
import { sessionRecordForPid } from "./registry.js";

// A channel that negotiates 2026-07-28 is not registered. Answer initialize with the last legacy revision.
export const PINNED_PROTOCOL_VERSION = "2025-11-25";
export const SKIPPED_PROTOCOL_VERSION = "2026-07-28";

const MAX_STDIO_BYTES = 1_000_000;

export type ChannelIo = {
  input: Readable;
  output: Writable;
  env: NodeJS.ProcessEnv;
  ppid: number;
  home: string;
};

export type ChannelHost = {
  sessionId: SessionId;
  socketPath: string;
  done: Promise<void>;
  close: () => Promise<void>;
};

export async function resolveChannelSessionId(input: {
  envSessionId: string | undefined;
  ppid: number;
  configRoot: string;
  home: string;
}): Promise<SessionId | null> {
  const fromEnv = input.envSessionId ? parseSessionId(input.envSessionId) : null;
  if (fromEnv) return fromEnv;
  const record = await sessionRecordForPid(input.configRoot, input.ppid, input.home);
  return record?.sessionId ?? null;
}

export async function startChannelHost(input: {
  io: ChannelIo;
  sessionId: SessionId;
}): Promise<ChannelHost> {
  const sessionId = input.sessionId;
  const socketPath = listenerSocket(input.io.home, sessionId);
  const token = freshToken();
  await ensureChannelDir(channelDirectory(input.io.home));
  let ready = false;
  const pending: string[] = [];
  const emit = (content: string) => {
    const line = `${JSON.stringify(channelNotification(content, { session_id: sessionId }))}\n`;
    if (!ready) {
      pending.push(line);
      return;
    }
    input.io.output.write(line);
  };
  const server = createServer((socket: Socket) => {
    readLineOn(socket, (line) => {
      answerOffer(socket, line, { token, sessionId }, emit);
    });
  });
  await openListener(server, socketPath, token);
  let settled = false;
  let finish = () => undefined as void;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  const stop = startStdio(input.io, {
    onReady: () => {
      ready = true;
      for (const line of pending) input.io.output.write(line);
      pending.length = 0;
    },
    onEnd: () => {
      void closeListener(server, socketPath).finally(finish);
    },
  });
  return {
    sessionId,
    socketPath,
    done,
    close: async () => {
      stop();
      await closeListener(server, socketPath).catch(() => undefined);
      finish();
      await done;
    },
  };
}

export async function runChannelMode(io: ChannelIo): Promise<number> {
  const config = parseConfig(io.env, { home: io.home });
  const sessionId = await resolveChannelSessionId({
    envSessionId: io.env.CLAUDE_CODE_SESSION_ID,
    ppid: io.ppid,
    configRoot: config.configRoot,
    home: io.home,
  });
  if (!sessionId) {
    console.error("claude-remote channel: session id unavailable");
    return 1;
  }
  try {
    const host = await startChannelHost({ io, sessionId });
    await host.done;
    return 0;
  } catch (error) {
    if (error instanceof DeskError) {
      console.error("claude-remote channel: refused");
      return 1;
    }
    console.error("claude-remote channel: unavailable");
    return 1;
  }
}

type StdioHooks = {
  onReady: () => void;
  onEnd: () => void;
};

function startStdio(io: ChannelIo, hooks: StdioHooks): () => void {
  let buf = "";
  let stopped = false;
  const take = (chunk: Buffer | string) => {
    if (stopped) return;
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (Buffer.byteLength(buf) > MAX_STDIO_BYTES) {
      buf = "";
      hooks.onEnd();
      return;
    }
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      handleLine(io.output, line, hooks);
      nl = buf.indexOf("\n");
    }
  };
  io.input.on("data", take);
  io.input.on("end", () => {
    if (!stopped) hooks.onEnd();
  });
  io.input.on("error", () => {
    if (!stopped) hooks.onEnd();
  });
  return () => {
    stopped = true;
    io.input.off("data", take);
  };
}

function handleLine(output: Writable, line: string, hooks: StdioHooks): void {
  if (line.trim().length === 0) return;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const method = typeof record.method === "string" ? record.method : "";
  const hasId = Object.prototype.hasOwnProperty.call(record, "id") && record.id !== null;
  if (!hasId) {
    if (method === "notifications/initialized") hooks.onReady();
    return;
  }
  switch (method) {
    case "initialize":
      writeMessage(output, {
        jsonrpc: "2.0",
        id: record.id,
        result: {
          protocolVersion: PINNED_PROTOCOL_VERSION,
          capabilities: channelCapability(),
          serverInfo: { name: "claude-remote-channel", version: "0.1.0" },
          instructions: "Follow-up text arrives as a channel event for this terminal session. Read it and act. This server has no reply tool.",
        },
      });
      return;
    case "ping":
      writeMessage(output, { jsonrpc: "2.0", id: record.id, result: {} });
      return;
    case "tools/list":
      writeMessage(output, { jsonrpc: "2.0", id: record.id, result: { tools: [] } });
      return;
    default:
      writeMessage(output, {
        jsonrpc: "2.0",
        id: record.id,
        error: { code: -32601, message: "Method not found" },
      });
  }
}

function writeMessage(output: Writable, message: unknown): void {
  output.write(`${JSON.stringify(message)}\n`);
}
