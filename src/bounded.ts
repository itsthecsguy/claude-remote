import { spawn, type ChildProcess } from "node:child_process";

export class ProbeTimeout extends Error {
  readonly code = "timeout";

  constructor() {
    super("probe timed out");
    this.name = "ProbeTimeout";
  }
}

export function runBoundedNode(source: string, arg: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", source, arg], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    child.unref();
    const output = child.stdout as { unref?: () => void } | null;
    output?.unref?.();
    let stdout = "";
    let settled = false;
    const finish = (error: Error | null, value: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      stopChild(child);
      finish(new ProbeTimeout(), "");
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 65536) {
        stopChild(child);
        finish(new Error("probe output was too large"), "");
      }
    });
    child.on("error", (error) => {
      stopChild(child);
      finish(error, "");
    });
    child.on("close", () => {
      finish(null, stdout);
    });
  });
}

function stopChild(child: ChildProcess): void {
  const pid = child.pid;
  if (pid != null) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        return;
      }
    }
  }
  child.stdout?.destroy();
  child.unref();
}
