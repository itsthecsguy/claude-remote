import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  isJsonContentType,
  isLegacyRequest,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { Config } from "./config.js";
import { DeskError } from "./domain.js";
import { registerLaunchTools } from "./launch.js";
import { logEvent } from "./log.js";
import { bearerMatches, readToken } from "./token.js";
import { registerTools } from "./tools.js";

export const HTTP_HOST = "127.0.0.1";
export const HTTP_PORT = 47321;
export const MCP_PATH = "/mcp";

const MAX_BODY = 4 * 1024 * 1024;

export type HttpListener = {
  port: number;
  close: () => Promise<void>;
};

export async function listenHttp(config: Config, port = HTTP_PORT): Promise<HttpListener> {
  if (port < 0 || port > 65535) throw new DeskError("usage", "port is not allowed");
  const modern = createMcpHandler(deskFactory(config), {
    legacy: "reject",
    responseMode: "json",
    onerror: () => {
      logEvent({ tool: "http", code: "handler" });
    },
  });
  const server = createServer((req, res) => {
    void onRequest(config, modern, req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HTTP_HOST, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== HTTP_HOST) {
    server.close();
    throw new DeskError("denied", "http listener must bind to 127.0.0.1");
  }
  return {
    port: address.port,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

export function resolveHttpPort(env: NodeJS.ProcessEnv, explicit?: number): number {
  if (explicit != null) return explicit;
  const raw = env.CLAUDE_REMOTE_HTTP_PORT;
  if (!raw) return HTTP_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return HTTP_PORT;
  return parsed;
}

export function callTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.CLAUDE_REMOTE_CALL_TIMEOUT_MS;
  if (!raw) return 30_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 200 || parsed > 60_000) return 30_000;
  return parsed;
}

async function onRequest(
  config: Config,
  modern: { fetch: (request: Request) => Promise<Response> },
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readBody(req);
  if (body === "too-large") {
    res.writeHead(413);
    res.end();
    return;
  }
  const hostHeader = oneHeader(req.headers.host);
  const originHeader = oneHeader(req.headers.origin);
  const url = new URL(req.url ?? "/", `http://${HTTP_HOST}`);
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404);
    res.end();
    return;
  }
  const host = validateHostHeader(hostHeader, localhostAllowedHostnames());
  if (!host.ok) {
    logEvent({ tool: "http", code: "host-rejected" });
    json(res, 403, { error: "forbidden" });
    return;
  }
  const origin = validateOriginHeader(originHeader, localhostAllowedOrigins());
  if (!origin.ok) {
    logEvent({ tool: "http", code: "origin-rejected" });
    json(res, 403, { error: "forbidden" });
    return;
  }
  const expected = await readToken(config.home);
  const authorization = oneHeader(req.headers.authorization);
  if (!expected || !bearerMatches(authorization, expected)) {
    logEvent({ tool: "http", code: "unauthorized" });
    json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer realm=\"claude-remote\"" });
    return;
  }
  const method = req.method ?? "GET";
  if (method === "POST" && !isJsonContentType(oneHeader(req.headers["content-type"]))) {
    res.writeHead(415);
    res.end();
    return;
  }
  const request = incomingRequest(req, url, body, method);
  const call = method === "POST" ? describeCall(body) : null;
  const started = Date.now();
  if (call) logEvent({ tool: call.name, code: "start" });
  const pending = (async () => {
    const legacy = method === "POST" ? await isLegacyRequest(request.clone()) : false;
    return legacy ? legacyJson(config, request) : modern.fetch(request);
  })();
  pending.catch(() => undefined);
  try {
    const response = call ? await deadline(pending, callTimeoutMs(process.env)) : await pending;
    if (call) logEvent({ tool: call.name, code: "end", durationMs: Date.now() - started });
    await writeResponse(res, response);
  } catch (error) {
    if (call) logEvent({ tool: call.name, code: "error", durationMs: Date.now() - started });
    if (res.headersSent) return;
    if (error instanceof DeskError && error.code === "deadline") {
      json(res, 200, {
        jsonrpc: "2.0",
        id: call?.id ?? null,
        error: { code: -32000, message: "deadline exceeded" },
      });
      return;
    }
    res.writeHead(500);
    res.end();
  }
}

function deskFactory(config: Config): () => McpServer {
  return () => {
    const server = new McpServer({ name: "claude-remote", version: "0.1.0" });
    registerTools(server, config);
    registerLaunchTools(server, config);
    return server;
  };
}

async function legacyJson(config: Config, request: Request): Promise<Response> {
  const server = deskFactory(config)();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function incomingRequest(req: IncomingMessage, url: URL, body: Buffer, method: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (key.toLowerCase() === "host" || key.toLowerCase() === "authorization" || key.toLowerCase() === "connection") continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") init.body = new Uint8Array(body);
  return new Request(url, init);
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    if (step.value) res.write(Buffer.from(step.value));
  }
  res.end();
}

function json(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  res.writeHead(status, { "content-type": "application/json", ...extra });
  res.end(`${JSON.stringify(body)}\n`);
}

function deadline<T>(pending: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeskError("deadline", "deadline exceeded")), ms);
    pending.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function describeCall(body: Buffer): { name: string; id: string | number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as { method?: unknown; id?: unknown; params?: unknown };
  if (record.method !== "tools/call") return null;
  const id = typeof record.id === "string" || typeof record.id === "number" ? record.id : null;
  let name = "invalid";
  if (record.params && typeof record.params === "object") {
    const raw = (record.params as { name?: unknown }).name;
    if (typeof raw === "string" && /^[a-z0-9_-]{1,64}$/i.test(raw)) name = raw;
  }
  return { name, id };
}

async function readBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
  const declared = oneHeader(req.headers["content-length"]);
  if (declared && Number(declared) > MAX_BODY) return "too-large";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY) {
      req.destroy();
      return "too-large";
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function oneHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}
