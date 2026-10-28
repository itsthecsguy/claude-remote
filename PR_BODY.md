# Make the connector reliable: watchdog, stable endpoint, honest status, long-lived login

Two problems, two root causes, both found in the logs on the Mac that runs this.

## Problem 1: the connector drops while the Mac is online

### Root cause

A Cloudflare quick tunnel that the edge has forgotten can never be re-registered by the running `cloudflared`, and nothing restarts the process because it never exits.

### Evidence

All of this is from `~/.claude-remote/tunnel/cloudflared.log` (14.3 MB, 95,752 lines, never rotated) and `pmset -g log`. Times are UTC unless marked local (PDT).

- Four quick tunnels since Oct 18, so four hostnames: Oct 18 04:02, Oct 19 07:46, Oct 24 04:31, Oct 26 19:14. Each one came from a process start (`Generated Connector ID` appears exactly four times). The last two were the two `install` re-runs; that is the "URL changes on every restart" half of the lead, and it is real but it is not what caused the long outage.
- One outage of 44 hours. From 2026-10-24T22:08Z to 2026-10-26T19:14Z the log holds 9,543 `Retrying connection in up to 1m4s` lines, each preceded by `failed to serve tunnel connection error="control stream encountered a failure while serving"`. About 225 per hour, one every 64 seconds, with zero `Registered tunnel connection` in between. It ended only when `install` ran at 19:14Z (`Initiating graceful shutdown due to signal terminated`) and the new process asked for a new quick tunnel.
- The Mac was asleep for the start of it and awake for most of it. `pmset -g log`: clamshell sleep on battery at 14:40 local on Oct 24, dark-wake and sleep cycles every 15 minutes, lid open at 18:16 local. The first `1m4s` retry is at 15:08 local, inside one of those dark wakes. From 18:16 local on Oct 24 until 12:14 local on Oct 26 the Mac was awake and online (there are no sleep entries at all on Oct 25 or 26; all 85 sleep entries since boot are on Oct 24) and the tunnel stayed dead for those 42 hours.
- Short sleeps recover on their own. The other seven retry episodes in the log last one to four seconds and end in `Registered tunnel connection` (Oct 22 10:19Z, Oct 24 21:50Z, Oct 27 05:59Z, 06:02Z, 06:05Z, 06:10Z). cloudflared reconnects fine as long as the edge still has the tunnel. Cloudflare's own page says quick tunnels have no uptime guarantee and are for testing; a named tunnel's registration survives a disconnect.
- launchd could not help. Both plists have `KeepAlive=true` and no `ThrottleInterval`; `launchctl print` shows the tunnel job with `runs = 2`, `last exit code = 0`, pid 9688 alive. KeepAlive restarts a process that exits. This one never exited.
- `status` lied about the URL. `readUrl` read the first 1,000,000 bytes of the log and took the last hostname in that slice. With the log at 14 MB that is the Oct 24 hostname (byte offset 22,682), while the live one is at offset 14,319,838. `node dist/index.js status` on the Mac printed `provider-mumbai-significantly-metallica` while the tunnel was serving `mood-precise-long-gregory`. Anyone following the README's "run status and put the new URL in the client" got a dead URL.
- Two smaller things in the same log: launchd's stdout/stderr capture and cloudflared's `--logfile` point at the same file, so every event is written twice; and the helper log had no timestamps, so helper failures could not be lined up with the tunnel log or with sleep.

### What changed

- **Watchdog** (`src/watchdog.ts`, LaunchAgent `com.claude-remote.watchdog`, `StartInterval` 120 s). Each run probes `GET http://127.0.0.1:<port>/mcp` with no credentials and treats the helper's `401` with `WWW-Authenticate: Bearer realm="claude-remote"` as "answers". If the helper does not answer, `launchctl kickstart -k` (or `bootstrap` when unloaded). If it does, the same probe goes to the public URL; two consecutive failures restart the tunnel job, at most once per ten minutes, never when DNS fails on the Mac. After a quick-tunnel restart it reads the new hostname from the log and POSTs a `url-changed` event to the existing `--notify-url` endpoint, signed like the pending alerts. It also trims the three logs at 8 MB. launchd fires a missed interval once on wake, which is the sleep/network-change handling: within two minutes of the Mac being awake and online, everything is answering or restarted.
- **Stable endpoint** (`src/tunnel.ts`, `install --tunnel=`). `named` runs a tunnel created with `cloudflared tunnel create` from a generated `~/.claude-remote/tunnel/named.yml`; `token` runs a dashboard tunnel from a 0600 token file via `--token-file`; `funnel` runs `tailscale funnel --bg --https=443 http://127.0.0.1:<port>` and reads the node name from `tailscale status --json`; `none` manages nothing. The choice is saved in `~/.claude-remote/tunnel/settings.json`. For the fixed-hostname modes the helper gets `CLAUDE_REMOTE_PUBLIC_HOST` and accepts that name in `Host` and `Origin`. Default stays `quick`, and a quick-mode reinstall produces a byte-identical tunnel plist, so it keeps the current hostname.
- **Status** (`executeStatus`) now says which part is down, in order: `helper-not-loaded`, `helper-not-answering`, `tunnel-not-loaded`, `no-public-url`, `public-not-answering`, `ok`. It parses `launchctl print` for pid, runs, and last exit code, summarizes the tail of the tunnel log (last registration, last retry, retries in the last ten minutes), and runs the same two probes as the watchdog. `--no-probe` skips them. The URL now comes from the last megabyte of the log.
- Helper log lines carry an `at` timestamp.

## Problem 2: a manual sign-in every week or so

### Root cause

The helper's headless `claude -p` children run on the `/login` credential, which has a lifetime, and once it expires and cannot be refreshed every request fails until someone logs in at the keyboard. Claude Code documents `claude setup-token` plus `CLAUDE_CODE_OAUTH_TOKEN` as the fix for unattended use.

### Evidence

- There is no `~/.claude/.credentials.json`, so the login is in the macOS Keychain (the docs: on macOS credentials go to the Keychain, with the file as fallback when the Keychain refuses a write). I did not query the Keychain; see the check for Nick below.
- The helper spawns `claude` from launchd (`/opt/homebrew/bin/node ~/claude-remote/dist/index.js http`, pid 1380, running since boot on Oct 23) for `claude agents --json --all`, `claude -p` on `new_session` with a prompt, `send_followup` resumes, and `deliver_message`. The children's stderr is dropped, so an auth failure shows up in `helper.log` only as `{"tool":"new","code":"headless-no-init"}` (4 times) and `{"tool":"send_followup","code":"error"}` (2 times). Those are the shapes a `Login expired` would produce; without timestamps or stderr the log cannot prove it, which is why both are fixed in this PR.
- The Claude Code authentication page, read today: "Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login` until you sign in again." and "Renewing early matters most for sessions that run unattended." It does not state the lifetime. The CLI reference: `claude setup-token` "Generate a long-lived OAuth token for CI and scripts. Prints the token to the terminal without saving it. Requires a Claude subscription." The authentication page: a one-year token, read from `CLAUDE_CODE_OAUTH_TOKEN`, precedence 5, above the `/login` credential; it "can only make model requests" (no Remote Control, no claude.ai connectors), and bare mode does not read it. The helper never passes `--bare` and needs only model requests.
- Installed CLI: `~/.local/bin/claude` → `~/.local/share/claude/versions/2.1.305`, version 2.1.305.

### What changed

- `src/oauth.ts`: `claudeChildEnv` reads `~/.config/claude-remote/oauth-token` at every spawn and sets `CLAUDE_CODE_OAUTH_TOKEN` in the child's environment only. The file has to be a regular file, mode 0600, first line a token; anything else is ignored and logged once per process as `ignored-<state>`. The token is never put in a plist, never logged, never printed. `status` reports `oauthTokenFile=present|missing|bad-mode|symlink|empty|bad-shape`, the mode, the file's age in days, and a warning at 330 days (the token lasts a year).
- Wired into every headless spawn: `claude agents --json`, the headless `new_session`, the `--environment` launch, `send_followup`, and the `deliver_message` worker. Interactive tmux and Terminal launches keep the normal login.
- `scripts/fake-claude.mjs` records `oauth: "set" | "unset"` so the tests prove the variable reaches the child without ever recording the value.

## Tests

`npm run build`, `npm test`, and `npm run test:portable` are the CI steps. Locally they pass with the helper's `CLAUDE_REMOTE_ALLOW_*` variables unset: this shell inherits them from the running helper, and with them set the pre-existing `tools/list hides send until the flag is set` test fails before and after this PR. New test files: `test/health.test.ts`, `test/oauth.test.ts`, `test/tunnel.test.ts`, `test/watchdog.test.ts`; `test/install.test.ts` gains the status verdicts and the four new tunnel modes. Results are in the commit messages and the final report.

I also ran the new `status` from the clone against the live install (read-only, probes carry no credentials): `verdict=ok`, helper pid 1380 answers, tunnel pid 9688 connected, `url=https://mood-precise-long-gregory.trycloudflare.com/mcp` (the live one, not the stale one the old status printed), `public=yes`, `oauthTokenFile=missing`, `watchdog=missing`.

## Not verified here

- A named tunnel, a token tunnel, and Funnel were not run against real Cloudflare or Tailscale accounts in this session (the task said not to touch either). The plist, config, and command lines are covered by tests; the first real run is rollout step 4.
- Whether Tailscale Funnel preserves the public `Host` header. `CLAUDE_REMOTE_PUBLIC_HOST` makes the helper accept it either way.
- The log trim assumes both writers opened the log with `O_APPEND` (launchd does; cloudflared's `--logfile` is an append-mode file). If that is wrong for cloudflared, a trimmed log gets a run of NUL bytes at the front, which the parsers skip.
- The Keychain angle. Nick can check it himself with `claude auth status --text` (prints the login method and expiry), `claude doctor` (reports a Keychain that is not writable), and `security find-generic-password -s "Claude Code-credentials"` without `-w` (metadata only, no secret).

## Upgrading an existing install (short version, also in the README)

1. `git pull && npm ci && npm run build` in the install directory.
2. Optional: `claude setup-token`, saved to `~/.config/claude-remote/oauth-token` under `umask 077`. Skip it and the periodic login stays.
3. Re-run `install` with the existing flags, including `--notify-url` again (and the secret in the environment), or alerts turn off.
4. Optional: `--tunnel=named ...` or `--tunnel=funnel` for a stable URL.
5. `node dist/index.js status`: expect `verdict=ok` and `watchdog=loaded`.
6. Update the client URL only if it changed.

## Rollout (Nick, on the Mac)

The current install has `--allow-send --allow-launch --allow-approve` on and a `notify.json`. `install` turns alerts off unless `--notify-url` is passed again, so step 3 must repeat the notify flags. Read the URL back from `~/.claude-remote/http/notify.json`; the secret is in the same file.

1. Build the branch in the install directory:
   ```bash
   cd ~/claude-remote && git fetch origin && git checkout fix/reliability && npm ci && npm run build
   ```
2. Create the setup-token file (one year, Pro/Max/Team/Enterprise):
   ```bash
   claude setup-token
   # approve in the browser, copy the token, then paste it into:
   (umask 077 && mkdir -p ~/.config/claude-remote && cat > ~/.config/claude-remote/oauth-token)
   # paste, Enter, Ctrl-D
   ls -l ~/.config/claude-remote/oauth-token   # -rw-------
   ```
3. Pick the endpoint. Recommended, a named tunnel on a hostname you own (replace `remote.example.com`):
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create claude-remote
   cloudflared tunnel route dns claude-remote remote.example.com
   CLAUDE_REMOTE_NOTIFY_SECRET='<secret from notify.json>' node dist/index.js install \
     --allow-send --allow-launch --allow-approve \
     --notify-url='<url from notify.json>' \
     --tunnel=named --tunnel-name=claude-remote --hostname=remote.example.com
   ```
   Or keep the quick tunnel and just add the watchdog and the token (the hostname survives, because the tunnel plist is unchanged):
   ```bash
   CLAUDE_REMOTE_NOTIFY_SECRET='<secret>' node dist/index.js install \
     --allow-send --allow-launch --allow-approve --notify-url='<url>'
   ```
   Or Tailscale Funnel, after enabling Funnel for this node in the admin console, with the same `--allow-*` and `--notify-*` flags plus `--tunnel=funnel`.
4. Check it:
   ```bash
   node dist/index.js status
   ```
   Expect `verdict=ok`, `helper=... answers=yes`, `public=yes`, `oauthTokenFile=present mode=0600`, `watchdog=loaded`. If `public=no detail=host-rejected`, the proxy forwards a Host the helper does not accept; `install --hostname=` sets it.
5. In the client, set the connector URL to the one `status` prints (`https://remote.example.com/mcp` for named). The bearer token did not change.
6. From off the home network (phone on cellular), list sessions through the connector. Then run `node dist/index.js watchdog` once by hand and read `~/.claude-remote/watchdog/watchdog.log`.
7. The next time a prompt needs approval, confirm the alert still arrives (step 3 kept the notify settings).
8. In a year, `claude setup-token` again and overwrite the file; `status` starts warning at 330 days.
