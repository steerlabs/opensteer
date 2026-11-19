/**
 * Copy a plugin catalog feed into a directory that serves as the same feed from any base URL.
 *
 *   pnpm catalog:snapshot --out <dir> [--cache <dir>] [--feed <index.json URL>]
 *                         [--rules <rules.json>] [--concurrency <n>] [--offline]
 *
 * Downloads go to the cache (default `<out>.download`) exactly as served, one file per document,
 * so an interrupted run resumes where it stopped and `--offline` rebuilds from the cache alone, for
 * example with new rules. The cache belongs to one version of the feed: when the feed's index has
 * changed since, the run stops and asks for a new cache.
 *
 * Output, cache and staging are resolved through symlinks and must lie outside the repository and
 * apart from each other. The snapshot is built in a new directory beside `<out>`, checked as
 * written, and only then swapped in; an earlier snapshot stays until the swap has succeeded.
 * Every document goes through the engine's shared rewrite (`rewriteUpstreamSource`), then
 * `--rules`, a JSON rule file of the catalog's own edits (see rewrite.ts); the detailed report goes
 * to `<out>.rewrites.json`, beside the snapshot and never in it.
 *
 * Everything downloaded is data: it is parsed as JSON or stored as bytes, never executed.
 */
import { parseArgs } from "node:util";
import { takeSnapshot } from "./take.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    cache: { type: "string" },
    feed: { type: "string" },
    rules: { type: "string" },
    concurrency: { type: "string" },
    offline: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("--out <directory> is required");
await takeSnapshot({ ...values, out: values.out });
