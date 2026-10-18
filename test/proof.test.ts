import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "./helpers.js";

test("the committed proof log shows a stdio session and no transcript text", async () => {
  const text = await readFile(path.join(repoRoot, "docs", "proof", "run.log"), "utf8");
  assert.match(text, /initialize allowSend=0 status=ok server=claude-remote/);
  assert.match(text, /tools\/list allowSend=0 status=ok tools=list_sessions,get_session,continue_command,rename_session,cleanup_desk/);
  assert.match(text, /initialize allowSend=1 status=ok server=claude-remote/);
  assert.match(text, /tools\/list allowSend=1 status=ok tools=list_sessions,get_session,continue_command,rename_session,cleanup_desk,send_followup,queue_status/);
  assert.match(text, /list_sessions status=ok scanned=4/);
  assert.match(text, /get_session status=ok session=11111111-1111-4111-8111-111111111111/);
  assert.match(text, /send_followup status=ok exit=0 displayedInDesktop=false/);
  assert.match(text, /continue_command status=ok session=11111111-1111-4111-8111-111111111111 liveOwner=none warning=none localId=absent/);
  assert.match(text, /argv=-p --resume 11111111-1111-4111-8111-111111111111 --output-format stream-json --verbose <redacted>/);
  assert.equal(text.includes("--dangerously-skip-permissions"), false);
  assert.equal(text.includes("Tighten the audio lead-in"), false);
  assert.equal(text.includes("Shortened the lead-in"), false);
  assert.equal(text.includes("proof-ping"), false);
  assert.equal(text.includes("Audio lead-in"), false);
});
