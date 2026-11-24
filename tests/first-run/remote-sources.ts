/**
 * Prints, as JSON, the source of every function the first-run journey hands to another process,
 * exactly as Playwright sends it: `String(fn)` of the module as the loader compiled it. Run with
 * the loader the VM runs the journey with (`pnpm exec tsx`, `journey-command.sh`); `remote.test.ts`
 * reads it.
 */
import * as remote from "./remote.js";
import { firstScreenOf } from "../../apps/web/src/components/places/desktop-first-screen.test-support.js";

const sources: Record<string, string> = { firstScreenOf: String(firstScreenOf) };
for (const [name, value] of Object.entries(remote))
  if (typeof value === "function") sources[name] = String(value);
process.stdout.write(JSON.stringify(sources));
