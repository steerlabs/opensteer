/**
 * The snapshot tool's work, apart from its command line (snapshot.ts), so it can also be run
 * in-process. Everything downloaded is data: it is parsed as JSON or stored as bytes, never
 * executed.
 */
import { lstat, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { officialCatalogUrl } from "@opensteer/plugin-engine-catalog/contracts";
import { buildSnapshot, iconPath, legacySourcePath, servableId, sha256 } from "./core.ts";
import {
  holdLock,
  lockOf,
  readSnapshot,
  realTarget,
  recoverBeside,
  refuseLinks,
  replaceDirectory,
  reservedBeside,
  separatePlaces,
  stagingBeside,
  writeFileAtomic,
  writeTree,
} from "./disk.ts";
import { parseRules } from "./rewrite.ts";

const userAgent = "catalog-snapshot";

export interface SnapshotOptions {
  readonly out: string;
  readonly cache?: string | undefined;
  /** The feed's `index.json` URL; the engine's `officialCatalogUrl` by default. */
  readonly feed?: string | undefined;
  /** A rule file's path. */
  readonly rules?: string | undefined;
  readonly concurrency?: string | undefined;
  readonly offline?: boolean | undefined;
}

/** Take or rebuild a snapshot at `out`; throws when it is not usable, writing nothing there. */
export async function takeSnapshot(
  values: SnapshotOptions,
  log: (line: string) => void = console.log,
) {
  const repository = resolve(import.meta.dirname, "../..");
  // The reports are replaced by rename, never written through: one that is a link is refused.
  for (const suffix of [".rewrites.json", ".rewrites.next.json", ".rewrites.failed.json"]) {
    const path = `${resolve(values.out)}${suffix}`;
    if ((await lstat(path).catch(() => undefined))?.isSymbolicLink())
      throw new Error(`${path} is a symlink; remove it`);
  }
  const places = await separatePlaces(
    {
      out: values.out,
      cache: values.cache ?? `${resolve(values.out)}.download`,
      report: `${resolve(values.out)}.rewrites.json`,
      nextReport: `${resolve(values.out)}.rewrites.next.json`,
      failedReport: `${resolve(values.out)}.rewrites.failed.json`,
    },
    repository,
  );
  // Recovery removes or moves the names it reserves beside `--out`; no input may be one of them.
  const inputs: Record<string, string> = {
    cache: places.cache,
    report: places.report,
    failedReport: places.failedReport,
    ...(values.rules === undefined ? {} : { rules: await realTarget(values.rules) }),
  };
  for (const [key, path] of Object.entries(inputs)) {
    const reserved = reservedBeside(places.out, path, [places.nextReport]);
    if (reserved !== undefined)
      throw new Error(
        `--${key} ${path} is or lies inside ${reserved}, which the tool reserves beside --out and may remove; choose another path`,
      );
  }
  // One run at a time per output: recovery below would otherwise take another run's staging
  // directory or set-aside snapshot for leftovers.
  await mkdir(dirname(places.out), { recursive: true });
  const release = await holdLock(lockOf(places.out), `--out ${places.out}`, log);
  try {
    await build(values, places, repository, log);
  } finally {
    await release();
  }
}

/** The run itself, under the output's lock. */
async function build(
  values: SnapshotOptions,
  places: Record<"out" | "cache" | "report" | "nextReport" | "failedReport", string>,
  repository: string,
  log: (line: string) => void,
) {
  const { out, cache } = places;
  const concurrency = Number(values.concurrency ?? "8");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32)
    throw new Error("--concurrency takes a whole number from 1 to 32");
  const rulesText = values.rules ? await readFile(values.rules, "utf8") : undefined;
  const rules =
    rulesText === undefined
      ? undefined
      : { rules: parseRules(rulesText), sha256: sha256(rulesText) };

  const exists = (path: string) =>
    stat(path).then(
      () => true,
      () => false,
    );

  // Put right a run stopped mid-swap before anything else. The rewrite report is committed with
  // its snapshot: written to `nextReport` before the swap, and moved into place after it. So a
  // `nextReport` describing the snapshot at `<out>` was swapped in with it and is moved into place
  // now; any other goes. Then the report beside `<out>` must describe the snapshot there, or it goes.
  for (const line of await recoverBeside(out)) log(line);
  const outManifest = await readFile(join(out, "manifest.json")).catch(() => undefined);
  const describesOut = async (path: string) => {
    const text = await readFile(path, "utf8").catch(() => undefined);
    if (text === undefined) return undefined;
    try {
      const described = (JSON.parse(text) as { manifestSha256?: unknown }).manifestSha256;
      return outManifest !== undefined && described === sha256(outManifest);
    } catch {
      return false;
    }
  };
  const next = await describesOut(places.nextReport);
  if (next === true) {
    await rename(places.nextReport, places.report);
    log(`moved ${places.nextReport} into place: the swap that wrote ${out} stopped before it`);
  } else if (next === false) {
    await rm(places.nextReport);
    log(`removed ${places.nextReport}, left by a run stopped before its swap`);
  }
  if ((await describesOut(places.report)) === false) {
    await rm(places.report);
    log(`removed ${places.report}: it did not describe the snapshot at ${out}`);
  }
  // Cache files are written and read by path; a symlink in the cache could send either elsewhere.
  if (await exists(cache)) await refuseLinks(cache);

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
    await writeFileAtomic(cachedIndex, index);
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
    for (const path of [...wanted].sort())
      if (!(await exists(join(cache, path)))) pending.push(path);
    log(`${wanted.size} documents and icons, ${wanted.size - pending.length} already cached`);
    let done = 0;
    let missing = 0;
    const worker = async () => {
      for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
        const bytes = await get(new URL(path, feedUrl).href);
        if (bytes === undefined) missing++;
        else await writeFileAtomic(join(cache, path), bytes);
        if (++done % 250 === 0) log(`${done} fetched`);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    log(`${done} fetched, ${missing} not found`);
  }

  const started = performance.now();
  if (!values.offline) await download(values.feed ?? officialCatalogUrl);
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
  const { manifest, failures } = result;
  const manifestSha256 = sha256(result.files.get("manifest.json")!);
  // The detailed report names what was rewritten and kept; it stays private, beside the snapshot,
  // and names the manifest it describes.
  const report = { manifestSha256, ...result.report };
  const reportBytes = Buffer.from(JSON.stringify(report, null, 2) + "\n");

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
  log(
    JSON.stringify(
      {
        entries: manifest.entries,
        documents: manifest.documents,
        icons: manifest.icons,
        files: result.files.size,
        totalBytes: manifest.totalBytes,
        feedSha256: manifest.feed.sha256,
        manifestSha256,
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
    // Kept apart from the report of the snapshot at `<out>`, which this build does not replace.
    if (rules) await writeFileAtomic(places.failedReport, reportBytes);
    throw new Error(
      `Not usable: ${failures.length} problems. Nothing was written to ${out}.${rules ? ` Rewrite report in ${places.failedReport}.` : ""}`,
    );
  }

  const staging = await stagingBeside(out);
  try {
    await separatePlaces({ out, cache, staging }, repository);
    await writeTree(staging, result.files);
    // Check what is on disk, as the publisher will.
    await readSnapshot(staging);
    // The report waits beside the swap, so the swap commits both (see the start of the run).
    if (rules) await writeFileAtomic(places.nextReport, reportBytes);
    await replaceDirectory(out, staging);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    await rm(places.nextReport, { force: true });
    throw error;
  }
  if (rules) await rename(places.nextReport, places.report);
  else await rm(places.report, { force: true });
  await rm(places.failedReport, { force: true });
  log(`Snapshot written to ${out}${rules ? `; rewrite report in ${places.report}` : ""}`);
}
