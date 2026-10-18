import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "./helpers.js";

test("the CI workflow pins its actions, has read-only access, and uses no secrets", async () => {
  const text = await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((match) => match[1] ?? "");
  assert.ok(uses.length >= 2);
  for (const ref of uses) assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref} is not pinned to a commit`);
  assert.match(text, /^permissions:\n {2}contents: read\n/m);
  assert.equal(/\bsecrets\./.test(text), false);
  assert.equal(/pull_request_target/.test(text), false);
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /os: \[macos-latest, ubuntu-latest\]/);
  for (const step of ["npm ci", "npm run build", "npm test"]) assert.match(text, new RegExp(`- run: ${step}\\n`));
});
