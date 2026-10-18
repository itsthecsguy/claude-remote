#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const log = process.env.FAKE_OSASCRIPT_LOG;
if (!log) {
  process.stderr.write("FAKE_OSASCRIPT_LOG missing\n");
  process.exit(2);
}
await appendFile(log, `${JSON.stringify(process.argv.slice(2))}\n`);
process.exit(0);
