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
 * `--rules` is a JSON rule file (see rewrite.ts); its detailed report goes to `<out>.rewrites.json`,
 * beside the snapshot and never in it.
 *
 * Everything downloaded is data: it is parsed as JSON or stored as bytes, never executed.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { officialCatalogUrl } from "@opensteer/plugin-engine-catalog/contracts";
import { buildSnapshot, iconPath, legacySourcePath, servableId, sha256 } from "./core.ts";
import {
  readSnapshot,
  replaceDirectory,
  separatePlaces,
  stagingBeside,
  writeTree,
} from "./disk.ts";
import { parseRules } from "./rewrite.ts";

const userAgent = "catalog-snapshot";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    cache: { type: "string" },
    feed: { type: "string", default: officialCatalogUrl },
    rules: { type: "string" },
    concurrency: { type: "string", default: "8" },
    offline: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("--out <directory> is required");
const repository = resolve(import.meta.dirname, "../..");
const places = await separatePlaces(
  {
    out: values.out,
    cache: values.cache ?? `${resolve(values.out)}.download`,
    report: `${resolve(values.out)}.rewrites.json`,
  },
  repository,
);
const { out, cache } = places;
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
  throw new Error("--concurrency takes a whole number from 1 to 32");
const rulesText = values.rules ? await readFile(values.rules, "utf8") : undefined;
const rules =
  rulesText === undefined ? undefined : { rules: parseRules(rulesText), sha256: sha256(rulesText) };

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** Write through a temporary name, so a present cache file is always a complete one. */
async function writeAtomic(path: string, bytes: Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
}

/** GET with retries for transient failures. A 404 is an answer: the document does not exist. */
async function get(url: string): Promise<Uint8Array | undefined> {
  for (let attempt = 1; ; attempt++) {
    let failure: string;
    try {
      const response = await fetch(url, {
        headers: { "user-agent": userAgent },
        redirect: "manual",
        signal: AbortSignal.timeout(60_000),
      });
      if (response.status === 200) return new Uint8Array(await response.arrayBuffer());
      if (response.status === 404) return undefined;
      failure = `HTTP ${response.status}`;
      if (response.status < 500 && response.status !== 429) throw new Error(`${url}: ${failure}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(url)) throw error;
      failure = String(error);
    }
    if (attempt === 4) throw new Error(`${url}: ${failure}`);
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}

async function download(feedUrl: string) {
  const index = await get(feedUrl);
  if (index === undefined) throw new Error(`${feedUrl} does not exist`);
  const cachedIndex = join(cache, "index.json");
  if ((await exists(cachedIndex)) && !Buffer.from(index).equals(await readFile(cachedIndex)))
    throw new Error(
      `The feed changed since ${cache} was started. Remove it or pass a new --cache to take a fresh copy.`,
    );
  await writeAtomic(cachedIndex, index);
  const feed = JSON.parse(Buffer.from(index).toString("utf8")) as {
    apps: { id: string; icons: { src: string }[] }[];
  };
  const wanted = new Set<string>();
  for (const app of feed.apps) {
    // Ids become file names; one that cannot be is reported by the build instead.
    if (servableId(app.id)) wanted.add(legacySourcePath(app.id));
    for (const icon of app.icons) {
      const path = iconPath(icon.src);
      if (path !== undefined) wanted.add(path);
    }
  }
  const pending: string[] = [];
  for (const path of [...wanted].sort()) if (!(await exists(join(cache, path)))) pending.push(path);
  console.log(`${wanted.size} documents and icons, ${wanted.size - pending.length} already cached`);
  let done = 0;
  let missing = 0;
  const worker = async () => {
    for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
      const bytes = await get(new URL(path, feedUrl).href);
      if (bytes === undefined) missing++;
      else await writeAtomic(join(cache, path), bytes);
      if (++done % 250 === 0) console.log(`${done} fetched`);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`${done} fetched, ${missing} not found`);
}

const started = performance.now();
if (!values.offline) await download(values.feed);
// Replace only an earlier snapshot, never a directory this tool did not write.
if ((await exists(out)) && !(await exists(join(out, "manifest.json"))))
  throw new Error(`${out} exists and is not a snapshot`);
const read = (path: string) => readFile(join(cache, path)).catch(() => undefined);
const result = await buildSnapshot({
  feed: await readFile(join(cache, "index.json"), "utf8"),
  readSource: async (id) => (await read(legacySourcePath(id)))?.toString("utf8"),
  readIcon: async (path) => {
    const bytes = await read(path);
    return bytes === undefined ? undefined : new Uint8Array(bytes);
  },
  ...(rules ? { rules } : {}),
});
const { manifest, failures, report } = result;
// The detailed report names what was rewritten and kept; it stays private, beside the snapshot.
if (rules) await writeAtomic(places.report, Buffer.from(JSON.stringify(report, null, 2) + "\n"));

const largest = Object.entries(manifest.files)
  .filter(([path]) => /^apps\/[^/]+\/[^/]+$/u.test(path))
  .sort(([, a], [, b]) => b.bytes - a.bytes)
  .slice(0, 5);
const reasons = new Map<string, number>();
for (const occurrence of report.remaining)
  reasons.set(
    occurrence.reason ?? "unaccounted",
    (reasons.get(occurrence.reason ?? "unaccounted") ?? 0) + 1,
  );
console.log(
  JSON.stringify(
    {
      entries: manifest.entries,
      documents: manifest.documents,
      icons: manifest.icons,
      files: result.files.size,
      totalBytes: manifest.totalBytes,
      feedSha256: manifest.feed.sha256,
      manifestSha256: sha256(result.files.get("manifest.json")!),
      duplicateIds: manifest.duplicateIds,
      largest: largest.map(([path, file]) => ({ path, bytes: file.bytes })),
      rules: report.rules,
      remaining: Object.fromEntries(reasons),
      failures: failures.slice(0, 50),
      failureCount: failures.length,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
    null,
    2,
  ),
);
if (failures.length > 0) {
  console.error(`Not usable: ${failures.length} problems. Nothing was written to ${out}.`);
  process.exit(1);
}

const staging = await stagingBeside(out);
try {
  await separatePlaces({ out, cache, staging }, repository);
  await writeTree(staging, result.files);
  // Check what is on disk, as the publisher will.
  await readSnapshot(staging);
  await replaceDirectory(out, staging);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
console.log(`Snapshot written to ${out}${rules ? `; rewrite report in ${places.report}` : ""}`);
