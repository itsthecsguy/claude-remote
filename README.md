# claude-remote

claude-remote lists Claude Code sessions on this Mac, including sessions started from the Code tab in the Claude desktop app. When send is turned on, it can resume one session through the `claude` CLI. `claude-remote http` serves the same methods on `127.0.0.1`. Each request gets one JSON body. The listener does not use server-sent events.

claude-remote is an unofficial, community-built tool. It is not affiliated with, endorsed by, or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Requirements

- Node.js 20 or newer
- macOS, for the LaunchAgent installer
- Homebrew, so `install` can add `cloudflared` when that binary is not already executable
- The `claude` CLI on `PATH`, or `CLAUDE_REMOTE_CLAUDE_BIN`, because `install` registers the channel command and send or launch runs that CLI
- `tmux`, only when a launch starts a terminal session

`npm test` does not need `claude`, `tmux`, or `cloudflared`.

## Install

Clone the repository and build it:

```bash
git clone https://github.com/itsthecsguy/claude-remote.git
cd claude-remote
npm ci
npm run build
node dist/index.js install
```

`install` builds, writes two LaunchAgents, creates the bearer token, and registers `claude-remote-channel` at user scope when `claude mcp get claude-remote-channel` is not already registered. It prints the token path. It does not print the token. When the tunnel log contains a quick-tunnel URL, it prints that URL.

```bash
node dist/index.js install --dry-run
node dist/index.js install --allow-send --allow-launch
node dist/index.js install --allow-send --allow-launch --port=47321
node dist/index.js status
node dist/index.js rotate-token
node dist/index.js http
```

`--dry-run` prints the plists and writes nothing. Running `install` again keeps the existing token and rewrites the plists. `--allow-send` and `--allow-launch` default to off in the LaunchAgent. Passing them sets `CLAUDE_REMOTE_ALLOW_SEND` and `CLAUDE_REMOTE_ALLOW_LAUNCH` to `1` for the helper only. A foreground `node dist/index.js http` uses the environment of that process instead.

The labels are `com.claude-remote.http` and `com.claude-remote.tunnel`. The plists are `~/Library/LaunchAgents/com.claude-remote.http.plist` and `~/Library/LaunchAgents/com.claude-remote.tunnel.plist`, mode `0600`, with `RunAtLoad` and `KeepAlive`.

## Default port

The default port is `47321`. The listener binds to `127.0.0.1` and rejects any other address. `node dist/index.js http --port=47321` and `node dist/index.js install --port=47321` select another port. `CLAUDE_REMOTE_HTTP_PORT` does the same when the command line does not pass `--port`.

## Auth token

`install` creates `~/.claude-remote/http/token` if that file is missing. `node dist/index.js rotate-token` replaces it. Both commands print the path and not the token.

The token file is mode `0600`. `~/.claude-remote` and `~/.claude-remote/http` are mode `0700`. The listener reads the file on every request, so rotation takes effect without a restart. A missing or wrong token is HTTP 401. The check hashes both values and then uses a constant-time compare.

Send the token only in the `Authorization` header:

```text
Authorization: Bearer <token>
```

There is one space after `Bearer`. `<token>` is the single line in `~/.claude-remote/http/token`.

`status` prints whether the helper and the tunnel are running, the URL, and the token path. It does not print the token.

## Cloudflare tunnel

The listener stays on this Mac. A tunnel only forwards HTTPS to `127.0.0.1`. The bearer token is still required.

The listener allows only localhost names in `Host` and `Origin`. A public hostname in either header is HTTP 403. A missing `Origin` is allowed. `cloudflared` has to set the Host header to `127.0.0.1:47321` (or the port you chose).

### Quick tunnel

`install` starts a Cloudflare quick tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:47321 --http-host-header 127.0.0.1:47321 --no-autoupdate
```

`install` searches `PATH`, `/opt/homebrew/bin`, and `/usr/local/bin` for `cloudflared`. `CLAUDE_REMOTE_CLOUDFLARED_BIN` overrides that search. When none of those is executable, `install` runs `brew install cloudflared`.

Quick tunnels need no Cloudflare account. The tunnel is outbound only. The hostname changes every time the process starts, the URL dies with the process, and there is no uptime guarantee. The URL shape is:

```text
https://<your-tunnel>.trycloudflare.com/mcp
```

After a restart, run `node dist/index.js status` and put the new URL in the client. Quick tunnels do not support server-sent events, which is why this listener answers with one JSON body.

### Named tunnel

A named tunnel keeps a hostname you control. Stop the quick-tunnel LaunchAgent before starting it, so two tunnels are not bound to the same local port:

```bash
launchctl bootout gui/$(id -u)/com.claude-remote.tunnel
cloudflared tunnel login
cloudflared tunnel create claude-remote
cloudflared tunnel route dns claude-remote <your-hostname>
```

`~/.cloudflared/claude-remote.yml`:

```yaml
tunnel: claude-remote
credentials-file: ~/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: <your-hostname>
    service: http://127.0.0.1:47321
    originRequest:
      httpHostHeader: 127.0.0.1:47321
  - service: http_status:404
```

```bash
cloudflared tunnel --config ~/.cloudflared/claude-remote.yml run claude-remote
```

The public URL is `https://<your-hostname>/mcp`. The header is still `Authorization: Bearer <token>`.

## MCP client

In any MCP client that supports a remote server URL with a custom header, add a custom connector named `claude-remote`.

- URL: `https://<host>/mcp`
- Header name: `Authorization`
- Header value: `Bearer <token>`

`<host>` is `<your-tunnel>.trycloudflare.com` for a quick tunnel, or `<your-hostname>` for a named tunnel. `<token>` is the line in `~/.claude-remote/http/token`.

## Tools

These are the method names.

| Method | When it is registered |
| --- | --- |
| `list_sessions` | always |
| `get_session` | always |
| `continue_command` | always. Returns a shell command and does not launch. |
| `rename_session` | always. Reports that no documented route sets the title. It does not edit a transcript. |
| `cleanup_desk` | always. Removes stale channel sockets and expired attachment directories. It does not delete key files. |
| `send_followup` | `CLAUDE_REMOTE_ALLOW_SEND=1`. The call still has to set `confirm` to true. |
| `queue_status` | `CLAUDE_REMOTE_ALLOW_SEND=1` |
| `new_session` | `CLAUDE_REMOTE_ALLOW_LAUNCH=1` |
| `continue_session` | `CLAUDE_REMOTE_ALLOW_LAUNCH=1` |
| `stop_session` | `CLAUDE_REMOTE_ALLOW_LAUNCH=1` |

`install --allow-send` registers `send_followup` and `queue_status`. `install --allow-launch` registers `new_session`, `continue_session`, and `stop_session`. With both flags the registered methods are `list_sessions`, `get_session`, `continue_command`, `rename_session`, `cleanup_desk`, `send_followup`, `queue_status`, `new_session`, `continue_session`, and `stop_session`.

`send_followup` does nothing unless `confirm` is true. `continue_session` refuses a live owner unless `confirmLiveOwner` is true, and it still refuses while that pid is alive. `new_session` and `continue_session` send Enter on the development-channels prompt only when `acceptDevChannelPrompt` is true and the highlighted line is the accept option. Trust, a new MCP server prompt, and the Chrome extension prompt are not answered. If one of those panes is up and no session id has been written yet, the result is `code=blocked-by-dialog` with `dialog` set to `workspace-trust`, `mcp-server`, or `chrome-extension`.

## Safety

`CLAUDE_REMOTE_ALLOW_SEND` and `CLAUDE_REMOTE_ALLOW_LAUNCH` are opt-in. A default `install` leaves both off.

The server does not open `~/.claude/sessions/*.key`, `~/.claude/.credentials.json`, `~/.claude.json`, or anything under `~/.config/anthropic`. A session id that is not a UUID is rejected before any path is joined. A symlink whose target leaves the transcript directory is refused.

Logs may include a tool name, a session id, a ticket id, a duration, an exit code, and a short code such as `unauthorized`, `host-rejected`, `origin-rejected`, `start`, `end`, or `error`. They do not include the bearer token, a header value, a message, transcript text, or file text.

The server does not pass permission-bypass flags. That includes `--dangerously-skip-permissions`, `--permission-mode`, and `--allow-dangerously-skip-permissions`.

`list_sessions` does not stat or resolve a working directory under Desktop, Documents, Downloads, `Library/Mobile Documents`, or `Library/CloudStorage`. Those are the macOS protected folders, including iCloud.

Each `tools/call` has a deadline. The default is 30 seconds. `CLAUDE_REMOTE_CALL_TIMEOUT_MS` can set it from 200 to 60000. On expiry the listener returns one JSON body, JSON-RPC code `-32000`, message `deadline exceeded`.

## Uninstall

```bash
node dist/index.js uninstall --dry-run
node dist/index.js uninstall
node dist/index.js uninstall --purge
```

`uninstall` runs `launchctl bootout` for both LaunchAgents, deletes the plists, the token, the port file, and the tunnel log, and runs `claude mcp remove --scope user claude-remote-channel`. It leaves attachments, the queue, the inbox, and session files in place. `uninstall --purge` also removes those claude-remote directories. Neither command opens or deletes a `.key` file.

You can also stop the jobs directly:

```bash
launchctl bootout gui/$(id -u)/com.claude-remote.http
launchctl bootout gui/$(id -u)/com.claude-remote.tunnel
```

## Develop

```bash
npm test
```

`npm test` typechecks and runs the unit tests, including a clean-machine check that starts the HTTP server with an empty `HOME` and expects `initialize` plus `list_sessions` to return an empty list.

## License

MIT. See `LICENSE`.
