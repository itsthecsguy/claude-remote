#!/usr/bin/env node
import { appendFile } from "node:fs/promises";

const log = process.env.FAKE_BIN_LOG;
if (!log) {
  process.stderr.write("FAKE_BIN_LOG missing\n");
  process.exit(2);
}
await appendFile(log, `${JSON.stringify(process.argv.slice(2))}\n`);
