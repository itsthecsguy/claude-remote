import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, stat, symlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { attachmentsRoot, inboxRoot, writeStaged } from "../src/attachments.js";
import { listenerSocket, serveChannel } from "../src/channel.js";
import { parseConfig } from "../src/config.js";
import { DeskError } from "../src/domain.js";
import { queueDirectory } from "../src/queue.js";
import type { ProcessIdentityLookup } from "../src/registry.js";
import { queueStatus, sendFollowup, sendFollowupSchema } from "../src/tools.js";
import { captureError, configAt, tempDir, tempHome } from "./helpers.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const PDF = Buffer.from("%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
const SECRET = "SECRET-FILE-BODY";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("a confirmed send stages an image, a pdf, and text, and the prompt names the paths", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const notes = Buffer.from(`${SECRET}\n`);
  const config = configAt(home, root, { allowSend: true });
  let outcome: Awaited<ReturnType<typeof sendFollowup>> | undefined;
  const logs = await captureError(async () => {
    outcome = await sendFollowup(config, {
      sessionId: id,
      message: "Look at these",
      confirm: true,
      attachments: [
        { filename: "unique-shot.png", mimeType: "image/png", data: PNG.toString("base64") },
        { filename: "notes.pdf", mimeType: "application/pdf", data: PDF.toString("base64") },
        { filename: "unique-notes.txt", mimeType: "text/plain", data: notes.toString("base64") },
      ],
    });
  });
  assert.ok(outcome);
  assert.equal(outcome.disposition, "sent");
  if (outcome.disposition !== "sent") return;
  assert.equal(outcome.displayedInDesktop, false);
  const views = outcome.attachments;
  assert.ok(views);
  assert.equal(views.length, 3);
  assert.deepEqual(views.map((view) => view.mediaType), ["image/png", "application/pdf", "text/plain"]);
  assert.deepEqual(views.map((view) => view.bytes), [PNG.length, PDF.length, notes.length]);
  const ticketDir = path.dirname(views[0]?.path ?? "");
  assert.equal((await lstat(ticketDir)).isDirectory(), true);
  assert.equal((await lstat(ticketDir)).mode & 0o777, 0o700);
  assert.equal((await lstat(path.dirname(ticketDir))).mode & 0o777, 0o700);
  assert.equal((await lstat(attachmentsRoot(home))).mode & 0o777, 0o700);
  assert.equal((await lstat(path.join(home, ".claude-remote"))).mode & 0o777, 0o700);
  for (const view of views) {
    assert.equal(view.path.startsWith(`${attachmentsRoot(home)}${path.sep}`), true);
    assert.equal(view.path.includes(`${path.sep}inbox${path.sep}`), false);
    assert.equal((await lstat(view.path)).isSymbolicLink(), false);
    assert.equal((await lstat(view.path)).mode & 0o777, 0o600);
  }
  assert.equal(path.basename(views[0]?.path ?? ""), "01-unique-shot.png");
  assert.equal(path.basename(views[1]?.path ?? ""), "02-notes.pdf");
  assert.equal(path.basename(views[2]?.path ?? ""), "03-unique-notes.txt");
  assert.deepEqual(await readFile(views[0]?.path ?? ""), PNG);
  assert.deepEqual(await readFile(views[1]?.path ?? ""), PDF);
  assert.equal(await readFile(views[2]?.path ?? "", "utf8"), `${SECRET}\n`);
  const names = await readdir(ticketDir);
  assert.equal(names.some((name) => name.startsWith(".part-")), false);
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as {
    argv: string[];
    stdin: string;
  };
  assert.equal(record.argv.includes("--input-format"), false);
  assert.equal(record.argv.includes("Look at these"), false);
  assert.equal(record.stdin.includes("Look at these"), true);
  assert.equal(record.stdin.includes("Read each file with the Read tool:"), true);
  for (const view of views) {
    assert.equal(record.stdin.includes(`${view.path} (${view.mediaType}, ${view.bytes} bytes)`), true);
  }
  assert.equal(record.stdin.includes(SECRET), false);
  assert.equal(record.stdin.includes(PNG.toString("base64")), false);
  assert.equal(record.stdin.includes("%PDF-1.1"), false);
  const tickets = await readdir(queueDirectory(home, id));
  const ticketName = tickets.find((name) => name.endsWith(".json"));
  assert.ok(ticketName);
  const stored = await readFile(path.join(queueDirectory(home, id), ticketName), "utf8");
  assert.equal(stored.includes(views[0]?.path ?? "missing"), true);
  assert.equal(stored.includes(SECRET), false);
  const status = await queueStatus(config, { sessionId: id });
  assert.equal(JSON.stringify(status).includes(SECRET), false);
  assert.equal(logs.includes(SECRET), false);
  assert.equal(logs.includes("unique-shot"), false);
  assert.equal(logs.includes("unique-notes"), false);
  assert.equal(logs.includes(PNG.toString("base64")), false);
  assert.equal(logs.includes("%PDF"), false);
  assert.equal(logs.includes("attachmentCount"), true);
  assert.equal(logs.includes("image/png"), true);
  assert.equal(logs.includes("application/pdf"), true);
  assert.equal(logs.includes("text/plain"), true);
});

test("magic bytes accept jpeg, gif, webp, text types, and office documents", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  const first = await sendFollowup(config, {
    sessionId: id,
    message: "types",
    confirm: true,
    attachments: [
      inline("shot.jpg", "image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
      inline("anim.gif", "image/gif", Buffer.from("GIF89a")),
      inline("still.webp", "image/webp", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")])),
      inline("rows.csv", "text/csv", Buffer.from("a,b\n1,2\n")),
      inline("note.md", "text/markdown", Buffer.from("# Title\n")),
      inline("data.json", "application/json", Buffer.from('{"ok":true}\n')),
      inline("page.docx", "application/octet-stream", storedZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "word/document.xml", data: "<w:document/>" },
      ])),
      inline("sheet.xlsx", "application/octet-stream", storedZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "xl/workbook.xml", data: "<workbook/>" },
      ])),
    ],
  });
  assert.equal(first.disposition, "sent");
  if (first.disposition !== "sent") return;
  assert.deepEqual(first.attachments?.map((view) => view.mediaType), [
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/csv",
    "text/markdown",
    "application/json",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]);
  const second = await sendFollowup(config, {
    sessionId: id,
    message: "more types",
    confirm: true,
    attachments: [
      inline("deck.pptx", "application/octet-stream", storedZip([
        { name: "[Content_Types].xml", data: "<Types/>" },
        { name: "ppt/presentation.xml", data: "<p/>" },
      ])),
      inline("legacy.doc", "application/octet-stream", Buffer.concat([
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
        Buffer.from("WordDocument"),
      ])),
      inline("notes.txt", "text/plain", PNG),
    ],
  });
  assert.equal(second.disposition, "sent");
  if (second.disposition !== "sent") return;
  assert.deepEqual(second.attachments?.map((view) => view.mediaType), [
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/msword",
    "image/png",
  ]);
  assert.equal(path.basename(second.attachments?.[2]?.path ?? ""), "03-notes.txt");
});

test("an inbox path is copied, and the prompt names the staged path", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true, mode: 0o700 });
  const source = path.join(inbox, "shot.png");
  await writeFile(source, PNG);
  const config = configAt(home, root, { allowSend: true });
  const outcome = await sendFollowup(config, {
    sessionId: id,
    message: "from inbox",
    confirm: true,
    attachments: [{ path: source }],
  });
  assert.equal(outcome.disposition, "sent");
  if (outcome.disposition !== "sent") return;
  const view = outcome.attachments?.[0];
  assert.ok(view);
  assert.equal(view.mediaType, "image/png");
  assert.notEqual(view.path, source);
  assert.deepEqual(await readFile(view.path), PNG);
  assert.deepEqual(await readFile(source), PNG);
  const record = JSON.parse(await readFile(path.join(project, "fake-claude-record.json"), "utf8")) as { stdin: string };
  assert.equal(record.stdin.includes(view.path), true);
  assert.equal(record.stdin.includes(source), false);
});

test("rejected types are not staged", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  const samples = [
    inline("photo.png", "image/png", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])),
    inline("photo.png", "image/png", Buffer.from("#!/bin/sh\necho hi\n")),
    inline("photo.png", "image/png", Buffer.from("this is words, not a png\n")),
    inline("app.bin", "application/octet-stream", Buffer.from([0xcf, 0xfa, 0xed, 0xfe])),
    inline("app.exe", "application/octet-stream", Buffer.from([0x4d, 0x5a, 0x00, 0x00])),
    inline("run.js", "text/plain", Buffer.from("console.log(1)\n")),
    inline("data.json", "application/json", Buffer.from("{")),
    inline("pack.zip", "application/zip", storedZip([{ name: "hello.txt", data: "hi" }])),
  ];
  for (const sample of samples) {
    await assert.rejects(
      () => sendFollowup(config, { sessionId: id, message: "no", confirm: true, attachments: [sample] }),
      (error: unknown) => error instanceof DeskError && error.code === "bad-type",
    );
  }
  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true });
  const empty = path.join(inbox, "empty.txt");
  await writeFile(empty, Buffer.alloc(0));
  await assert.rejects(
    () => sendFollowup(config, { sessionId: id, message: "no", confirm: true, attachments: [{ path: empty }] }),
    (error: unknown) => error instanceof DeskError && error.code === "bad-type",
  );
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
});

test("an oversize file and an oversize total are refused before staging", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  config.attachmentMaxBytes = 8;
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "big",
      confirm: true,
      attachments: [inline("shot.png", "image/png", PNG)],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "too-large",
  );
  config.attachmentMaxBytes = 1024;
  config.attachmentMaxTotalBytes = 20;
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "big",
      confirm: true,
      attachments: [
        inline("a.txt", "text/plain", Buffer.from("hello notes one\n")),
        inline("b.txt", "text/plain", Buffer.from("hello notes two\n")),
      ],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "too-large",
  );
  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true });
  const fat = path.join(inbox, "fat.txt");
  await writeFile(fat, Buffer.alloc(100, 0x61));
  config.attachmentMaxBytes = 8;
  config.attachmentMaxTotalBytes = 1024;
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "big",
      confirm: true,
      attachments: [{ path: fat }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "too-large",
  );
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));
});

test("filenames that escape or hide are refused, and safe names are indexed", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  const bad = ["../etc/passwd", "a/b.png", "a\\b.png", "..", ".hidden.png", `a${String.fromCharCode(1)}b.png`, `${"a".repeat(77)}.txt`];
  for (const filename of bad) {
    await assert.rejects(
      () => sendFollowup(config, {
        sessionId: id,
        message: "name",
        confirm: true,
        attachments: [inline(filename, "text/plain", Buffer.from("ok\n"))],
      }),
      (error: unknown) => error instanceof DeskError && error.code === "bad-filename",
    );
  }
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));
  const outcome = await sendFollowup(config, {
    sessionId: id,
    message: "names",
    confirm: true,
    attachments: [
      inline("my report.png", "image/png", PNG),
      inline("my report.png", "image/png", PNG),
      inline(`${"n".repeat(76)}.txt`, "text/plain", Buffer.from("ok\n")),
    ],
  });
  assert.equal(outcome.disposition, "sent");
  if (outcome.disposition !== "sent") return;
  assert.equal(path.basename(outcome.attachments?.[0]?.path ?? ""), "01-my_report.png");
  assert.equal(path.basename(outcome.attachments?.[1]?.path ?? ""), "02-my_report.png");
  const longName = path.basename(outcome.attachments?.[2]?.path ?? "");
  assert.equal(longName.startsWith("03-nnnn"), true);
  assert.equal(longName.startsWith("."), false);
});

test("a live session with no listener does not read or stage attachments", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  await writeLiveSession(root, id);
  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true });
  const secret = path.join(inbox, "secret.png");
  await writeFile(secret, PNG);
  const before = await stale(secret);
  const config = configAt(home, root, { allowSend: true });
  const outcome = await sendFollowup(config, {
    sessionId: id,
    message: "look",
    confirm: true,
    attachments: [
      { path: secret },
      inline("unique-shot.png", "image/png", PNG),
    ],
  }, async () => [], live4242);
  assert.equal(outcome.disposition, "undelivered");
  assert.equal("attachments" in outcome, false);
  assert.ok(atimeHeld(before, (await stat(secret)).atimeMs));
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
});

test("steer and a closed send gate do not read attachments", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true });
  const secret = path.join(inbox, "secret.png");
  await writeFile(secret, PNG);
  const before = await stale(secret);
  const open = configAt(home, root, { allowSend: true });
  const steered = await sendFollowup(open, {
    sessionId: id,
    message: "stop",
    confirm: true,
    mode: "steer",
    attachments: [{ path: secret }],
  });
  assert.equal(steered.disposition, "unsupported");
  await assert.rejects(
    () => sendFollowup(configAt(home, root), {
      sessionId: id,
      message: "stop",
      confirm: true,
      attachments: [{ path: secret }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "send-disabled",
  );
  await assert.rejects(
    () => sendFollowup(open, {
      sessionId: id,
      message: "stop",
      confirm: false,
      attachments: [{ path: secret }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "confirm-required",
  );
  assert.ok(atimeHeld(before, (await stat(secret)).atimeMs));
  await assert.rejects(() => stat(attachmentsRoot(home)));
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
});

test("a channel accept keeps the staged file in the frame, and a reject deletes it", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const notes = Buffer.from(`${SECRET}\n`);
  const accepted = await serveChannel(listenerSocket(home, id));
  try {
    const config = configAt(home, root, { allowSend: true });
    const logs = await captureError(async () => {
      const outcome = await sendFollowup(config, {
        sessionId: id,
        message: "channel file",
        confirm: true,
        attachments: [inline("unique-notes.txt", "text/plain", notes)],
      });
      assert.equal(outcome.disposition, "handed");
      if (outcome.disposition !== "handed") return;
      const view = outcome.attachments?.[0];
      assert.ok(view);
      assert.equal(await readFile(view.path, "utf8"), `${SECRET}\n`);
      assert.equal(accepted.received.length, 1);
      assert.equal(accepted.received[0]?.includes(view.path), true);
      assert.equal(accepted.received[0]?.includes(SECRET), false);
      assert.equal(accepted.received[0]?.includes(notes.toString("base64")), false);
    });
    assert.equal(logs.includes(SECRET), false);
    assert.equal(logs.includes("unique-notes"), false);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    await accepted.close();
  }

  const rejected = await serveChannel(listenerSocket(home, id), { sessionId: OTHER });
  try {
    const config = configAt(home, root, { allowSend: true });
    const outcome = await sendFollowup(config, {
      sessionId: id,
      message: "nope",
      confirm: true,
      attachments: [inline("shot.png", "image/png", PNG)],
    });
    assert.equal(outcome.disposition, "rejected");
    assert.equal("attachments" in outcome, false);
    const left = await readdir(path.join(attachmentsRoot(home), id));
    assert.equal(left.length, 1);
    await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
  } finally {
    await rejected.close();
  }
});

test("a failed spawn deletes the staged ticket, and a busy queue keeps it", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const missing = configAt(home, root, { allowSend: true });
  missing.claudeBin = path.join(home, "missing-claude");
  await assert.rejects(
    () => sendFollowup(missing, {
      sessionId: id,
      message: "fail",
      confirm: true,
      attachments: [inline("shot.png", "image/png", PNG)],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "spawn-failed",
  );
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));

  const held = "11111111-1111-4111-8111-111111111111";
  const dir = queueDirectory(home, id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${held}.json`), `${JSON.stringify({
    ticketId: held,
    sessionId: id,
    message: "already-sending",
    state: "sending",
    enqueuedAt: "2020-01-01T00:00:00.000Z",
    writerPid: process.pid,
  })}\n`);
  const config = configAt(home, root, { allowSend: true });
  const outcome = await sendFollowup(config, {
    sessionId: id,
    message: "wait",
    confirm: true,
    attachments: [inline("shot.png", "image/png", PNG)],
  });
  assert.equal(outcome.disposition, "queued");
  if (outcome.disposition !== "queued") return;
  const view = outcome.attachments?.[0];
  assert.ok(view);
  assert.deepEqual(await readFile(view.path), PNG);
  await assert.rejects(() => stat(path.join(project, "fake-claude-record.json")));
});

test("sweep removes expired ticket directories and nothing outside them", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const oldId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const youngId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const oldTicket = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const youngTicket = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  await writeStaged(home, oldId, oldTicket, [{ filename: "old.txt", bytes: Buffer.from("old\n"), mediaType: "text/plain" }]);
  await writeStaged(home, youngId, youngTicket, [{ filename: "new.txt", bytes: Buffer.from("new\n"), mediaType: "text/plain" }]);
  const oldDir = path.join(attachmentsRoot(home), oldId, oldTicket);
  const outside = path.join(home, "outside-keep.txt");
  await writeFile(outside, "STAY");
  await symlink(outside, path.join(oldDir, "alias"));
  const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await utimes(oldDir, oldTime, oldTime);
  const keep = path.join(attachmentsRoot(home), "keep.txt");
  await writeFile(keep, "keep");
  const key = path.join(attachmentsRoot(home), "secret.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const keyBefore = await stale(key);
  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true });
  const parked = path.join(inbox, "parked.txt");
  await writeFile(parked, "parked");
  const config = configAt(home, root, { allowSend: true });
  await sendFollowup(config, { sessionId: id, message: "sweep", confirm: true });
  await assert.rejects(() => stat(oldDir));
  assert.equal(await readFile(outside, "utf8"), "STAY");
  assert.equal((await stat(path.join(attachmentsRoot(home), youngId, youngTicket))).isDirectory(), true);
  assert.equal(await readFile(keep, "utf8"), "keep");
  assert.equal(await readFile(parked, "utf8"), "parked");
  assert.ok(atimeHeld(keyBefore, (await stat(key)).atimeMs));
});

test("attachment paths stay inside the inbox", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  const claudeSecret = path.join(root, "secret.png");
  await writeFile(claudeSecret, PNG);
  const claudeBefore = await stale(claudeSecret);
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: claudeSecret }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.ok(atimeHeld(claudeBefore, (await stat(claudeSecret)).atimeMs));
  await assert.rejects(() => stat(inboxRoot(home)));

  const escaped = path.resolve(inboxRoot(home), "..", "..", ".claude", "secret.png");
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: escaped }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.ok(atimeHeld(claudeBefore, (await stat(claudeSecret)).atimeMs));

  const anthropic = path.join(home, ".config", "anthropic");
  await mkdir(anthropic, { recursive: true });
  const anthropicSecret = path.join(anthropic, "notes.txt");
  await writeFile(anthropicSecret, "notes\n");
  const anthropicBefore = await stale(anthropicSecret);
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: anthropicSecret }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.ok(atimeHeld(anthropicBefore, (await stat(anthropicSecret)).atimeMs));

  const key = path.join(root, "credentials.key");
  await writeFile(key, "SECRET-KEY-BODY");
  const keyBefore = await stale(key);
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: key }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.ok(atimeHeld(keyBefore, (await stat(key)).atimeMs));

  const inbox = inboxRoot(home);
  await mkdir(inbox, { recursive: true });
  const inboxKey = path.join(inbox, "token.key");
  await writeFile(inboxKey, "SECRET-KEY-BODY");
  const inboxKeyBefore = await stale(inboxKey);
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: inboxKey }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.ok(atimeHeld(inboxKeyBefore, (await stat(inboxKey)).atimeMs));

  const link = path.join(inbox, "shot.png");
  await symlink(claudeSecret, link);
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: link }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.ok(atimeHeld(claudeBefore, (await stat(claudeSecret)).atimeMs));
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));

  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ path: "shot.png" }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "no",
      confirm: true,
      attachments: [{ filename: "a.png", mimeType: "image/png", data: PNG.toString("base64"), path: link }],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "invalid-message",
  );
});

test("a symlink in place of the desk or attachments directory is not followed", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const outside = path.join(home, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.txt"), "STAY");
  await symlink(outside, path.join(home, ".claude-remote"));
  const config = configAt(home, root, { allowSend: true });
  await assert.rejects(
    () => sendFollowup(config, { sessionId: id, message: "no", confirm: true }),
    (error: unknown) => error instanceof DeskError && error.code === "denied",
  );
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "STAY");
  assert.deepEqual(await readdir(outside), ["keep.txt"]);

  const { home: home2, root: root2 } = await tempHome();
  const project2 = await tempDir("claude-remote-proj-");
  const id2 = await writeSession(root2, project2);
  const outside2 = path.join(home2, "outside");
  await mkdir(outside2);
  await writeFile(path.join(outside2, "keep.txt"), "STAY");
  await mkdir(path.join(home2, ".claude-remote"), { mode: 0o700 });
  await symlink(outside2, attachmentsRoot(home2));
  await sendFollowup(configAt(home2, root2, { allowSend: true }), { sessionId: id2, message: "ok", confirm: true });
  assert.equal(await readFile(path.join(outside2, "keep.txt"), "utf8"), "STAY");
  assert.deepEqual(await readdir(outside2), ["keep.txt"]);
  await assert.rejects(() => lstat(attachmentsRoot(home2)));
});

test("attachment limits clamp, and the tool schema rejects a mixed item", async () => {
  const huge = parseConfig({
    CLAUDE_REMOTE_ATTACHMENT_MAX_BYTES: "999999999",
    CLAUDE_REMOTE_ATTACHMENT_MAX_TOTAL_BYTES: "999999999",
    CLAUDE_REMOTE_ATTACHMENT_TTL_MS: "999999999999",
  }, { home: "/tmp/claude-remote-home", platform: "linux" });
  assert.equal(huge.attachmentMaxBytes, 20 * 1024 * 1024);
  assert.equal(huge.attachmentMaxTotalBytes, 50 * 1024 * 1024);
  assert.equal(huge.attachmentTtlMs, 30 * 24 * 60 * 60 * 1000);
  const defaults = parseConfig({}, { home: "/tmp/claude-remote-home", platform: "linux" });
  assert.equal(defaults.attachmentMaxBytes, 5 * 1024 * 1024);
  assert.equal(defaults.attachmentMaxTotalBytes, 20 * 1024 * 1024);
  assert.equal(defaults.attachmentTtlMs, 24 * 60 * 60 * 1000);
  const mixed = sendFollowupSchema.safeParse({
    sessionId: "abc",
    message: "hi",
    confirm: true,
    attachments: [{ filename: "a.png", mimeType: "image/png", data: "aaaa", path: "/tmp/x" }],
  });
  assert.equal(mixed.success, false);
  const pathOnly = sendFollowupSchema.safeParse({
    sessionId: "abc",
    message: "hi",
    confirm: true,
    attachments: [{ path: "/tmp/claude-remote-home/.claude-remote/inbox/a.png" }],
  });
  assert.equal(pathOnly.success, true);
});

test("a prompt that would exceed the channel limit is not left on disk", async () => {
  const project = await tempDir("claude-remote-proj-");
  const { home, root } = await tempHome();
  const id = await writeSession(root, project);
  const config = configAt(home, root, { allowSend: true });
  await assert.rejects(
    () => sendFollowup(config, {
      sessionId: id,
      message: "m".repeat(100000),
      confirm: true,
      attachments: [inline("shot.png", "image/png", PNG)],
    }),
    (error: unknown) => error instanceof DeskError && error.code === "invalid-message",
  );
  await assert.rejects(() => stat(path.join(attachmentsRoot(home), id)));
});

function inline(filename: string, mimeType: string, bytes: Buffer): { filename: string; mimeType: string; data: string } {
  return { filename, mimeType, data: bytes.toString("base64") };
}

function storedZip(entries: { name: string; data: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    parts.push(header, name, data);
  }
  return Buffer.concat(parts);
}

async function stale(file: string): Promise<number> {
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  await utimes(file, old, old);
  return (await stat(file)).atimeMs;
}

function atimeHeld(before: number, after: number): boolean {
  return Math.abs(after - before) < 1000;
}

async function writeSession(root: string, cwd: string, id = "abcdefab-cdef-4def-8aaa-abcdefabcdef"): Promise<string> {
  const dir = path.join(root, "projects", "slug");
  await mkdir(dir, { recursive: true });
  const user = "a1111111-1111-4111-8111-111111111101";
  const assistant = "a1111111-1111-4111-8111-111111111102";
  const lines = [
    JSON.stringify({
      type: "user",
      uuid: user,
      parentUuid: null,
      sessionId: id,
      timestamp: "2024-01-01T00:00:00.000Z",
      cwd,
      message: { role: "user", content: "hello session" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: assistant,
      parentUuid: user,
      sessionId: id,
      timestamp: "2024-01-01T00:00:01.000Z",
      cwd,
      message: { role: "assistant", content: [{ type: "text", text: "ready" }] },
    }),
  ];
  await writeFile(path.join(dir, `${id}.jsonl`), `${lines.join("\n")}\n`);
  return id;
}

async function writeLiveSession(root: string, id: string): Promise<void> {
  await mkdir(path.join(root, "sessions"), { recursive: true });
  await writeFile(path.join(root, "sessions", "4242.json"), JSON.stringify({
    pid: 4242,
    sessionId: id,
    procStart: "100",
  }));
}

const live4242: ProcessIdentityLookup = async (pid) => pid === 4242
  ? { alive: true, startToken: "100" }
  : { alive: false };
