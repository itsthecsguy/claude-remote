import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { runChannelMode } from "./channel-host.js";
import { isDeskCommand, runCli, USAGE } from "./cli.js";
import { parseConfig } from "./config.js";
import { registerDeliverTool } from "./deliver.js";
import { registerLaunchTools } from "./launch.js";
import { registerPendingTools } from "./pending.js";
import { registerTools } from "./tools.js";

const command = process.argv[2];
if (command === "channel") {
  const code = await runChannelMode({
    input: process.stdin,
    output: process.stdout,
    env: process.env,
    ppid: process.ppid,
    home: homedir(),
  });
  process.exit(code);
}

if (command && isDeskCommand(command)) {
  const code = await runCli(process.argv.slice(2), process.env);
  process.exit(code);
}

if (command) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

const config = parseConfig(process.env);

serveStdio(() => {
  const server = new McpServer({ name: "claude-remote", version: "0.1.0" });
  registerTools(server, config);
  registerLaunchTools(server, config);
  registerDeliverTool(server, config);
  registerPendingTools(server, config);
  return server;
});
