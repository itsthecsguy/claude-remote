import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { initialize, startServer, toolNames } from "../scripts/stdio-client.js";
import { desktopRoot, fixtureRoot, shimPath, tempHome } from "./helpers.js";

test("tools/list hides send until the flag is set, and confirm false does not spawn", async () => {
  const off = startServer({
    CLAUDE_CONFIG_DIR: fixtureRoot,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
    CLAUDE_REMOTE_ALLOW_SEND: "0",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
  });
  try {
    const init = await initialize(off);
    const info = (init.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
    assert.equal(info?.name, "claude-remote");
    const listed = await off.request("tools/list", {}, 2);
    assert.deepEqual(toolNames(listed), ["list_sessions", "get_session", "continue_command", "rename_session", "cleanup_desk"]);
  } finally {
    off.close();
  }

  const project = await mkdtemp(path.join(tmpdir(), "claude-remote-mcp-"));
  const { home, root } = await tempHome();
  const id = "abcdefab-cdef-4def-8aaa-abcdefabcdef";
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const user = "a1111111-1111-4111-8111-111111111101";
  await writeFile(path.join(dir, `${id}.jsonl`), `${JSON.stringify({
    type: "user",
    uuid: user,
    parentUuid: null,
    sessionId: id,
    timestamp: "2024-01-01T00:00:00.000Z",
    cwd: project,
    message: { role: "user", content: "hello session" },
  })}\n${JSON.stringify({
    type: "assistant",
    uuid: "a1111111-1111-4111-8111-111111111102",
    parentUuid: user,
    sessionId: id,
    timestamp: "2024-01-01T00:00:01.000Z",
    cwd: project,
    message: { role: "assistant", content: [{ type: "text", text: "ready" }] },
  })}\n`);
  const on = startServer({
    CLAUDE_CONFIG_DIR: root,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
    CLAUDE_REMOTE_ALLOW_SEND: "1",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
    HOME: home,
  });
  try {
    await initialize(on);
    const listed = await on.request("tools/list", {}, 2);
    assert.deepEqual(toolNames(listed), ["list_sessions", "get_session", "continue_command", "rename_session", "cleanup_desk", "send_followup", "queue_status"]);
    const denied = await on.request("tools/call", {
      name: "send_followup",
      arguments: { sessionId: id, message: "hello", confirm: false },
    }, 3);
    const failed = Boolean(denied.error) || Boolean(
      denied.result && typeof denied.result === "object" && (denied.result as { isError?: boolean }).isError,
    );
    assert.equal(failed, true);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    on.close();
  }

  const launch = startServer({
    CLAUDE_CONFIG_DIR: fixtureRoot,
    CLAUDE_REMOTE_DESKTOP_ROOT: desktopRoot,
    CLAUDE_REMOTE_ALLOW_SEND: "0",
    CLAUDE_REMOTE_ALLOW_LAUNCH: "1",
    CLAUDE_REMOTE_CLAUDE_BIN: shimPath,
  });
  try {
    await initialize(launch);
    const listed = await launch.request("tools/list", {}, 2);
    assert.deepEqual(toolNames(listed), [
      "list_sessions",
      "get_session",
      "continue_command",
      "rename_session",
      "cleanup_desk",
      "new_session",
      "continue_session",
      "stop_session",
    ]);
  } finally {
    launch.close();
  }
});
