import { execFile } from "node:child_process";
import type { GitFacts } from "./domain.js";

const GIT_TIMEOUT_MS = 2000;

/**
 * Read branch, HEAD, upstream distance, and the number of changed files with one
 * `git status --porcelain=v2 --branch`. It lets a remote reader check a claim such as "pushed"
 * against the checkout itself. null when the folder is not a git checkout or git does not answer.
 * GIT_OPTIONAL_LOCKS=0 keeps the read from touching the index while a session is working in it.
 */
export function gitFacts(cwd: string): Promise<GitFacts | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        "git",
        ["-C", cwd, "status", "--porcelain=v2", "--branch"],
        { timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
        (error, stdout) => {
          if (error) resolve(null);
          else resolve(parseGitStatus(String(stdout)));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

export function parseGitStatus(text: string): GitFacts {
  const facts: GitFacts = { head: null, branch: null, upstream: null, ahead: null, behind: null, dirtyFiles: 0, pushed: null };
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    if (!line.startsWith("# ")) {
      facts.dirtyFiles += 1;
      continue;
    }
    const [key, ...rest] = line.slice(2).split(" ");
    const value = rest.join(" ");
    if (key === "branch.oid" && /^[0-9a-f]{7,64}$/.test(value)) facts.head = value.slice(0, 12);
    else if (key === "branch.head" && value !== "(detached)") facts.branch = value.slice(0, 200);
    else if (key === "branch.upstream") facts.upstream = value.slice(0, 200);
    else if (key === "branch.ab") {
      const match = /^\+(\d+) -(\d+)$/.exec(value);
      if (match) {
        facts.ahead = Number(match[1]);
        facts.behind = Number(match[2]);
      }
    }
  }
  if (facts.upstream && facts.ahead != null) facts.pushed = facts.ahead === 0;
  return facts;
}
