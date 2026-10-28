# claude-remote

[![ci](https://github.com/itsthecsguy/claude-remote/actions/workflows/ci.yml/badge.svg)](https://github.com/itsthecsguy/claude-remote/actions/workflows/ci.yml)

claude-remote lists Claude Code sessions on this Mac, including sessions started from the Code tab in the Claude desktop app. When send is turned on, it can resume one session through the `claude` CLI. `claude-remote http` serves the same methods on `127.0.0.1`. Each request gets one JSON body. The listener does not use server-sent events.

claude-remote is an unofficial, community-built tool. It is not affiliated with, endorsed by, or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Requirements

- Node.js 20 or newer
- macOS, for the LaunchAgent installer
- Homebrew, so `install` can add `cloudflared` when that binary is not already executable
- The `claude` CLI on `PATH`, or `CLAUDE_REMOTE_CLAUDE_BIN`, because `install` registers the channel command and send or launch runs that CLI
- `tmux`, only when a launch starts a terminal session
- Tailscale, only for `install --tunnel=funnel`

`npm test` does not need `claude`, `tmux`, `cloudflared`, or `tailscale`.

## Install

Clone the repository and build it:

```bash
git clone https://github.com/itsthecsguy/claude-remote.git
cd claude-remote
npm ci
npm run build
node dist/index.js install
```

`install` builds, writes three LaunchAgents (the helper, the tunnel, and a watchdog), creates the bearer token, and registers `claude-remote-channel` at user scope when `claude mcp get claude-remote-channel` is not already registered. It prints the token path. It does not print the token. When the tunnel log contains a quick-tunnel URL, it prints that URL; with a fixed hostname it prints that.

```bash
node dist/index.js install --dry-run
node dist/index.js install --allow-send --allow-launch
node dist/index.js install --allow-send --allow-launch --port=47321
node dist/index.js install --allow-send --allow-launch --allow-approve
node dist/index.js install --no-hooks
node dist/index.js install --tunnel=named --tunnel-name=claude-remote --hostname=remote.example.com
node dist/index.js install --tunnel=funnel
node dist/index.js install --no-watchdog
node dist/index.js status
node dist/index.js status --json
node dist/index.js watchdog
node dist/index.js rotate-token
node dist/index.js http
```

`--tunnel=quick|named|token|funnel|none` picks how the helper is reached from outside (default `quick`); see [Stable endpoint](#stable-endpoint). `--no-watchdog` skips the watchdog agent and `--watchdog-interval=<seconds>` (30 to 3600, default 120) sets how often it runs; see [Watchdog](#watchdog).

`install` resolves `claude` (or `CLAUDE_REMOTE_CLAUDE_BIN`) against the installing shell's `PATH` and writes the absolute path into the helper plist as `CLAUDE_REMOTE_CLAUDE_BIN`, because launchd starts the helper with a fixed `PATH` that usually lacks `~/.local/bin`. `--dry-run` prints the plists and writes nothing. Running `install` again keeps the existing token and rewrites the plists. It always reloads the helper, but leaves a loaded tunnel running when the tunnel plist is unchanged, so a quick-tunnel URL survives a reinstall. `--allow-send` and `--allow-launch` default to off in the LaunchAgent. Passing them sets `CLAUDE_REMOTE_ALLOW_SEND` and `CLAUDE_REMOTE_ALLOW_LAUNCH` to `1` for the helper only. A foreground `node dist/index.js http` uses the environment of that process instead.

`install` also merges the claude-remote hooks into Claude Code's user settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`); see [Hooks](#hooks-pending-questions-and-remote-answers). `--no-hooks` skips that. `--allow-approve` sets `CLAUDE_REMOTE_ALLOW_APPROVE=1` for the helper, and `--approve-timeout=<seconds>` (5 to 600, default 120) sets how long a permission or question hook waits for a remote answer.

The labels are `com.claude-remote.http`, `com.claude-remote.tunnel`, and `com.claude-remote.watchdog`. The plists are under `~/Library/LaunchAgents/` with those names, mode `0600`. The helper and tunnel have `RunAtLoad` and `KeepAlive`; the watchdog has `RunAtLoad` and a `StartInterval`. `--tunnel=funnel` and `--tunnel=none` write no tunnel plist and remove one left by an earlier install.

## Upgrading an existing install

1. In the install directory, pull the new version and build it: `git pull && npm ci && npm run build`.
2. Optional: give the helper a long-lived login. Run `claude setup-token`, then paste the token into `(umask 077 && mkdir -p ~/.config/claude-remote && cat > ~/.config/claude-remote/oauth-token)` and press Enter, then Ctrl-D. Skip this and you keep the periodic login prompt; see [Long-lived login for headless claude children](#long-lived-login-for-headless-claude-children).
3. Re-run `install` with the flags you used before, including `--notify-url` (and `CLAUDE_REMOTE_NOTIFY_SECRET` in the environment) if you use alerts. An `install` without `--notify-url` turns alerts off. This adds the watchdog agent and reloads the helper. A quick tunnel keeps its hostname, because its plist does not change.
4. Optional: add `--tunnel=named --tunnel-name=<name> --hostname=<host>` or `--tunnel=funnel` for a URL that never changes; see [Stable endpoint](#stable-endpoint).
5. Run `node dist/index.js status` and expect `verdict=ok` and `watchdog=loaded`.
6. Update the connector URL in the client only if `status` prints a different one. The bearer token does not change.

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

## Status

`status` checks each part on its own and says which one is down. It does not print the bearer token or the setup-token.

```text
verdict=public-not-answering
helper=running pid=1380 answers=yes
tunnel=running mode=quick pid=9688 runs=2 lastExit=0
tunnelConnected=no lastRegistered=2026-10-24T21:50:11Z lastRetry=2026-10-26T19:14:20Z retries10m=9 logBytes=14336831
url=https://mood-precise-long-gregory.trycloudflare.com/mcp
public=no detail=tunnel-error:http-530
tokenPath=/Users/nick/.claude-remote/http/token
tokenFile=present
port=47321
oauthTokenPath=/Users/nick/.config/claude-remote/oauth-token
oauthTokenFile=present mode=0600 ageDays=12
watchdog=loaded lastRun=2026-10-27T22:58:03.120Z lastVerdict=tunnel-failing helperRestarts=0 tunnelRestarts=1
checkedAt=2026-10-27T22:59:41.004Z
```

`verdict` is the first thing that is wrong, in this order: `helper-not-loaded` (launchd does not have the helper), `helper-not-answering` (launchd has it, but `GET http://127.0.0.1:<port>/mcp` did not get the helper's 401 challenge), `tunnel-not-loaded` (no cloudflared job, for the quick, named, and token modes), `no-public-url` (a quick tunnel that has not printed a hostname yet), `public-not-answering` (the public URL did not get the helper's challenge; `detail` says what answered instead), or `ok`. `ok-no-tunnel` is `--tunnel=none`.

The probes send no credentials. The helper answers an unauthenticated `GET /mcp` with `401` and `WWW-Authenticate: Bearer realm="claude-remote"`, and that exact reply is what counts as "answers". `detail` values: `tunnel-error:http-530` means Cloudflare's edge answered for a tunnel that is not connected, `host-rejected` means the request reached the helper with a Host header it does not accept (see `CLAUDE_REMOTE_PUBLIC_HOST`), `unreachable:ENOTFOUND` means DNS failed on this Mac, and `unreachable:timeout` means nothing answered.

The `tunnelConnected` line comes from the last megabyte of `~/.claude-remote/tunnel/cloudflared.log`: when cloudflared last registered a connection, when it last scheduled a retry, and how many retries fell in the last ten minutes. `url` for a quick tunnel is the newest hostname in that tail. Earlier versions read the first megabyte, which named a hostname that had been dead for days once the log grew past that.

`status --no-probe` skips both HTTP probes, as does `CLAUDE_REMOTE_PROBE=0`. `status --json` prints the same fields as one object.

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

There is a worse failure than a restart. When the Mac sleeps long enough for Cloudflare's edge to forget the quick tunnel, the running `cloudflared` never gets it back: every reconnect fails with `control stream encountered a failure while serving`, it retries every 64 seconds, and because the process never exits, launchd's `KeepAlive` never restarts it. One such episode lasted 44 hours and 9,543 retries, most of them while the Mac was awake and online. A named tunnel does not have this problem, because its registration survives a disconnect. The [watchdog](#watchdog) covers the quick tunnel by restarting it, at the cost of a new hostname.

## Stable endpoint

`--tunnel=named`, `--tunnel=token`, and `--tunnel=funnel` give the helper a hostname that survives restarts, sleep, and network changes, so the client is set up once. `install` records the choice in `~/.claude-remote/tunnel/settings.json` (mode `0600`) and `status` and the watchdog read it from there. Switching modes is another `install` with other flags.

With a fixed hostname, `install` also sets `CLAUDE_REMOTE_PUBLIC_HOST=<hostname>` for the helper, and the listener accepts that name in `Host` and `Origin` in addition to the localhost names. A foreground `node dist/index.js http` can set the variable itself (a comma-separated list is allowed).

### Named tunnel (Cloudflare account, hostname you own)

Create the tunnel once with your own `cloudflared`, then let `install` run it:

```bash
cloudflared tunnel login
cloudflared tunnel create claude-remote
cloudflared tunnel route dns claude-remote remote.example.com
node dist/index.js install --allow-send --allow-launch --tunnel=named --tunnel-name=claude-remote --hostname=remote.example.com
```

`install` writes `~/.claude-remote/tunnel/named.yml` with the ingress below and starts `cloudflared tunnel --no-autoupdate --logfile <log> --config <that file> run claude-remote` from the tunnel LaunchAgent. `cloudflared` finds the tunnel credentials through `~/.cloudflared/cert.pem`; pass `--tunnel-credentials=~/.cloudflared/<tunnel-id>.json` to name the file instead.

```yaml
tunnel: "claude-remote"
ingress:
  - hostname: "remote.example.com"
    service: http://127.0.0.1:47321
    originRequest:
      httpHostHeader: "127.0.0.1:47321"
  - service: http_status:404
```

The public URL is `https://remote.example.com/mcp`. The header is still `Authorization: Bearer <token>`. Put the hostname behind Cloudflare Access if you want a second factor in front of the bearer token.

### Token tunnel (Zero Trust dashboard)

A tunnel created in the Cloudflare Zero Trust dashboard runs from a token. Put the token in a file only you can read, and never on the command line:

```bash
(umask 077 && mkdir -p ~/.config/claude-remote && cat > ~/.config/claude-remote/tunnel-token)
node dist/index.js install --tunnel=token --hostname=remote.example.com --tunnel-token-file=~/.config/claude-remote/tunnel-token
```

The LaunchAgent runs `cloudflared tunnel --no-autoupdate --logfile <log> run --token-file <that file>` (needs cloudflared 2025.4.0 or newer). The dashboard's public hostname must route to `http://127.0.0.1:47321`, and either its HTTP Host header setting is `127.0.0.1:47321` or the helper accepts the public name through `CLAUDE_REMOTE_PUBLIC_HOST`, which `install` sets from `--hostname`.

### Tailscale Funnel

Funnel publishes the helper on this node's MagicDNS name, over Tailscale's relay, with no Cloudflare account. Funnel has to be enabled for the node in the Tailscale admin console first.

```bash
node dist/index.js install --allow-send --allow-launch --tunnel=funnel
```

`install` finds the `tailscale` CLI on `PATH` or in `/Applications/Tailscale.app/Contents/MacOS` (`CLAUDE_REMOTE_TAILSCALE_BIN` overrides that), reads the node name from `tailscale status --json` unless `--hostname=<node>.<tailnet>.ts.net` is given, and runs:

```bash
tailscale funnel --bg --https=443 http://127.0.0.1:47321
```

tailscaled keeps that configuration across reboots, so there is no tunnel LaunchAgent in this mode, and the watchdog only reports a Funnel it cannot reach. The public URL is `https://<node>.<tailnet>.ts.net/mcp`. `uninstall` runs the same command with `off`.

### No tunnel

`--tunnel=none` manages no tunnel at all, for a reverse proxy you run yourself. Add `--hostname=<name>` so the helper accepts that name in `Host`. `status` then reports `ok-no-tunnel` and the watchdog only watches the helper.

## Watchdog

`com.claude-remote.watchdog` runs `node dist/index.js watchdog` every 120 seconds (`--watchdog-interval`) and after every wake, because launchd fires a missed `StartInterval` once when the Mac wakes. Each run:

1. Probes `http://127.0.0.1:<port>/mcp`. If the helper does not answer with its 401 challenge, it runs `launchctl kickstart -k gui/<uid>/com.claude-remote.http` (or `bootstrap` when the job is not loaded) and stops there for this run.
2. Works out the public URL: the fixed hostname, or the newest `trycloudflare.com` name in the tunnel log.
3. Probes that URL the same way. One failure is counted; two in a row, while the helper answers, restart the tunnel job the same way. A DNS failure on this Mac (`ENOTFOUND`) counts as offline and never restarts anything, and restarts are at least ten minutes apart, so a dead internet connection does not burn through hostnames.
4. After a quick-tunnel restart, waits up to 15 seconds for the new hostname, and POSTs `{"type":"claude-remote.tunnel","event":"url-changed","url":...,"previousUrl":...}` to the alert URL from `--notify-url`, signed like the pending alerts, so a phone can pick up the new URL. A named or token tunnel sends `tunnel-restarted` with the same URL.
5. Trims `cloudflared.log`, `helper.log`, and its own `watchdog.log` when one passes 8 MB: the last 512 KB go to `<name>.1` and the file is truncated in place. `cloudflared --logfile` never rotates on its own, and the quick-tunnel retry loop wrote 14 MB in two days.

Its state is `~/.claude-remote/watchdog/state.json` (last run, last verdict, consecutive public failures, restart counts) and `status` shows it. Each run logs one line to `~/.claude-remote/watchdog/watchdog.log`, with the probe outcomes and never a token. `node dist/index.js watchdog` runs one pass by hand and prints the same report (`--json` for the object).

## Sleep and network changes

Nothing here can keep a tunnel up through sleep: a MacBook on battery with the lid closed drops its network, and `cloudflared` cannot reconnect until the Mac wakes. What the watchdog guarantees is recovery: within one interval of the Mac being awake and online, the helper and the tunnel are either answering or restarted, and a quick tunnel that the edge has forgotten gets a new hostname instead of retrying forever. Short sleeps are fine without a restart, because `cloudflared` reconnects on its own as long as the edge still has the tunnel; the logs show that taking one to four seconds after a wake.

To keep the Mac awake on power, `sudo pmset -c sleep 0` and a closed lid on power with an external display, or `caffeinate -s`, are the usual choices. Those are Nick's call, not something `install` sets.

## Long-lived login for headless claude children

The helper runs from launchd. Its headless children (`claude -p` for `new_session` with a `prompt`, `send_followup` when it resumes a closed session, `deliver_message`, and `claude agents --json`) use the login that `/login` saved. That login has a lifetime: the Claude Code docs say that once the stored login expires and cannot be refreshed, each request fails with `Login expired · Please run /login`, and the terminal warns three days ahead. For a process nobody is watching, that means a sign-in at the keyboard every time it runs out.

The documented fix for unattended use is `claude setup-token`: it prints a one-year OAuth token that the CLI reads from `CLAUDE_CODE_OAUTH_TOKEN` (precedence 5, above the `/login` credential). The helper reads that token from a file at every spawn and puts it in the child's environment only. It is never written to a plist, never logged, and never printed by `status`.

Create the file once. The token goes in through stdin so it stays out of shell history and the process list:

```bash
claude setup-token
# approve in the browser, copy the printed token, then:
(umask 077 && mkdir -p ~/.config/claude-remote && cat > ~/.config/claude-remote/oauth-token)
# paste the token, press Enter, then Ctrl-D
node dist/index.js status | grep oauthToken
```

The file must be a regular file, mode `0600`, holding the token on its first line. Anything else is ignored and `status` says why: `oauthTokenFile=bad-mode` (run `chmod 600`), `symlink`, `empty`, or `bad-shape`. `oauthTokenFile=missing` means the children keep using the interactive login. `ageDays` counts from the file's last write; at 330 days `status` adds a warning, because the token lasts one year. Replace it by running `claude setup-token` again and overwriting the file; no restart is needed, the helper reads the file at each spawn. The helper log records `{"tool":"oauth-token","code":"file-used"}` once per process when the file is in use, or `ignored-<state>` when it is not.

`CLAUDE_REMOTE_OAUTH_TOKEN_FILE` moves the file for a foreground `http`. A `CLAUDE_CODE_OAUTH_TOKEN` already in the helper's own environment wins over the file. The setup-token login makes model requests only; the docs note it cannot establish Remote Control sessions or fetch claude.ai connectors, which the helper does not need. Interactive sessions started in tmux or Terminal keep using your normal login.

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
| `deliver_message` | `CLAUDE_REMOTE_ALLOW_DELIVER=1`. Experimental. The call still has to set `confirm` to true. |
| `list_pending` | always. Empty unless the hooks are installed and the HTTP helper is the process they report to. |
| `answer_permission` | `CLAUDE_REMOTE_ALLOW_APPROVE=1`. The call still has to set `confirm` to true. |
| `answer_question` | `CLAUDE_REMOTE_ALLOW_APPROVE=1`. The call still has to set `confirm` to true. |

`install --allow-send` registers `send_followup` and `queue_status`. `install --allow-launch` registers `new_session`, `continue_session`, and `stop_session`. `install --allow-approve` registers `answer_permission` and `answer_question`. With both flags the registered methods are `list_sessions`, `get_session`, `continue_command`, `rename_session`, `cleanup_desk`, `send_followup`, `queue_status`, `new_session`, `continue_session`, `stop_session`, and `list_pending`.

`deliver_message` is not part of either install flag. `install` never sets `CLAUDE_REMOTE_ALLOW_DELIVER`, so it is only registered when you export it yourself for a foreground `http`.

`send_followup` does nothing unless `confirm` is true. `continue_session` refuses a live owner unless `confirmLiveOwner` is true, and it still refuses while that pid is alive. `new_session` and `continue_session` send Enter on the development-channels prompt only when `acceptDevChannelPrompt` is true and the highlighted line is the accept option. Trust, a new MCP server prompt, and the Chrome extension prompt are not answered. If one of those panes is up and no session id has been written yet, the result is `code=blocked-by-dialog` with `dialog` set to `workspace-trust`, `mcp-server`, or `chrome-extension`.

## Session status

`list_sessions` and `get_session` read status from `claude agents --json --all`, which the Claude Code docs name as the supported way to read session state from outside Claude Code. Each card has a `status` object:

| `claude agents --json` | `status.value` |
| --- | --- |
| `status: busy` | `working` |
| `status: waiting` | `needs-you`, with `waitingFor` (`permission prompt`, `input needed`, `sandbox request`, `worker request`, `dialog open`, or `other`) |
| `status: idle` | `idle` |
| background `state: working` | `working` |
| background `state: blocked` | `needs-you` |
| background `state: done` | `idle` |
| background `state: failed` or `stopped` | `failed` or `stopped` |
| not listed, transcript closed | `not-running` |

A background session uses `state`. `status.source` is `agents-json` when the value came from that command. Only `kind`, `pid`, `sessionId`, `id`, `status`, `state`, and `waitingFor` are kept from its output; `cwd` and `name` are dropped. When the command is missing, fails, times out, or prints something that is not a JSON array (an older CLI), the server falls back: a live session uses the `status` token in `~/.claude/sessions/<pid>.json` mapped the same way (`source: sessions-file`), and anything else uses the run state (`source: fallback`). `CLAUDE_REMOTE_AGENTS_JSON=0` turns the command off. The `stuck` line in `get_session` follows `status` when it came from `agents-json`, and keeps the transcript-tail heuristic otherwise. The `observedStatus` field on a `handed` send uses the same values.

While a process is live, `process` carries what `claude agents --json` does not: `entrypoint` (`desktop`, `terminal`, `other`), `tmux`, `bridgeSessionId`, and `messagingSocketPath`, read from `~/.claude/sessions/<pid>.json`.

## Sub-sessions

Each card lists subagent transcripts under `~/.claude/projects/<project>/<sessionId>/subagents/agent-<id>.jsonl` as `subSessions`, newest first. A row has `agentId`, `agentType`, `isFork`, `spawnDepth`, `finished`, `parentAgentId`, `worktree`, `sizeBytes`, and `lastActivity`. They come from the file's stat and its `agent-<id>.meta.json` sidecar. The subagent transcript itself is never opened, and the meta `description` is not returned. `list_sessions` shows up to 20 rows per card, and `subSessionCount` is the total. `get_session` returns every row. Symlinked files or folders are skipped.

## Launch options

`new_session` takes these optional fields. Each one is checked before anything runs, and every value is passed as its own argv entry, never through a shell.

| Field | What it runs |
| --- | --- |
| `worktree` | `true` adds `--worktree`. A name (letters, digits, `.`, `-`, `_`, up to 64, starting with a letter or digit) adds `--worktree <name>`. |
| `fastMode` | `true` adds `--settings '{"fastMode":true}'`. Off unless set, because fast mode bills extra usage. That exact value is the only `--settings` value the server will pass. |
| `prompt` | Starts a headless `claude -p --output-format stream-json --verbose` session with the prompt on stdin, reads the `system/init` event, and returns the session id and `fastMode.state` (`fast_mode_state`: `on`, `off`, or `cooldown`) with `fastMode.disabledReason`. The process keeps running detached; its output is dropped. `stop_session` can end it. |
| `cloud` | A task description. Runs `claude --cloud "<description>"` in tmux, because that form needs a terminal, and returns `cloudSessionId` and `cloudUrl` once the CLI prints them. A description that starts with `-`, or looks like `session_...`, `cse_...`, or a URL, is refused, since that form sends into an existing cloud session. |
| `environment` | A `ccpool_` id. Needs `cloud`. Runs `claude -p "<description>" --environment <id> --output-format json` and returns the session id from `{ok, session_id, url}`. |

An interactive launch has no init event, so `fastMode.state` is `null` there and `fastMode.source` is `no-init-event`. `cloud` does not combine with `worktree`, `fastMode`, or `prompt`.

`claude --worktree` refuses to run in a folder whose workspace trust has not been accepted yet. An interactive launch then fails with `session-unobserved` and a hint. Headless (`prompt`) launches skip the trust dialog, as `claude -p` always does, and do create the worktree. To fix it, open `claude` in that folder once and accept the trust dialog. The launcher never accepts trust for you. In headless runs the init event reports `fast_mode_state: "off"` with `fast_mode_disabled_reason: "sdk_opt_in_required"` unless `fastMode: true` is set.

## Hooks: pending questions and remote answers

`claude agents --json` only says that a session needs you and why (`waitingFor`). The hooks add what it is waiting on, and let an authenticated client answer a permission prompt or an `AskUserQuestion` question remotely.

`install` adds one command handler per event below to the user `settings.json`. Each runs `/bin/sh ~/.claude-remote/http/hook.sh --from=claude-remote` in exec form; the script is described below the table. Before it edits the file, `install` copies it to `settings.json.bak-claude-remote-<UTC timestamp>` (mode `0600`). The merge is done in code: every other key and every other hook stays as it was, a second `install` changes nothing, and `uninstall` removes exactly the handlers that carry `--from=claude-remote`, again after a backup. A symlinked `settings.json` is edited at its target. A file that is not valid JSON is left alone, and the error does not quote it. The file can hold secrets in `env`, so it is never printed.

| Event | Matcher | Mode | What the helper does |
| --- | --- | --- | --- |
| `Notification` | all types | blocking, 5 s timeout | Records `message`, `title`, and `notification_type` (`permission_prompt`, `idle_prompt`, `elicitation_dialog`, ...) as a pending notification. |
| `PermissionRequest` | all tools | blocking, approve timeout + 15 s | Records the tool name and a summary of `tool_input`. With approve on, the hook waits for `answer_permission`. |
| `PreToolUse` | `AskUserQuestion` | blocking, approve timeout + 15 s | Records the questions, headers, and options. With approve on, the hook waits for `answer_question`. |
| `PostToolUse`, `PostToolUseFailure`, `PermissionDenied` | all tools | `async` | Clears the matching permission or question (same `tool_use_id`, or same tool and input). |
| `UserPromptSubmit`, `Stop`, `StopFailure`, `SessionEnd` | - | `async` | Clears everything pending for the session. |

`install` writes `~/.claude-remote/http/hook.sh` (mode `0700`), a POSIX `sh` script that forwards each event with the system `curl`, so an event costs a shell and a `curl` rather than a Node start. It behaves like `claude-remote hook`: the same endpoints (in a plain-text variant, `?format=text`), the same 1.5-second registration timeout, the same long-poll for permission requests and questions, and the same fail-open exit 0 with no output when the token is missing, the helper is down, or anything else goes wrong. The helper builds the decision JSON for it with the code the Node hook uses, so both print the same output. The script reads the token with the shell's `read` and gives it to `curl` as a config file on a pipe (`-K /dev/fd/3`), so the token never appears in a process argument list, and it keeps the hook JSON in memory rather than on disk. It reads stdin to the end before doing anything else; a stdin that never closes is ended by the hook timeout in `settings.json`. If `curl` is not on `PATH`, the script runs `node <install>/dist/index.js hook` instead. `uninstall` deletes the script.

`claude-remote hook` reads the hook JSON on stdin and POSTs it to `http://127.0.0.1:<port>/hook/event` with the bearer token from `~/.claude-remote/http/token`. It fails open: if the token is missing, the helper is down or does not answer within 1.5 seconds, or anything else goes wrong, it exits 0 with no output, which Claude Code treats as no decision. A watchdog ends the process after 2.5 seconds unless it is waiting for an answer. The hook loads only Node built-ins, so it starts quickly. The `/hook/*` endpoints need the same token and refuse any request that carries Cloudflare or proxy forwarding headers, so they cannot be reached through the tunnel.

Pending entries live in the HTTP helper's memory and in `~/.claude-remote/http/pending.json`, so a helper restart keeps them. The file is mode `0600`, written to a temp file and renamed, and saved a moment after each change. It holds the same text `list_pending` returns (questions, notification messages, a summary of tool input), so it is never logged or printed, and `uninstall` deletes it. On start the helper drops saved entries whose session is no longer live in `~/.claude/sessions`, permission requests and questions older than the approve timeout, and anything older than two hours. Nothing restored from the file is `answerable`: the hook that was waiting gave up when the helper stopped, and the prompt fell back to the app or terminal. They show up as `pending` on each `list_sessions` and `get_session` card and in `list_pending`, with a `requestId`, `kind` (`permission`, `question`, or `notification`), the text, and `answerable`. An entry goes away on the next prompt, a matching tool result, a stop, or when the session stops running; notifications also go when the session is working again.

### Remote answers

With `CLAUDE_REMOTE_ALLOW_APPROVE=1`, a `PermissionRequest` or `AskUserQuestion` hook long-polls the helper in slices of up to 25 seconds, until the approve timeout (`CLAUDE_REMOTE_APPROVE_TIMEOUT_S`, default 120). If no answer comes, it exits with no decision and the normal prompt in the app or terminal takes over. A prompt answered locally first releases the waiting hook through the clearing events.

* `answer_permission` takes `sessionId`, `requestId`, `decision` (`allow` or `deny`), an optional `message` for a deny, and `confirm: true`. The hook prints only `{"behavior":"allow"}` or `{"behavior":"deny","message":...}`. It never returns `updatedPermissions`, so a remote answer cannot add an always-allow rule or change the permission mode (including `bypassPermissions`), and it never returns `updatedInput`, so the tool runs with the input Claude asked for. Deny and ask rules in settings still apply after an allow.
* `answer_question` takes `sessionId`, `requestId`, `answers` (each question's exact text mapped to the chosen label, labels joined with commas for multi-select, or free text), and `confirm: true`. Every question must be answered. The hook returns `permissionDecision: "allow"` with `updatedInput` set to the original questions plus `answers`, which is the documented way to answer `AskUserQuestion` from a hook.

Per the Claude Code hook docs, the terminal runs the `PermissionRequest` hook before it shows its own dialog, so with approve on the local prompt is expected to appear only after the remote window closes (this ordering has been checked with `claude -p`, not in an interactive terminal). In the Desktop app, which hosts Claude Code through the SDK permission callback, the hook runs alongside the app's own prompt and whichever answers first wins. Keep the timeout short if you also answer locally. Without approve the hooks only report, and return at once. In `claude -p` runs there is no local prompt: if nobody answers in time, Claude Code denies the call, and `AskUserQuestion` is not offered at all.

A question can also be answered by sending a normal message (`send_followup` or `deliver_message`) once the question has timed out to the normal prompt.

### Push alerts

The helper can POST a small JSON event to a URL of your choice when a new pending entry appears, so a phone or a webhook-triggered routine hears about a waiting prompt without polling `list_pending`. It is off unless configured.

```bash
CLAUDE_REMOTE_NOTIFY_SECRET='<16+ characters>' node dist/index.js install --allow-approve --notify-url=https://example.com/hooks/claude
node dist/index.js install --notify-url=https://example.com/hooks/claude --notify-include-text --notify-cleared
```

`install` writes the URL and secret to `~/.claude-remote/http/notify.json` (mode `0600`); neither goes in the plist. The secret can also be passed as `--notify-secret=<value>`, but the environment keeps it out of the process list and shell history. Running `install` without `--notify-url` turns alerts off and deletes the file, and `uninstall` deletes it too. A foreground `node dist/index.js http` also reads `CLAUDE_REMOTE_NOTIFY_URL`, `CLAUDE_REMOTE_NOTIFY_SECRET`, `CLAUDE_REMOTE_NOTIFY_AUTH`, `CLAUDE_REMOTE_NOTIFY_INCLUDE_TEXT`, and `CLAUDE_REMOTE_NOTIFY_CLEARED`, which take precedence over the file. The URL must be `https`, or `http` to `127.0.0.1` or `localhost`.

Each new permission request, question, or notification produces exactly one `pending` event. The `permission_prompt` notification Claude Code sends a few seconds after a permission request is not sent again. With `--notify-cleared` the endpoint also gets one `cleared` event when an alerted entry goes away. The body is:

```json
{"type":"claude-remote.pending","event":"pending","eventId":"<requestId>.pending","requestId":"...","sessionId":"...","projectName":"my-app","kind":"permission","toolName":"Bash","notificationType":null,"createdAt":"...","sentAt":"...","answerable":true}
```

The question, message, or tool-input text is left out unless `--notify-include-text` (`CLAUDE_REMOTE_NOTIFY_INCLUDE_TEXT=1`) adds `text`, `title`, and `questions`. Pass `requestId` and `sessionId` to `get_session`, `list_pending`, or `answer_permission`.

With a secret, each request carries `X-Claude-Remote-Timestamp` (Unix seconds) and `X-Claude-Remote-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" keyed by the secret>`. Check it with a constant-time compare and reject old timestamps. `--notify-auth=bearer` sends `Authorization: Bearer <secret>` instead, for receivers that can only match a static header. `X-Claude-Remote-Delivery` repeats `eventId` for deduplication.

Delivery is fire-and-forget: a 3-second timeout, two retries (after 0.5 and 2 seconds) on a network error, 429, or 5xx, no redirects, and at most 100 queued events. A hook never waits for it. Logs record only `sent`, `failed-<status>`, or `dropped`, never the URL, the secret, or any text.

## Deliver a message to a live session (experimental)

`deliver_message` puts text in the cross-session inbox of a live session, including a session open in the Desktop app, without resuming it or closing the app. It uses the documented route: a short `claude -p` worker whose only tool is `SendMessage` (`--tools SendMessage --strict-mcp-config --no-session-persistence`) is asked to send the text to `uds:<messagingSocketPath>` from the target's `~/.claude/sessions/<pid>.json`. The text goes to the worker on stdin. The server never writes to the socket itself, because that format is not documented.

The result is `delivered` only when the worker made exactly one `SendMessage` call, to that address, and the call reported success. `verbatim` says whether the sent text matched. The receiving session still applies its own inbound rules. A session that prompts for permissions takes the message; a session that bypasses permission prompts holds it, and a Desktop or `-p` session cannot show the approval dialog, so a held message expires after five minutes by default. `delivered` means the message reached the inbox, not that Claude has read it. The worker is a model call: the text is fenced and the worker is told not to follow instructions inside it, and the result checks the target, but a worker run costs a small amount of usage.

## Safety

`CLAUDE_REMOTE_ALLOW_SEND`, `CLAUDE_REMOTE_ALLOW_LAUNCH`, `CLAUDE_REMOTE_ALLOW_APPROVE`, and `CLAUDE_REMOTE_ALLOW_DELIVER` are opt-in. A default `install` leaves them off. `send_followup`, `deliver_message`, `answer_permission`, and `answer_question` also need `confirm: true` on every call.

The server does not open `~/.claude/sessions/*.key`, `~/.claude/.credentials.json`, `~/.claude.json`, or anything under `~/.config/anthropic`. A session id that is not a UUID is rejected before any path is joined. A symlink whose target leaves the transcript directory is refused.

Logs may include a UTC timestamp, a tool name, a session id, a ticket id, a duration, an exit code, and a short code such as `unauthorized`, `host-rejected`, `origin-rejected`, `start`, `end`, or `error`. They do not include the bearer token, the setup-token, a header value, a message, transcript text, file text, or any hook payload: a hook event is logged as its event name and `recorded` or `wait`, and an answer as its decision. The watchdog log holds probe outcomes and tunnel hostnames.

The server does not pass permission-bypass flags. That includes `--dangerously-skip-permissions`, `--permission-mode`, and `--allow-dangerously-skip-permissions`. `--settings` is refused unless its value is exactly `{"fastMode":true}`.

`list_sessions` does not stat or resolve a working directory under Desktop, Documents, Downloads, `Library/Mobile Documents`, or `Library/CloudStorage`. Those are the macOS protected folders, including iCloud.

Each `tools/call` has a deadline. The default is 30 seconds. `CLAUDE_REMOTE_CALL_TIMEOUT_MS` can set it from 200 to 60000. On expiry the listener returns one JSON body, JSON-RPC code `-32000`, message `deadline exceeded`.

## Uninstall

```bash
node dist/index.js uninstall --dry-run
node dist/index.js uninstall
node dist/index.js uninstall --purge
```

`uninstall` runs `launchctl bootout` for all three LaunchAgents, deletes the plists, the token, the port file, the tunnel settings and named config, the watchdog state, and the logs, runs `claude mcp remove --scope user claude-remote-channel`, and removes the claude-remote hook handlers from the user `settings.json` after backing it up. In Funnel mode it also runs `tailscale funnel ... off`. It leaves attachments, the queue, the inbox, session files, and `~/.config/claude-remote/oauth-token` in place. `uninstall --purge` also removes the claude-remote directories under `~/.claude-remote`. Neither command opens or deletes a `.key` file.

You can also stop the jobs directly:

```bash
launchctl bootout gui/$(id -u)/com.claude-remote.http
launchctl bootout gui/$(id -u)/com.claude-remote.tunnel
launchctl bootout gui/$(id -u)/com.claude-remote.watchdog
```

## Develop

```bash
npm test
```

`npm test` typechecks and runs the unit tests, including a clean-machine check that starts the HTTP server with an empty `HOME` and expects `initialize` plus `list_sessions` to return an empty list.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build`, `npm test`, and `npm run test:portable` on macOS and Ubuntu with Node 20, 22, and 24, on every push and pull request. It has read-only repository access and uses no secrets.

## License

MIT. See `LICENSE`.
