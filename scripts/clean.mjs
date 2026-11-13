// Package `clean` scripts: removes each named path or glob under the working
// directory. Windows shells pass globs through unexpanded, so they expand here.
import { globSync, rmSync } from "node:fs";

const patterns = process.argv.slice(2);
if (!patterns.length) throw new Error("Usage: node scripts/clean.mjs <path or glob>...");
for (const pattern of patterns)
  for (const path of globSync(pattern)) rmSync(path, { force: true, recursive: true });
