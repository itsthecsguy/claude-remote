import assert from "node:assert/strict";
import test from "node:test";
import { PendingStore, type PendingChange } from "../src/pending.js";

const SESSION = "34343434-3434-4343-8343-343434343434";

test("store observers see each entry added once and removed once", () => {
  const store = new PendingStore();
  const seen: PendingChange[] = [];
  const stop = store.subscribe((change) => seen.push(change));
  store.subscribe(() => {
    throw new Error("ignored");
  });
  const added = store.record({
    session_id: SESSION,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "ls" },
  }, { allowApprove: false, waitMs: 0 });
  assert.ok(added.requestId);
  store.record({ session_id: SESSION, hook_event_name: "Stop" }, { allowApprove: false, waitMs: 0 });
  assert.deepEqual(seen.map((change) => `${change.type}:${change.view.kind}:${change.view.requestId === added.requestId}`), [
    "added:permission:true",
    "removed:permission:true",
  ]);
  stop();
  store.record({ session_id: SESSION, hook_event_name: "Notification", message: "x" }, { allowApprove: false, waitMs: 0 });
  assert.equal(seen.length, 2);
});
