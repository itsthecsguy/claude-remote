import path from "node:path";

/** Labels, plist paths, and the plist template shared by install, status, and the watchdog. */

export const HTTP_LABEL = "com.claude-remote.http";
export const TUNNEL_LABEL = "com.claude-remote.tunnel";
export const WATCHDOG_LABEL = "com.claude-remote.watchdog";

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (bin: string, args: string[]) => Promise<CommandResult>;

export function launchAgentsDir(home: string): string {
  return path.join(home, "Library", "LaunchAgents");
}

export function httpPlistPath(home: string): string {
  return path.join(launchAgentsDir(home), `${HTTP_LABEL}.plist`);
}

export function tunnelPlistPath(home: string): string {
  return path.join(launchAgentsDir(home), `${TUNNEL_LABEL}.plist`);
}

export function watchdogPlistPath(home: string): string {
  return path.join(launchAgentsDir(home), `${WATCHDOG_LABEL}.plist`);
}

export type PlistSchedule =
  /** A daemon launchd restarts whenever it exits. */
  | { kind: "keep-alive" }
  /** A short job launchd runs every `intervalS` seconds. Missed runs during sleep coalesce into one run on wake. */
  | { kind: "interval"; intervalS: number };

export function plist(
  label: string,
  args: string[],
  env: Record<string, string>,
  logs: { out: string; err: string },
  schedule: PlistSchedule = { kind: "keep-alive" },
): string {
  const argumentsXml = args.map((arg) => `<string>${xml(arg)}</string>`).join("");
  const envXml = Object.entries(env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
  const scheduleXml = schedule.kind === "keep-alive"
    ? "<key>KeepAlive</key><true/>"
    : `<key>StartInterval</key><integer>${Math.floor(schedule.intervalS)}</integer>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>RunAtLoad</key><true/>${scheduleXml}<key>ProgramArguments</key><array>${argumentsXml}</array><key>EnvironmentVariables</key><dict>${envXml}</dict><key>StandardOutPath</key><string>${xml(logs.out)}</string><key>StandardErrorPath</key><string>${xml(logs.err)}</string></dict></plist>
`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Restart a LaunchAgent. `kickstart -k` kills a running job and starts it again, and also starts a
 * loaded job that is not running. When the job is not loaded at all, bootstrap it from its plist.
 */
export async function restartJob(
  run: CommandRunner,
  launchctlBin: string,
  domain: string,
  label: string,
  plistPath: string,
): Promise<"kickstarted" | "bootstrapped" | "failed"> {
  const kicked = await run(launchctlBin, ["kickstart", "-k", `${domain}/${label}`]);
  if (kicked.code === 0) return "kickstarted";
  const booted = await run(launchctlBin, ["bootstrap", domain, plistPath]);
  return booted.code === 0 ? "bootstrapped" : "failed";
}
