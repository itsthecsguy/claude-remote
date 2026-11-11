import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The same value as package.json. A test keeps the two equal. */
export const VERSION = "0.2.0";

/**
 * The short commit of the checkout this build runs from, or null when it is not a git checkout or
 * git is not on PATH. `status` prints it so an install can be compared with the repository.
 */
export function installedCommit(): Promise<string | null> {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  return new Promise((resolve) => {
    try {
      execFile("git", ["-C", root, "rev-parse", "--short", "HEAD"], { timeout: 2000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }, (error, stdout) => {
        const commit = String(stdout ?? "").trim();
        resolve(!error && /^[0-9a-f]{4,40}$/.test(commit) ? commit : null);
      });
    } catch {
      resolve(null);
    }
  });
}
