/**
 * Check a served catalog feed against its snapshot's manifest: every file the manifest lists is
 * fetched without following redirects and must match exactly with its kind's `Cache-Control`, the
 * served files must pass the publisher's checks, every index response (the catalog client's too)
 * must be the manifest's, and the engine's catalog client must list and prepare entries from it.
 * With `--previous`, the previous snapshot's documents and icons must still be served. Fails when
 * any check does, or when a request or an icon leaves the feed's host.
 *
 *   pnpm catalog:verify --feed <index.json URL> --manifest <manifest.json>
 *                       [--previous <manifest.json>] [--entry <id>]... [--concurrency <n>]
 *
 * Without `--entry` it prepares the first OAuth entry and the first key-based entry.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { verifyServed } from "./served.ts";

const { values } = parseArgs({
  options: {
    feed: { type: "string" },
    manifest: { type: "string" },
    previous: { type: "string" },
    entry: { type: "string", multiple: true, default: [] },
    concurrency: { type: "string", default: "8" },
  },
});
if (!values.feed || !values.manifest)
  throw new Error("--feed <index.json URL> and --manifest <manifest.json> are required");
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
  throw new Error("--concurrency takes a whole number from 1 to 32");
const started = performance.now();
const report = await verifyServed({
  feedUrl: values.feed,
  manifest: new Uint8Array(await readFile(values.manifest)),
  ...(values.previous ? { previous: new Uint8Array(await readFile(values.previous)) } : {}),
  entries: values.entry,
  concurrency,
});
console.log(
  JSON.stringify(
    { ...report, seconds: Math.round((performance.now() - started) / 100) / 10 },
    null,
    2,
  ),
);
if (report.problems.length > 0) process.exit(1);
