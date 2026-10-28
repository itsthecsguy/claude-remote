const cp = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const banned = new Set(["osascript", "open", "tmux", "cloudflared", "brew", "launchctl", "claude", "tailscale", "Tailscale"]);

function refuseTerminalLauncher(command) {
  if (typeof command !== "string") return;
  if (!banned.has(path.basename(command))) return;
  const error = new Error("refusing a real terminal launcher");
  error.code = "denied";
  throw error;
}

function wrap(fn) {
  if (typeof fn !== "function" || fn.claudeRemoteSpawnGuard === true) return fn;
  function guarded(command, ...rest) {
    refuseTerminalLauncher(command);
    return fn.call(this, command, ...rest);
  }
  guarded.claudeRemoteSpawnGuard = true;
  const custom = fn[promisify.custom];
  if (typeof custom === "function") {
    function customGuarded(...args) {
      refuseTerminalLauncher(args[0]);
      return custom.apply(this, args);
    }
    guarded[promisify.custom] = customGuarded;
  }
  return guarded;
}

cp.spawn = wrap(cp.spawn);
cp.spawnSync = wrap(cp.spawnSync);
cp.execFile = wrap(cp.execFile);
cp.execFileSync = wrap(cp.execFileSync);
cp.fork = wrap(cp.fork);
