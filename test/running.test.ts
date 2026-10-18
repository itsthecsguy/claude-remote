import assert from "node:assert/strict";
import test from "node:test";
import { classifyRunState, cmdlinesFromPs, isClaudeProgram } from "../src/running.js";

const ID = "abcdefab-cdef-4def-8aaa-abcdefabcdef";

function stateFor(cmdlines: string[]) {
  return classifyRunState({ registry: { status: "missing" }, sessionId: ID, cmdlines, tail: "closed" });
}

test("our own claude-remote send and continue command lines are not a live session", () => {
  const own = [
    `claude-remote send ${ID} --message hello --yes`,
    `claude-remote continue ${ID}`,
    `node /usr/local/bin/claude-remote send ${ID} --yes --json`,
    `node /usr/local/lib/node_modules/claude-remote/dist/index.js continue ${ID} --i-stopped-it`,
    `/usr/local/bin/claude-remote continue ${ID}`,
  ];
  for (const line of own) {
    assert.equal(isClaudeProgram(line, ID), false, line);
    assert.deepEqual(stateFor([line]), { kind: "finished" }, line);
  }
});

test("a checkout folder named claude-remote is not a live session", () => {
  const lines = [
    `node /Users/you/src/claude-remote/dist/index.js send ${ID} --yes`,
    `node /Users/you/claude-remote/node_modules/.bin/tsx src/index.ts continue ${ID}`,
    `/Users/you/claude-remote/node_modules/.bin/tsx /Users/you/claude-remote/src/index.ts send ${ID}`,
    `bash -c cd /Users/you/claude-remote && npm test ${ID}`,
  ];
  for (const line of lines) {
    assert.equal(isClaudeProgram(line, ID), false, line);
    assert.deepEqual(stateFor([line]), { kind: "finished" }, line);
  }
});

test("an --attach path under ~/.claude-remote/inbox is not a live session", () => {
  const lines = [
    `claude-remote send ${ID} --message hi --attach /Users/you/.claude-remote/inbox/notes.txt --yes`,
    `node /usr/local/bin/claude-remote send ${ID} --attach /Users/you/.claude-remote/inbox/claude --yes`,
    `/usr/local/bin/claude-remote send ${ID} --attach /home/you/.claude-remote/inbox/a.png`,
  ];
  for (const line of lines) {
    assert.equal(isClaudeProgram(line, ID), false, line);
    assert.deepEqual(stateFor([line]), { kind: "finished" }, line);
  }
});

test("a real claude --resume command line still counts as live", () => {
  const real = [
    `claude --resume ${ID}`,
    `/opt/homebrew/bin/claude --resume ${ID} -p`,
    `/Users/you/.local/bin/claude --resume ${ID} --dangerously-load-development-channels server:claude-remote-channel`,
    `/Users/you/.local/share/claude/versions/2.1.205 --resume ${ID}`,
    `node /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume ${ID}`,
    `node /usr/local/bin/claude --resume ${ID}`,
    `/Users/you/Library/Application Support/Claude/claude-code/2.1.205/claude --resume ${ID}`,
  ];
  for (const line of real) {
    assert.equal(isClaudeProgram(line, ID), true, line);
    assert.deepEqual(stateFor([line]), { kind: "running", evidence: "process-argv" }, line);
  }
  assert.deepEqual(stateFor([`claude --resume ${ID}`, `claude-remote send ${ID} --yes`]), { kind: "running", evidence: "process-argv" });
  assert.deepEqual(stateFor(["claude --resume 11111111-1111-4111-8111-111111111111"]), { kind: "finished" });
});

test("ps parsing drops this process and its parent", () => {
  const stdout = [
    `  101 claude --resume ${ID}`,
    `  202 node /usr/local/bin/claude-remote send ${ID} --yes`,
    `  303 /Users/you/claude-remote/node_modules/.bin/tsx src/index.ts send ${ID}`,
    `  404 claude --resume ${ID} -p`,
    "",
    "garbage",
  ].join("\n");
  assert.deepEqual(cmdlinesFromPs(stdout, new Set([202, 404])), [
    `claude --resume ${ID}`,
    `/Users/you/claude-remote/node_modules/.bin/tsx src/index.ts send ${ID}`,
  ]);
  assert.deepEqual(stateFor(cmdlinesFromPs(`  404 claude --resume ${ID}\n`, new Set([404]))), { kind: "finished" });
});
