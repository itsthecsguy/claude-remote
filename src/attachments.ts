import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { DeskError, assertNever } from "./domain.js";
import type { StagedAttachmentView } from "./queue.js";
import { parseSessionId } from "./paths.js";

export const MAX_ATTACHMENTS = 8;
export const HARD_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_DATA_MAX_CHARS = 4 * Math.ceil(HARD_ATTACHMENT_BYTES / 3);

const NAME_MAX = 80;
const PATH_MAX = 4096;
const MIME_MAX = 200;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const SCRIPT_EXT = new Set([".js", ".mjs", ".cjs", ".sh", ".py", ".command", ".bash", ".zsh", ".ps1", ".bat", ".cmd"]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".zip",
]);

export type MediaType =
  | "image/png"
  | "image/jpeg"
  | "image/gif"
  | "image/webp"
  | "application/pdf"
  | "text/plain"
  | "text/markdown"
  | "text/csv"
  | "application/json"
  | "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  | "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  | "application/msword"
  | "application/vnd.ms-excel"
  | "application/vnd.ms-powerpoint";

export type PreparedFile = {
  filename: string;
  bytes: Buffer;
  mediaType: MediaType;
};

type AttachmentItem =
  | { kind: "inline"; filename: string; mimeType: string; data: string }
  | { kind: "path"; path: string };

export function inboxRoot(home: string): string {
  return path.join(home, ".claude-remote", "inbox");
}

export function attachmentsRoot(home: string): string {
  return path.join(home, ".claude-remote", "attachments");
}

export async function ensureAttachmentsRoot(home: string): Promise<string> {
  const homeResolved = path.resolve(home);
  const levels = [
    path.join(homeResolved, ".claude-remote"),
    path.join(homeResolved, ".claude-remote", "attachments"),
  ];
  for (const dir of levels) {
    if (!isInside(homeResolved, dir)) throw new DeskError("denied", "attachment path is not allowed");
    await mkdirPrivate(dir);
    const real = await realpath(dir);
    if (real !== path.resolve(dir)) throw new DeskError("denied", "attachment path is not allowed");
  }
  const root = levels[1];
  if (!root) throw new DeskError("denied", "attachment path is not allowed");
  return root;
}

export function parseAttachmentList(raw: unknown): AttachmentItem[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) {
    throw new DeskError("invalid-message", "attachment list is not valid");
  }
  return raw.map(parseAttachment);
}

export function sanitizeFilename(raw: string): string {
  if (raw.length < 1 || raw.length > NAME_MAX) throw new DeskError("bad-filename", "attachment name is not allowed");
  if (raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    throw new DeskError("bad-filename", "attachment name is not allowed");
  }
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 32 || code === 127) throw new DeskError("bad-filename", "attachment name is not allowed");
  }
  if (raw.startsWith(".")) throw new DeskError("bad-filename", "attachment name is not allowed");
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "_");
  if (cleaned.length < 1 || cleaned.startsWith(".") || cleaned.includes("..")) {
    throw new DeskError("bad-filename", "attachment name is not allowed");
  }
  return cleaned;
}

export function composePrompt(message: string, files: readonly StagedAttachmentView[]): string {
  if (files.length === 0) return message;
  const lines = [message, "Read each file with the Read tool:"];
  for (const file of files) lines.push(`${file.path} (${file.mediaType}, ${file.bytes} bytes)`);
  return lines.join("\n");
}

export async function prepareAttachments(
  home: string,
  raw: unknown,
  limits: { maxBytes: number; maxTotalBytes: number },
  configRoot: string,
): Promise<PreparedFile[]> {
  const items = parseAttachmentList(raw);
  let total = 0;
  const prepared: PreparedFile[] = [];
  for (const item of items) {
    const file = await prepareOne(home, item, limits.maxBytes, configRoot);
    total += file.bytes.length;
    if (total > limits.maxTotalBytes) throw new DeskError("too-large", "attachment is too large");
    prepared.push(file);
  }
  return prepared;
}

export async function writeStaged(
  home: string,
  sessionId: string,
  ticketId: string,
  files: readonly PreparedFile[],
): Promise<StagedAttachmentView[]> {
  const names = files.map((file) => sanitizeFilename(file.filename));
  const dir = await createTicketDir(home, sessionId, ticketId);
  const views: StagedAttachmentView[] = [];
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const name = names[index];
      if (!file || !name) throw new DeskError("invalid-message", "attachment list is not valid");
      views.push(await writeOne(dir, index, name, file));
    }
    return views;
  } catch (error) {
    await removeStaged(home, sessionId, ticketId);
    throw error;
  }
}

export async function removeStaged(home: string, sessionId: string, ticketId: string): Promise<void> {
  const id = parseSessionId(sessionId);
  const ticket = parseSessionId(ticketId);
  if (!id || !ticket) throw new DeskError("denied", "attachment path is not allowed");
  const root = path.resolve(attachmentsRoot(home));
  const dir = path.resolve(root, id, ticket);
  if (!isInside(root, dir)) throw new DeskError("denied", "attachment path is not allowed");
  await removeTree(dir, root);
  const sessionDir = path.dirname(dir);
  if (!isInside(root, sessionDir)) return;
  const names = await readdir(sessionDir).catch((error: unknown) => {
    if (isEnoent(error)) return null;
    throw error;
  });
  if (names && names.length === 0) await rmdir(sessionDir).catch(() => undefined);
}

export async function sweepAttachments(home: string, ttlMs: number, now: number): Promise<void> {
  const homeResolved = path.resolve(home);
  const parent = path.join(homeResolved, ".claude-remote");
  const root = path.resolve(attachmentsRoot(home));
  if (!isInside(parent, root)) throw new DeskError("denied", "attachment path is not allowed");
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (parentInfo.isSymbolicLink()) throw new DeskError("denied", "attachment path is not allowed");
  if (!parentInfo.isDirectory()) return;
  let rootInfo;
  try {
    rootInfo = await lstat(root);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (rootInfo.isSymbolicLink()) {
    await unlink(root);
    return;
  }
  if (!rootInfo.isDirectory()) return;
  const sessions = await readdir(root);
  for (const name of sessions) {
    if (skipName(name) || !parseSessionId(name)) continue;
    const sessionDir = path.join(root, name);
    const info = await lstatOrNull(sessionDir);
    if (!info) continue;
    if (info.isSymbolicLink()) {
      await unlink(sessionDir);
      continue;
    }
    if (!info.isDirectory()) continue;
    const tickets = await readdir(sessionDir);
    for (const ticketName of tickets) {
      if (skipName(ticketName) || !parseSessionId(ticketName)) continue;
      const ticketDir = path.join(sessionDir, ticketName);
      const ticketInfo = await lstatOrNull(ticketDir);
      if (!ticketInfo) continue;
      if (ticketInfo.isSymbolicLink()) {
        await unlink(ticketDir);
        continue;
      }
      if (!ticketInfo.isDirectory()) continue;
      if (now - Number(ticketInfo.mtimeMs) <= ttlMs) continue;
      await removeTree(ticketDir, root);
    }
  }
}

async function prepareOne(
  home: string,
  item: AttachmentItem,
  maxBytes: number,
  configRoot: string,
): Promise<PreparedFile> {
  switch (item.kind) {
    case "inline":
      return prepareInline(item, maxBytes);
    case "path":
      return preparePath(home, item.path, maxBytes, configRoot);
    default: {
      const _never: never = item;
      return assertNever(_never);
    }
  }
}

function prepareInline(item: { filename: string; mimeType: string; data: string }, maxBytes: number): PreparedFile {
  const filename = sanitizeFilename(item.filename);
  const bytes = decodeBase64(item.data, maxBytes);
  const mediaType = classify(bytes, filename, item.mimeType);
  if (!mediaType) throw new DeskError("bad-type", "attachment type is not allowed");
  return { filename, bytes, mediaType };
}

async function preparePath(home: string, requested: string, maxBytes: number, configRoot: string): Promise<PreparedFile> {
  const loaded = await readInboxFile(home, requested, maxBytes, configRoot);
  const filename = sanitizeFilename(loaded.filename);
  const mediaType = classify(loaded.bytes, filename, "");
  if (!mediaType) throw new DeskError("bad-type", "attachment type is not allowed");
  return { filename, bytes: loaded.bytes, mediaType };
}

function decodeBase64(data: string, maxBytes: number): Buffer {
  const cap = Math.min(maxBytes, HARD_ATTACHMENT_BYTES);
  const maxChars = 4 * Math.ceil(cap / 3);
  if (data.length > ATTACHMENT_DATA_MAX_CHARS || data.length > maxChars) {
    throw new DeskError("too-large", "attachment is too large");
  }
  if (data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new DeskError("invalid-message", "attachment data is not valid");
  }
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const expected = (data.length / 4) * 3 - padding;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length !== expected) throw new DeskError("invalid-message", "attachment data is not valid");
  if (bytes.length > cap) throw new DeskError("too-large", "attachment is too large");
  if (bytes.length === 0) throw new DeskError("bad-type", "attachment type is not allowed");
  return bytes;
}

function classify(bytes: Buffer, filename: string, claimedMime: string): MediaType | null {
  if (bytes.length === 0) return null;
  if (isExecutable(bytes)) return null;
  const visual = imageOrPdf(bytes);
  if (visual) return visual;
  if (isZip(bytes)) return officeZip(bytes);
  if (startsWith(bytes, OLE)) return officeOle(bytes);
  return textType(bytes, filename, claimedMime.trim().toLowerCase());
}

function textType(bytes: Buffer, filename: string, mime: string): MediaType | null {
  if (mime.length > MIME_MAX) return null;
  if (claimedBlocked(mime)) return null;
  const ext = path.extname(filename).toLowerCase();
  if (SCRIPT_EXT.has(ext) || BINARY_EXT.has(ext)) return null;
  const text = decodeText(bytes);
  if (text == null) return null;
  const fromExt = textFromExt(ext);
  const fromMime = textFromMime(mime);
  if (fromExt && fromMime && fromExt !== fromMime) return null;
  const chosen = fromExt ?? fromMime ?? (ext === "" && (mime === "" || mime === "application/octet-stream") ? "text/plain" : null);
  if (!chosen) return null;
  if (chosen === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      return null;
    }
  }
  return chosen;
}

function textFromExt(ext: string): MediaType | null {
  switch (ext) {
    case ".txt":
      return "text/plain";
    case ".md":
    case ".markdown":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case "":
      return null;
    default:
      return null;
  }
}

function textFromMime(mime: string): MediaType | null {
  switch (mime) {
    case "text/plain":
      return "text/plain";
    case "text/markdown":
      return "text/markdown";
    case "text/csv":
      return "text/csv";
    case "application/json":
      return "application/json";
    default:
      return null;
  }
}

function claimedBlocked(mime: string): boolean {
  if (mime.startsWith("image/")) return true;
  if (mime === "application/pdf" || mime === "application/zip" || mime === "application/x-msdownload") return true;
  if (mime === "application/msword" || mime.startsWith("application/vnd.")) return true;
  if (mime === "application/javascript" || mime === "text/javascript") return true;
  if (mime.startsWith("text/x-") || mime.startsWith("application/x-")) return true;
  return false;
}

function imageOrPdf(bytes: Buffer): MediaType | null {
  if (startsWith(bytes, PNG)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6) {
    const gif = bytes.subarray(0, 6).toString("ascii");
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}

function isExecutable(bytes: Buffer): boolean {
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true;
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true;
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true;
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return magic === 0xfeedface || magic === 0xcefaedfe || magic === 0xfeedfacf || magic === 0xcffaedfe || magic === 0xcafebabe;
}

function isZip(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function officeZip(bytes: Buffer): MediaType | null {
  const names: string[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length && names.length < 64) {
    if (bytes.readUInt32LE(offset) !== 0x04034b50) break;
    const flags = bytes.readUInt16LE(offset + 6);
    const compressed = bytes.readUInt32LE(offset + 18);
    const nameLen = bytes.readUInt16LE(offset + 26);
    const extraLen = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    if (nameLen > 1024 || nameStart + nameLen > bytes.length) break;
    names.push(bytes.subarray(nameStart, nameStart + nameLen).toString("utf8"));
    if ((flags & 0x08) !== 0) break;
    const next = nameStart + nameLen + extraLen + compressed;
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }
  if (!names.some((name) => name === "[Content_Types].xml")) return null;
  const word = names.some((name) => name.startsWith("word/"));
  const sheet = names.some((name) => name.startsWith("xl/"));
  const slides = names.some((name) => name.startsWith("ppt/"));
  const hits = Number(word) + Number(sheet) + Number(slides);
  if (hits !== 1) return null;
  if (word) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (sheet) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function officeOle(bytes: Buffer): MediaType | null {
  const word = bytes.includes(Buffer.from("WordDocument"));
  const sheet = bytes.includes(Buffer.from("Workbook"));
  const slides = bytes.includes(Buffer.from("PowerPoint Document"));
  const hits = Number(word) + Number(sheet) + Number(slides);
  if (hits !== 1) return null;
  if (word) return "application/msword";
  if (sheet) return "application/vnd.ms-excel";
  return "application/vnd.ms-powerpoint";
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function startsWith(bytes: Buffer, magic: Buffer): boolean {
  return bytes.length >= magic.length && bytes.subarray(0, magic.length).equals(magic);
}

async function readInboxFile(
  home: string,
  requested: string,
  maxBytes: number,
  configRoot: string,
): Promise<{ filename: string; bytes: Buffer }> {
  if (requested.length < 1 || requested.length > PATH_MAX || requested.includes("\0") || !path.isAbsolute(requested)) {
    throw new DeskError("denied", "attachment path is not allowed");
  }
  if (mentionsKey(requested)) throw new DeskError("denied", "attachment path is not allowed");
  const resolved = path.resolve(requested);
  if (mentionsKey(resolved)) throw new DeskError("denied", "attachment path is not allowed");
  const homeResolved = path.resolve(home);
  const inbox = path.resolve(inboxRoot(home));
  if (!isInside(homeResolved, inbox) || !isInside(inbox, resolved)) {
    throw new DeskError("denied", "attachment path is not allowed");
  }
  if (inForbiddenZone(resolved, homeResolved, configRoot) || inForbiddenZone(inbox, homeResolved, configRoot)) {
    throw new DeskError("denied", "attachment path is not allowed");
  }
  await assertRealChain(homeResolved, resolved);
  const handle = await openNoFollow(resolved);
  try {
    const opened = await pathOfHandle(handle, resolved);
    if (opened !== resolved) throw new DeskError("denied", "attachment path is not allowed");
    const inboxReal = await realpath(inbox).catch(() => "");
    if (!inboxReal || !isInside(inboxReal, opened) || inForbiddenZone(opened, homeResolved, configRoot)) {
      throw new DeskError("denied", "attachment path is not allowed");
    }
    const info = await handle.stat();
    if (!info.isFile()) throw new DeskError("denied", "attachment path is not allowed");
    if (info.size > maxBytes) throw new DeskError("too-large", "attachment is too large");
    const bytes = await readExact(handle, info.size);
    return { filename: path.basename(resolved), bytes };
  } finally {
    await handle.close();
  }
}

async function createTicketDir(home: string, sessionId: string, ticketId: string): Promise<string> {
  const id = parseSessionId(sessionId);
  const ticket = parseSessionId(ticketId);
  if (!id || !ticket) throw new DeskError("denied", "attachment path is not allowed");
  const homeResolved = path.resolve(home);
  const levels = [
    path.join(homeResolved, ".claude-remote"),
    path.join(homeResolved, ".claude-remote", "attachments"),
    path.join(homeResolved, ".claude-remote", "attachments", id),
    path.join(homeResolved, ".claude-remote", "attachments", id, ticket),
  ];
  for (const dir of levels) {
    if (!isInside(homeResolved, dir)) throw new DeskError("denied", "attachment path is not allowed");
    await mkdirPrivate(dir);
    const real = await realpath(dir);
    if (real !== path.resolve(dir)) throw new DeskError("denied", "attachment path is not allowed");
  }
  const leaf = levels[3];
  if (!leaf) throw new DeskError("denied", "attachment path is not allowed");
  return leaf;
}

async function mkdirPrivate(dir: string): Promise<void> {
  try {
    const existing = await lstat(dir);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new DeskError("denied", "attachment path is not allowed");
    }
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
    await mkdir(dir, { mode: 0o700 });
  }
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DeskError("denied", "attachment path is not allowed");
  await chmod(dir, 0o700);
}

async function writeOne(dir: string, index: number, filename: string, file: PreparedFile): Promise<StagedAttachmentView> {
  const stored = `${String(index + 1).padStart(2, "0")}-${filename}`;
  const dest = path.resolve(dir, stored);
  const tmp = path.resolve(dir, `.part-${index}-${process.pid}.tmp`);
  if (!isInside(dir, dest) || !isInside(dir, tmp)) throw new DeskError("denied", "attachment path is not allowed");
  let handle: FileHandle;
  try {
    handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch {
    throw new DeskError("denied", "attachment path is not allowed");
  }
  try {
    await handle.writeFile(file.bytes);
    await handle.chmod(0o600);
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await chmod(tmp, 0o600);
  await rename(tmp, dest);
  await chmod(dest, 0o600);
  const info = await lstat(dest);
  if (info.isSymbolicLink() || !info.isFile()) throw new DeskError("denied", "attachment path is not allowed");
  return { path: dest, mediaType: file.mediaType, bytes: file.bytes.length };
}

async function assertRealChain(home: string, target: string): Promise<void> {
  const rel = path.relative(home, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new DeskError("denied", "attachment path is not allowed");
  const parts = rel.split(path.sep).filter((part) => part.length > 0);
  if (parts.length === 0) throw new DeskError("denied", "attachment path is not allowed");
  let current = home;
  for (const part of parts) {
    if (part === "." || part === ".." || part.includes(".key")) {
      throw new DeskError("denied", "attachment path is not allowed");
    }
    current = path.join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (isEnoent(error)) throw new DeskError("denied", "attachment path is not allowed");
      throw error;
    }
    if (info.isSymbolicLink()) throw new DeskError("denied", "attachment path is not allowed");
  }
}

async function openNoFollow(file: string): Promise<FileHandle> {
  try {
    return await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DeskError("denied", "attachment path is not allowed");
  }
}

async function pathOfHandle(handle: FileHandle, lexical: string): Promise<string> {
  const viaFd = await realpath(`/proc/self/fd/${handle.fd}`).catch(() => "");
  if (viaFd.length > 0 && !viaFd.includes(" (deleted)")) return viaFd;
  try {
    return await realpath(lexical);
  } catch {
    throw new DeskError("denied", "attachment path is not allowed");
  }
}

async function readExact(handle: FileHandle, size: number): Promise<Buffer> {
  const bytes = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new DeskError("denied", "attachment path is not allowed");
  return bytes;
}

async function removeTree(target: string, root: string): Promise<void> {
  const resolved = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  if (resolved !== resolvedRoot && !isInside(resolvedRoot, resolved)) {
    throw new DeskError("denied", "attachment path is not allowed");
  }
  let info;
  try {
    info = await lstat(resolved);
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  if (info.isSymbolicLink()) {
    await unlink(resolved);
    return;
  }
  if (info.isDirectory()) {
    const names = await readdir(resolved);
    for (const name of names) {
      if (name === "." || name === ".." || name.includes(".key")) continue;
      await removeTree(path.join(resolved, name), resolvedRoot);
    }
    await rmdir(resolved).catch((error: unknown) => {
      const code = errorCode(error);
      if (code === "ENOTEMPTY" || code === "ENOENT") return;
      throw error;
    });
    return;
  }
  await unlink(resolved);
}

async function lstatOrNull(file: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(file);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

function parseAttachment(value: unknown): AttachmentItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DeskError("invalid-message", "attachment list is not valid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length === 1 && keys[0] === "path" && typeof record.path === "string") {
    return { kind: "path", path: record.path };
  }
  if (
    keys.length === 3
    && keys[0] === "data"
    && keys[1] === "filename"
    && keys[2] === "mimeType"
    && typeof record.data === "string"
    && typeof record.filename === "string"
    && typeof record.mimeType === "string"
    && record.mimeType.length <= MIME_MAX
  ) {
    return { kind: "inline", filename: record.filename, mimeType: record.mimeType, data: record.data };
  }
  throw new DeskError("invalid-message", "attachment list is not valid");
}

function mentionsKey(file: string): boolean {
  return file.split(/[/\\]/).some((part) => part.includes(".key"));
}

function inForbiddenZone(file: string, home: string, configRoot: string): boolean {
  const zones = [
    path.resolve(configRoot),
    path.join(home, ".claude"),
    path.join(home, ".config", "anthropic"),
  ];
  return zones.some((zone) => file === zone || file.startsWith(`${zone}${path.sep}`));
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function skipName(name: string): boolean {
  return name.includes(".key") || name.startsWith(".");
}

function isEnoent(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
