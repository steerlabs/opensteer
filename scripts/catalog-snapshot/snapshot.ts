/**
 * Copy a plugin catalog feed into a directory that serves as the same feed from any base URL.
 *
 *   pnpm catalog:snapshot --out <dir> [--cache <dir>] [--feed <index.json URL>]
 *                         [--rewrites <module>] [--concurrency <n>] [--offline]
 *
 * Downloads go to the cache (default `<out>.download`) exactly as served, one file per document,
 * so an interrupted run resumes where it stopped and `--offline` rebuilds from the cache alone, for
 * example with a new mapping. The cache belongs to one version of the feed: when the feed's index
 * has changed since, the run stops and asks for a new cache. The output is rebuilt in full beside
 * `<out>` and replaces it only when every document validates and no old string remains.
 *
 * `--rewrites` names a module whose `renames` (or default) export is a list of exact
 * [old, new] string pairs, applied in order to the feed and to every source document.
 *
 * Everything downloaded is data: it is parsed as JSON or stored as bytes, never executed.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { officialCatalogUrl } from "@opensteer/plugin-engine-catalog/contracts";
import { buildSnapshot, checkRewrites, iconPath, sourcePath, type Rewrites } from "./core.ts";

const userAgent = "catalog-snapshot";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    cache: { type: "string" },
    feed: { type: "string", default: officialCatalogUrl },
    rewrites: { type: "string" },
    concurrency: { type: "string", default: "8" },
    offline: { type: "boolean", default: false },
  },
});
if (!values.out) throw new Error("--out <directory> is required");
const out = resolve(values.out);
const cache = resolve(values.cache ?? `${out}.download`);
// The repository is public and plugin source is not ours to publish there.
const repository = resolve(import.meta.dirname, "../..");
for (const path of [out, cache])
  if (path === repository || path.startsWith(repository + sep))
    throw new Error(`${path} is inside the repository; keep snapshots outside it`);
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
  throw new Error("--concurrency takes a whole number from 1 to 32");
const rewrites: Rewrites = values.rewrites
  ? await import(pathToFileURL(resolve(values.rewrites)).href).then(
      (module: Record<string, unknown>) => checkRewrites(module.renames ?? module.default),
    )
  : [];

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
/** Write through a temporary name, so a present file is always a complete one. */
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
    // Ids become file names; one that cannot be a path segment is reported by the build instead.
    if (app.id !== "." && app.id !== ".." && encodeURIComponent(app.id) === app.id)
      wanted.add(sourcePath(app.id));
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
const partial = `${out}.partial`;
await rm(partial, { recursive: true, force: true });
const read = (path: string) => readFile(join(cache, path)).catch(() => undefined);
const result = await buildSnapshot({
  feed: await readFile(join(cache, "index.json"), "utf8"),
  readSource: async (id) => (await read(sourcePath(id)))?.toString("utf8"),
  readIcon: async (path) => (await read(path)) ?? undefined,
  write: (path, bytes) => writeAtomic(join(partial, path), bytes),
  rewrites,
});
await writeAtomic(
  join(partial, "manifest.json"),
  Buffer.from(JSON.stringify(result.manifest, null, 2) + "\n"),
);

const { manifest, failures, leftovers } = result;
const largest = Object.entries(manifest.files)
  .filter(([path]) => path.startsWith("apps/"))
  .sort(([, a], [, b]) => b.bytes - a.bytes)
  .slice(0, 10);
console.log(
  JSON.stringify(
    {
      entries: manifest.entries,
      documents: manifest.documents,
      icons: manifest.icons,
      totalBytes: manifest.totalBytes,
      feedSha256: manifest.feed.sha256,
      manifestSha256: createHash("sha256")
        .update(await readFile(join(partial, "manifest.json")))
        .digest("hex"),
      duplicateIds: manifest.duplicateIds,
      externalIcons: manifest.externalIcons,
      largest: largest.map(([path, file]) => ({ path, bytes: file.bytes })),
      rewrites: manifest.rewrites,
      failures,
      leftovers,
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
    null,
    2,
  ),
);
if (failures.length > 0 || leftovers.length > 0) {
  console.error(
    `Not usable: ${failures.length} documents fail validation, ${leftovers.length} old strings remain. The build is in ${partial}.`,
  );
  process.exit(1);
}
// Replace only an earlier snapshot, never a directory this tool did not write.
if ((await exists(out)) && !(await exists(join(out, "manifest.json"))))
  throw new Error(`${out} exists and is not a snapshot; the build is in ${partial}`);
await rm(out, { recursive: true, force: true });
await rename(partial, out);
console.log(`Snapshot written to ${out}`);
