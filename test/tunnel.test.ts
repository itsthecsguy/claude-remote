import assert from "node:assert/strict";
import test from "node:test";
import { DeskError } from "../src/domain.js";
import {
  fixedPublicUrl,
  funnelArguments,
  funnelHostnameFromStatus,
  managesTunnelProcess,
  namedConfigPath,
  publicHostname,
  readTunnelSettings,
  renderNamedConfig,
  tunnelProcessArguments,
  tunnelSettingsFrom,
  writeTunnelSettings,
} from "../src/tunnel.js";
import { tempHome } from "./helpers.js";

test("tunnel settings are checked flag by flag", () => {
  assert.deepEqual(tunnelSettingsFrom({ mode: "quick" }), { mode: "quick" });
  assert.deepEqual(
    tunnelSettingsFrom({ mode: "named", name: "claude-remote", hostname: "Remote.Example.COM", credentialsFile: "/Users/nick/.cloudflared/abc.json" }),
    { mode: "named", name: "claude-remote", hostname: "remote.example.com", credentialsFile: "/Users/nick/.cloudflared/abc.json" },
  );
  assert.deepEqual(tunnelSettingsFrom({ mode: "named", name: "claude-remote", hostname: "remote.example.com" }), { mode: "named", name: "claude-remote", hostname: "remote.example.com", credentialsFile: null });
  assert.deepEqual(tunnelSettingsFrom({ mode: "token", hostname: "remote.example.com", tokenFile: "/Users/nick/.config/claude-remote/tunnel-token" }), { mode: "token", hostname: "remote.example.com", tokenFile: "/Users/nick/.config/claude-remote/tunnel-token" });
  assert.deepEqual(tunnelSettingsFrom({ mode: "funnel", hostname: "mac.tail1234.ts.net" }), { mode: "funnel", hostname: "mac.tail1234.ts.net" });
  assert.deepEqual(tunnelSettingsFrom({ mode: "funnel" }), { mode: "funnel", hostname: "" });
  assert.deepEqual(tunnelSettingsFrom({ mode: "none" }), { mode: "none", hostname: null });
  for (const bad of [
    { mode: "named" as const },
    { mode: "named" as const, name: "x", hostname: "" },
    { mode: "named" as const, name: "bad name", hostname: "remote.example.com" },
    { mode: "named" as const, name: "ok", hostname: "not a host" },
    { mode: "token" as const, hostname: "remote.example.com" },
    { mode: "quick" as const, hostname: "http://remote.example.com" },
  ]) {
    assert.throws(() => tunnelSettingsFrom(bad), (error: unknown) => error instanceof DeskError && error.code === "usage");
  }
});

test("each mode knows its hostname, URL, and cloudflared arguments", () => {
  const named = tunnelSettingsFrom({ mode: "named", name: "claude-remote", hostname: "remote.example.com" });
  assert.equal(publicHostname(named), "remote.example.com");
  assert.equal(fixedPublicUrl(named), "https://remote.example.com/mcp");
  assert.equal(publicHostname({ mode: "quick" }), null);
  assert.equal(fixedPublicUrl({ mode: "quick" }), null);
  assert.equal(managesTunnelProcess(named), true);
  assert.equal(managesTunnelProcess({ mode: "funnel", hostname: "mac.tail1234.ts.net" }), false);
  assert.deepEqual(tunnelProcessArguments({ mode: "quick" }, 47321, "/log", "/home"), [
    "tunnel", "--url", "http://127.0.0.1:47321", "--http-host-header", "127.0.0.1:47321", "--no-autoupdate", "--logfile", "/log",
  ]);
  assert.deepEqual(tunnelProcessArguments(named, 47321, "/log", "/home"), [
    "tunnel", "--no-autoupdate", "--logfile", "/log", "--config", namedConfigPath("/home"), "run", "claude-remote",
  ]);
  assert.deepEqual(tunnelProcessArguments({ mode: "token", hostname: "remote.example.com", tokenFile: "/t" }, 47321, "/log", "/home"), [
    "tunnel", "--no-autoupdate", "--logfile", "/log", "run", "--token-file", "/t",
  ]);
  assert.equal(tunnelProcessArguments({ mode: "funnel", hostname: "mac.tail1234.ts.net" }, 47321, "/log", "/home"), null);
  assert.equal(tunnelProcessArguments({ mode: "none", hostname: null }, 47321, "/log", "/home"), null);
  assert.deepEqual(funnelArguments(47321), ["funnel", "--bg", "--https=443", "http://127.0.0.1:47321"]);
  assert.deepEqual(funnelArguments(47321, true), ["funnel", "--bg", "--https=443", "http://127.0.0.1:47321", "off"]);
  assert.equal(funnelHostnameFromStatus(JSON.stringify({ Self: { DNSName: "Mac.tail1234.ts.net." } })), "mac.tail1234.ts.net");
  assert.equal(funnelHostnameFromStatus("{}"), null);
  assert.equal(funnelHostnameFromStatus("nope"), null);
});

test("the named config rewrites Host to the loopback listener and 404s everything else", () => {
  const text = renderNamedConfig({ mode: "named", name: "claude-remote", hostname: "remote.example.com", credentialsFile: "/Users/nick/.cloudflared/abc.json" }, 47321);
  assert.match(text, /^tunnel: "claude-remote"$/m);
  assert.match(text, /^credentials-file: "\/Users\/nick\/.cloudflared\/abc.json"$/m);
  assert.match(text, /hostname: "remote.example.com"\n {4}service: http:\/\/127\.0\.0\.1:47321\n {4}originRequest:\n {6}httpHostHeader: "127\.0\.0\.1:47321"/);
  assert.match(text, /- service: http_status:404\n$/);
  const bare = renderNamedConfig({ mode: "named", name: "claude-remote", hostname: "remote.example.com", credentialsFile: null }, 47321);
  assert.equal(bare.includes("credentials-file"), false);
});

test("settings round-trip through a 0600 file and fall back to quick when absent or broken", async () => {
  const { home } = await tempHome();
  assert.deepEqual(await readTunnelSettings(home), { mode: "quick" });
  const named = tunnelSettingsFrom({ mode: "named", name: "claude-remote", hostname: "remote.example.com" });
  const file = await writeTunnelSettings(home, named);
  assert.deepEqual(await readTunnelSettings(home), named);
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, "{not json");
  assert.deepEqual(await readTunnelSettings(home), { mode: "quick" });
  await writeFile(file, JSON.stringify({ mode: "named", name: "x" }));
  assert.deepEqual(await readTunnelSettings(home), { mode: "quick" });
  await writeFile(file, JSON.stringify({ mode: "funnel", hostname: "mac.tail1234.ts.net" }));
  assert.deepEqual(await readTunnelSettings(home), { mode: "funnel", hostname: "mac.tail1234.ts.net" });
});
