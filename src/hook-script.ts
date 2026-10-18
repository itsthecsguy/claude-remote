import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DeskError } from "./domain.js";
import { HOOK_MARKER } from "./hook-settings.js";
import { tokenDirectory } from "./token.js";

/**
 * A POSIX sh version of `claude-remote hook`, so each hook event costs a shell and a curl instead
 * of a Node start. It speaks a plain-text variant of the /hook endpoints (?format=text) and lets
 * the helper build the decision JSON with the same decisionOutput the Node hook uses, so the two
 * print the same thing. It fails open like the Node hook: no token, no helper, a timeout, or any
 * other problem exits 0 with no output. When curl is missing it runs the Node hook instead.
 *
 * The bearer token is read from the token file with the shell's own `read` and handed to curl as
 * a config file on a pipe (-K /dev/fd/3), so it never appears in any process's argument list.
 * The hook JSON is kept in a shell variable and piped to curl; it is never written to disk.
 */

export const HOOK_SCRIPT_NAME = "hook.sh";

export function hookScriptPath(home: string): string {
  return path.join(tokenDirectory(home), HOOK_SCRIPT_NAME);
}

function shQuote(value: string): string {
  if (value.includes("\0") || value.includes("\n")) throw new DeskError("usage", "path is not allowed in the hook script");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function renderHookScript(input: { stateDir: string; nodeBin: string; entry: string }): string {
  return `#!/bin/sh
# claude-remote hook, written by \`claude-remote install\`. Claude Code runs it for the events install
# registers. It forwards the event JSON on stdin to the claude-remote helper on 127.0.0.1 and fails
# open: any problem exits 0 with no output, which Claude Code treats as no decision.
STATE=${shQuote(input.stateDir)}
NODE=${shQuote(input.nodeBin)}
ENTRY=${shQuote(input.entry)}
exec 2>/dev/null
command -v curl >/dev/null 2>&1 || exec "$NODE" "$ENTRY" hook ${HOOK_MARKER}

# Read the whole event first, so Claude Code never writes into a closed pipe.
INPUT=$(cat) || exit 0
[ -n "$INPUT" ] || exit 0
[ -f "$STATE/token" ] && [ ! -L "$STATE/token" ] || exit 0
TOKEN=
IFS= read -r TOKEN < "$STATE/token" || [ -n "$TOKEN" ] || exit 0
case $TOKEN in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
[ \${#TOKEN} -ge 43 ] || exit 0
PORT=\${CLAUDE_REMOTE_HTTP_PORT:-}
[ -n "$PORT" ] || { IFS= read -r PORT < "$STATE/port" || :; }
case $PORT in '' | *[!0-9]*) PORT=47321 ;; esac
{ [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ]; } || PORT=47321

# post PATH MAX_SECONDS: request body on stdin, response body on stdout. The token reaches curl
# as a config file on fd 3, never as an argument.
post() {
  {
    printf 'header = "Authorization: Bearer %s"\\n' "$TOKEN" | {
      curl -q -s -f --noproxy '*' --connect-timeout 1 --max-time "$2" -K /dev/fd/3 \\
        -H 'Content-Type: application/json' -H 'Expect:' --data-binary @- \\
        "http://127.0.0.1:$PORT$1" 3<&0 0<&4
    }
  } 4<&0
}

set -f
REPLY=$(printf '%s' "$INPUT" | post '/hook/event?format=text' 1.5) || exit 0
set -- $REPLY
[ "$1" = wait ] || exit 0
RID=$2
WAIT_MS=$3
case $RID in '' | *[!A-Za-z0-9_-]*) exit 0 ;; esac
case $WAIT_MS in '' | *[!0-9]*) exit 0 ;; esac
[ "$WAIT_MS" -le 600000 ] || WAIT_MS=600000
DEADLINE=$(( $(date +%s) + (WAIT_MS + 999) / 1000 ))
while :; do
  LEFT=$(( DEADLINE - $(date +%s) ))
  [ "$LEFT" -gt 0 ] || exit 0
  SLICE=$LEFT
  [ "$SLICE" -le 25 ] || SLICE=25
  OUT=$(printf '{"requestId":"%s","sliceMs":%s,"input":%s}' "$RID" "$(( SLICE * 1000 ))" "$INPUT" | post '/hook/wait?format=text' "$(( SLICE + 3 ))") || exit 0
  case $OUT in
    pending) ;;
    "decided "*) printf '%s\\n' "\${OUT#decided }"; exit 0 ;;
    *) exit 0 ;;
  esac
done
`;
}

/** Write the script into the state dir (mode 0700). Returns its path. */
export async function writeHookScript(home: string, nodeBin: string, entry: string): Promise<string> {
  const dir = tokenDirectory(home);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new DeskError("denied", "state directory is not allowed");
  const file = hookScriptPath(home);
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new DeskError("denied", "refusing to replace the hook script path");
  } catch (error) {
    if (error instanceof DeskError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(dir, `.${HOOK_SCRIPT_NAME}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700);
  try {
    await handle.writeFile(renderHookScript({ stateDir: dir, nodeBin, entry }), "utf8");
    await handle.chmod(0o700);
  } catch (error) {
    await handle.close();
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  await handle.close();
  await rename(temp, file);
  await chmod(file, 0o700);
  return file;
}

export async function removeHookScript(home: string): Promise<boolean> {
  const file = hookScriptPath(home);
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) return false;
    await unlink(file);
    return true;
  } catch {
    return false;
  }
}
