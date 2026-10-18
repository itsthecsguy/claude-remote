#!/usr/bin/env node
// `hook` runs inside every matching Claude Code hook event, so it loads nothing but its own
// module: no MCP SDK, no zod. Everything else goes through main.
if (process.argv[2] === "hook") {
  const { hookMain } = await import("./hook.js");
  await hookMain();
} else {
  await import("./main.js");
}
export {};
