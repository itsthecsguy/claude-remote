import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { CHANNEL_SERVER } from "./continue.js";
import { DeskError } from "./domain.js";

const LOCAL_FILE = "settings.local.json";

export type PreparedProject = {
  relative: string;
  keys: string[];
};

export async function prepareProject(folder: string, home: string, attachmentsDir: string): Promise<PreparedProject> {
  const resolved = path.resolve(folder);
  if (resolved === path.resolve(home)) {
    throw new DeskError("denied", "refusing to write settings for the home directory");
  }
  const claudeDir = path.join(resolved, ".claude");
  const file = path.join(claudeDir, LOCAL_FILE);
  await mkdirPrivate(claudeDir);
  const current = await readObject(file);
  const servers = stringList(current.enabledMcpjsonServers);
  if (!servers.includes(CHANNEL_SERVER)) servers.push(CHANNEL_SERVER);
  current.enabledMcpjsonServers = servers;
  const permissions = objectValue(current.permissions);
  const directories = stringList(permissions.additionalDirectories);
  const attachments = path.resolve(attachmentsDir);
  if (!directories.includes(attachments)) directories.push(attachments);
  permissions.additionalDirectories = directories;
  current.permissions = permissions;
  await writeObject(file, current);
  return {
    relative: path.join(".claude", LOCAL_FILE),
    keys: ["enabledMcpjsonServers", "permissions.additionalDirectories"],
  };
}

async function mkdirPrivate(dir: string): Promise<void> {
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new DeskError("denied", "project settings path is not a directory");
    }
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
    await mkdir(dir, { mode: 0o700 });
  }
  await chmodDir(dir);
}

async function chmodDir(dir: string): Promise<void> {
  const fh = await open(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await fh.chmod(0o700);
  } finally {
    await fh.close();
  }
}

async function readObject(file: string): Promise<Record<string, unknown>> {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new DeskError("denied", "project settings path is not a file");
  }
  const text = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DeskError("denied", "project settings file is not an object");
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DeskError("denied", "project settings file is not an object");
  }
  return objectValue(parsed);
}

async function writeObject(file: string, value: Record<string, unknown>): Promise<void> {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new DeskError("denied", "project settings path is not a file");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if (!isEnoent(error)) throw error;
  }
  const fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fh.chmod(0o600);
  } finally {
    await fh.close();
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new DeskError("denied", "project settings file is not an object");
  }
  return { ...(value as Record<string, unknown>) };
}

function stringList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DeskError("denied", "project settings file is not an object");
  }
  return [...value];
}

function isEnoent(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
