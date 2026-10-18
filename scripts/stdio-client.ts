import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type RpcMessage = {
  id?: number;
  result?: unknown;
  error?: { message?: string };
};

export type RpcClient = {
  request(method: string, params: unknown, id: number): Promise<RpcMessage>;
  notify(method: string, params?: unknown): void;
  stderr(): string;
  close(): void;
};

export function startServer(env: Record<string, string | undefined>): RpcClient {
  const child = spawn(path.join(repoRoot, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let buffer = "";
  const pending: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl < 0) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else pending.push(line);
    }
  });
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });
  const nextLine = (): Promise<string> => {
    const queued = pending.shift();
    if (queued != null) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for stdio")), 8000);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  };
  return {
    async request(method, params, id) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      while (true) {
        const line = await nextLine();
        if (line.trim().length === 0) continue;
        const message = JSON.parse(line) as RpcMessage;
        if (message.id === id) return message;
      }
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    stderr: () => stderrText,
    close() {
      child.stdin.end();
      child.kill();
    },
  };
}

export async function initialize(client: RpcClient): Promise<RpcMessage> {
  const response = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "claude-remote-proof", version: "0.1.0" },
  }, 1);
  client.notify("notifications/initialized", {});
  return response;
}

export function toolNames(message: RpcMessage): string[] {
  const result = message.result;
  if (!result || typeof result !== "object") return [];
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== "object" || typeof (tool as { name?: unknown }).name !== "string") return [];
    return [(tool as { name: string }).name];
  });
}
