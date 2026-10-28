import path from "node:path";
import { DeskError, assertNever } from "./domain.js";
import { readPlainFile, writePrivate } from "./files.js";
import { HTTP_HOST } from "./http.js";

/**
 * How the helper is reached from outside this Mac.
 *
 * quick   A Cloudflare quick tunnel (trycloudflare.com). No account. The hostname changes on every
 *         process start, and once the edge forgets a disconnected quick tunnel the running process
 *         can never re-register it; only a restart gets a new one.
 * named   A Cloudflare Tunnel you created with `cloudflared tunnel create`, on a hostname you own.
 *         Reconnects keep the same hostname.
 * token   A Cloudflare Tunnel created in the Zero Trust dashboard, run from a token kept in a 0600
 *         file (`cloudflared tunnel run --token-file`). Same properties as named.
 * funnel  Tailscale Funnel. tailscaled owns the listener, so there is no tunnel LaunchAgent; the
 *         hostname is this node's MagicDNS name.
 * none    No tunnel is managed here. Use it with your own reverse proxy.
 */
export type TunnelMode = "quick" | "named" | "token" | "funnel" | "none";

export type TunnelSettings =
  | { mode: "quick" }
  | { mode: "named"; name: string; hostname: string; credentialsFile: string | null }
  | { mode: "token"; hostname: string; tokenFile: string }
  | { mode: "funnel"; hostname: string }
  | { mode: "none"; hostname: string | null };

export const TUNNEL_MODES: readonly TunnelMode[] = ["quick", "named", "token", "funnel", "none"];

export const FUNNEL_PORT = 443;

export function tunnelDirectory(home: string): string {
  return path.join(home, ".claude-remote", "tunnel");
}

export function tunnelSettingsPath(home: string): string {
  return path.join(tunnelDirectory(home), "settings.json");
}

export function namedConfigPath(home: string): string {
  return path.join(tunnelDirectory(home), "named.yml");
}

export function isTunnelMode(value: string): value is TunnelMode {
  return (TUNNEL_MODES as readonly string[]).includes(value);
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validHostname(value: string): boolean {
  return HOSTNAME.test(value.toLowerCase());
}

export function validTunnelName(value: string): boolean {
  return TUNNEL_NAME.test(value);
}

/** Build and check settings from the install flags. Throws a usage error for a missing or bad value. */
export function tunnelSettingsFrom(flags: {
  mode: TunnelMode;
  name?: string;
  hostname?: string;
  credentialsFile?: string;
  tokenFile?: string;
}): TunnelSettings {
  const hostname = flags.hostname?.toLowerCase();
  if (hostname !== undefined && !validHostname(hostname)) throw new DeskError("usage", "--hostname must be a DNS name you own, such as remote.example.com");
  switch (flags.mode) {
    case "quick":
      return { mode: "quick" };
    case "named": {
      if (!flags.name || !validTunnelName(flags.name)) throw new DeskError("usage", "--tunnel=named needs --tunnel-name=<name from cloudflared tunnel create>");
      if (!hostname) throw new DeskError("usage", "--tunnel=named needs --hostname=<the DNS name routed to the tunnel>");
      const credentialsFile = flags.credentialsFile ? path.resolve(flags.credentialsFile) : null;
      return { mode: "named", name: flags.name, hostname, credentialsFile };
    }
    case "token": {
      if (!hostname) throw new DeskError("usage", "--tunnel=token needs --hostname=<the public hostname of the tunnel>");
      if (!flags.tokenFile) throw new DeskError("usage", "--tunnel=token needs --tunnel-token-file=<0600 file holding the tunnel token>");
      return { mode: "token", hostname, tokenFile: path.resolve(flags.tokenFile) };
    }
    case "funnel":
      // The hostname may be filled in from `tailscale status --json` by install.
      return { mode: "funnel", hostname: hostname ?? "" };
    case "none":
      return { mode: "none", hostname: hostname ?? null };
    default: {
      const _never: never = flags.mode;
      return assertNever(_never);
    }
  }
}

/** The public hostname the helper should also accept in Host and Origin, or null for quick tunnels. */
export function publicHostname(settings: TunnelSettings): string | null {
  switch (settings.mode) {
    case "quick":
      return null;
    case "named":
    case "token":
    case "funnel":
      return settings.hostname || null;
    case "none":
      return settings.hostname;
    default: {
      const _never: never = settings;
      return assertNever(_never);
    }
  }
}

/** The /mcp URL for a mode with a fixed hostname. Quick tunnels get theirs from the log instead. */
export function fixedPublicUrl(settings: TunnelSettings): string | null {
  const host = publicHostname(settings);
  return host ? `https://${host}/mcp` : null;
}

/** Whether this mode has a cloudflared LaunchAgent that a restart can bring back. */
export function managesTunnelProcess(settings: TunnelSettings): boolean {
  return settings.mode === "quick" || settings.mode === "named" || settings.mode === "token";
}

/** cloudflared arguments for the tunnel LaunchAgent, or null for modes without one. */
export function tunnelProcessArguments(settings: TunnelSettings, port: number, log: string, home: string): string[] | null {
  const common = ["--no-autoupdate", "--logfile", log];
  switch (settings.mode) {
    case "quick":
      return ["tunnel", "--url", `http://${HTTP_HOST}:${port}`, "--http-host-header", `${HTTP_HOST}:${port}`, ...common];
    case "named":
      return ["tunnel", ...common, "--config", namedConfigPath(home), "run", settings.name];
    case "token":
      return ["tunnel", ...common, "run", "--token-file", settings.tokenFile];
    case "funnel":
    case "none":
      return null;
    default: {
      const _never: never = settings;
      return assertNever(_never);
    }
  }
}

/**
 * The cloudflared config for a named tunnel. The ingress rewrites Host to 127.0.0.1:<port>, which
 * the helper's localhost-only Host check needs, and everything else is a 404 at the edge.
 */
export function renderNamedConfig(settings: Extract<TunnelSettings, { mode: "named" }>, port: number): string {
  const lines = [
    "# Written by `claude-remote install --tunnel=named`. Edit the flags and run install again.",
    `tunnel: ${yamlString(settings.name)}`,
  ];
  if (settings.credentialsFile) lines.push(`credentials-file: ${yamlString(settings.credentialsFile)}`);
  lines.push(
    "ingress:",
    `  - hostname: ${yamlString(settings.hostname)}`,
    `    service: http://${HTTP_HOST}:${port}`,
    "    originRequest:",
    `      httpHostHeader: ${yamlString(`${HTTP_HOST}:${port}`)}`,
    "  - service: http_status:404",
  );
  return `${lines.join("\n")}\n`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

/** `tailscale funnel --bg --https=443 http://127.0.0.1:<port>` persists in tailscaled across reboots. */
export function funnelArguments(port: number, off = false): string[] {
  const args = ["funnel", "--bg", `--https=${FUNNEL_PORT}`, `http://${HTTP_HOST}:${port}`];
  return off ? [...args, "off"] : args;
}

/** The MagicDNS name from `tailscale status --json`, without the trailing dot. */
export function funnelHostnameFromStatus(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { Self?: { DNSName?: unknown } };
    const name = parsed.Self?.DNSName;
    if (typeof name !== "string") return null;
    const trimmed = name.replace(/\.$/, "").toLowerCase();
    return validHostname(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

export async function readTunnelSettings(home: string): Promise<TunnelSettings> {
  const text = await readPlainFile(tunnelSettingsPath(home));
  if (text == null) return { mode: "quick" };
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parseSettings(parsed) ?? { mode: "quick" };
  } catch {
    return { mode: "quick" };
  }
}

export async function writeTunnelSettings(home: string, settings: TunnelSettings): Promise<string> {
  const file = tunnelSettingsPath(home);
  await writePrivate(file, `${JSON.stringify(settings)}\n`);
  return file;
}

function parseSettings(raw: Record<string, unknown>): TunnelSettings | null {
  const mode = typeof raw.mode === "string" && isTunnelMode(raw.mode) ? raw.mode : null;
  if (!mode) return null;
  const hostname = typeof raw.hostname === "string" && validHostname(raw.hostname) ? raw.hostname.toLowerCase() : null;
  switch (mode) {
    case "quick":
      return { mode };
    case "named": {
      const name = typeof raw.name === "string" && validTunnelName(raw.name) ? raw.name : null;
      if (!name || !hostname) return null;
      return { mode, name, hostname, credentialsFile: typeof raw.credentialsFile === "string" ? raw.credentialsFile : null };
    }
    case "token": {
      if (!hostname || typeof raw.tokenFile !== "string") return null;
      return { mode, hostname, tokenFile: raw.tokenFile };
    }
    case "funnel":
      return hostname ? { mode, hostname } : null;
    case "none":
      return { mode, hostname };
    default: {
      const _never: never = mode;
      return assertNever(_never);
    }
  }
}
