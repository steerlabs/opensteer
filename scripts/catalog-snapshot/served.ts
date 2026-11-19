/**
 * Check a served catalog against the snapshot it should be. Every file the manifest lists is
 * downloaded and must match its hash and size exactly, and the served set must pass the same
 * relationship checks the publisher applies. Every response must carry the `Cache-Control` the
 * publisher deploys for its kind of path, and every index response during the run, the catalog
 * client's included, must be the manifest's exact index: a full one by its bytes, a 304 by the
 * ETag it confirms, which a full response checked earlier must have carried. No request follows a
 * redirect: one is a failure. Responses are hashed as they arrive; only the index and one document
 * at a time are held. Then the engine's catalog client lists the feed and prepares entries, as a
 * Host does.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { createCatalog } from "@opensteer/plugin-engine-catalog";
import {
  cacheControlFor,
  contentProblem,
  publishedAt,
  setProblems,
  sha256,
  snapshotPathKind,
  type FileRecord,
  type Manifest,
} from "./core.ts";

/** A site's `manifest.json`, or undefined when it serves none. A redirect or other answer throws. */
export async function liveManifest(url: string): Promise<Uint8Array | undefined> {
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) return undefined;
  if (response.status !== 200)
    throw new Error(`${url}: HTTP ${response.status}; the live release cannot be read`);
  return new Uint8Array(await response.arrayBuffer());
}

export interface ServedReport {
  readonly feedUrl: string;
  readonly checked: {
    readonly files: number;
    readonly documents: number;
    readonly icons: number;
    /** The retained previous release's content-addressed files, with `previous`. */
    readonly retained: number;
  };
  readonly listed: number;
  readonly prepared: ReadonlyArray<{ id: string; files: number; matchesDocument: boolean }>;
  /** Full index responses seen, ours and the catalog client's; each must be the manifest's index. */
  readonly indexReads: number;
  /**
   * The catalog client's revalidations of the index answered 304; each must confirm the ETag of a
   * full response that was the manifest's index.
   */
  readonly indexRevalidations: number;
  /** Requests per host, ours and the catalog client's. */
  readonly hosts: Readonly<Record<string, number>>;
  readonly problems: readonly string[];
}

export async function verifyServed(input: {
  readonly feedUrl: string;
  /** The snapshot's `manifest.json`. */
  readonly manifest: Uint8Array;
  /** The previous snapshot's `manifest.json`: its documents and icons must still be served. */
  readonly previous?: Uint8Array;
  /** Entries to prepare; by default the first OAuth and the first key-based one. */
  readonly entries?: readonly string[];
  readonly concurrency?: number;
}): Promise<ServedReport> {
  const problems: string[] = [];
  const hosts = new Map<string, number>();
  const manifest = JSON.parse(new TextDecoder().decode(input.manifest)) as Manifest;
  const feedUrl = new URL(input.feedUrl).href;
  const base = new URL(".", feedUrl).href;
  /** The snapshot path a URL names, or undefined for one outside the feed. */
  const pathOf = (url: string) => {
    const plain = url.split(/[?#]/u)[0]!;
    if (plain === feedUrl) return "index.json";
    return plain.startsWith(base) ? decodeURIComponent(plain.slice(base.length)) : undefined;
  };
  // One wrong header class is one problem, with an example, not thousands.
  const headerProblems = new Map<string, string>();
  let indexReads = 0;
  let indexRevalidations = 0;
  /** The ETags of full index responses that were the manifest's index. */
  const checkedEtags = new Set<string>();
  /** What every response is checked for, whoever asked: its header, and an index's exact bytes. */
  const observe = (url: string, response: Response) => {
    const path = pathOf(url);
    const expected = path === undefined ? undefined : cacheControlFor(path);
    const served = response.headers.get("cache-control");
    if (expected !== undefined && (response.status === 200 || response.status === 304)) {
      const kind = snapshotPathKind(path!)!;
      if (served !== expected && !headerProblems.has(kind))
        headerProblems.set(
          kind,
          `${path}: Cache-Control is ${JSON.stringify(served)}, not ${JSON.stringify(expected)} (the ${kind} paths)`,
        );
    }
    return path;
  };
  const checkIndex = (record: FileRecord, etag: string | null) => {
    indexReads++;
    if (record.sha256 !== manifest.feed.sha256 || record.bytes !== manifest.feed.bytes)
      problems.push(
        `an index response (read ${indexReads}) is not the manifest's index.json (hash or size differs)`,
      );
    else if (etag !== null) checkedEtags.add(etag);
  };
  /** A 304 for the index: the ETag it confirms must be one a checked full response carried. */
  const checkRevalidation = (asked: string | null) => {
    indexRevalidations++;
    if (asked === null || !checkedEtags.has(asked))
      problems.push(
        `an index revalidation (${indexRevalidations}) answered 304 for ${asked === null ? "no ETag" : `the ETag ${asked}`}, which no index response checked against the manifest carried`,
      );
  };
  /** Every request of the run, ours and the catalog client's: counted, never redirected. */
  const send = async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
    const timeout = AbortSignal.timeout(60_000);
    return fetch(url, {
      ...init,
      redirect: "manual",
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };

  /** One verification GET, hashed as it streams; `keep` also returns its bytes. */
  const get = async (url: string, keep: boolean) => {
    const response = await send(url);
    const path = observe(url, response);
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      problems.push(`${url} redirects (HTTP ${response.status})`);
      return undefined;
    }
    if (response.status !== 200 || response.body === null) {
      await response.body?.cancel();
      problems.push(`${url}: HTTP ${response.status}`);
      return undefined;
    }
    const hash = createHash("sha256");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      bytes += chunk.byteLength;
      if (keep) chunks.push(chunk);
    }
    const record: FileRecord = { sha256: hash.digest("hex"), bytes };
    if (path === "index.json") checkIndex(record, response.headers.get("etag"));
    return { record, body: keep ? new Uint8Array(Buffer.concat(chunks)) : undefined };
  };

  const report = (listed = 0, prepared: ServedReport["prepared"] = []) => {
    const paths = [...records.keys()];
    return {
      feedUrl: input.feedUrl,
      checked: {
        files: records.size + 1,
        documents: paths.filter((path) => path.startsWith("apps/")).length,
        icons: paths.filter((path) => path.startsWith("icons/")).length,
        retained,
      },
      listed,
      prepared,
      indexReads,
      indexRevalidations,
      hosts: Object.fromEntries(hosts),
      problems: [...new Set([...problems, ...headerProblems.values()])],
    };
  };
  const records = new Map<string, FileRecord>();
  let retained = 0;

  // Paths come from a file; only those the layout allows are requested.
  const listedPaths = [
    ...Object.keys(manifest.files ?? {}),
    ...Object.keys(
      input.previous === undefined
        ? {}
        : ((JSON.parse(new TextDecoder().decode(input.previous)) as Manifest).files ?? {}),
    ),
  ];
  for (const path of listedPaths)
    if (snapshotPathKind(path) === undefined)
      problems.push(`the manifest lists ${JSON.stringify(path)}, which has no place in a snapshot`);
  if (problems.length > 0) return report();

  // The index first: exactly the manifest's, or nothing else is worth reading.
  const index = await get(feedUrl, true);
  if (index === undefined || problems.length > 0) return report();
  records.set("index.json", index.record);
  const servedManifest = await get(new URL("manifest.json", base).href, true);
  if (
    servedManifest?.body !== undefined &&
    publishedAt(servedManifest.body, input.manifest) === undefined
  )
    problems.push("the served manifest.json is not this snapshot's manifest as published");

  // Each document is checked as the index lists it, while it is held; then only its hash is kept.
  const apps = (
    JSON.parse(new TextDecoder().decode(index.body)) as {
      apps: { id: string; package: string; source: string; sha256: string }[];
    }
  ).apps;
  const listedAs = new Map(apps.map((app) => [app.source, app.package]));
  const contentProblems = new Map<string, string>();
  const pending = Object.keys(manifest.files).filter((path) => path !== "index.json");
  const worker = async () => {
    for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
      const kind = snapshotPathKind(path);
      const checked = kind === "icon" || kind === "document";
      const fetched = await get(new URL(path, base).href, checked);
      if (fetched === undefined) continue;
      records.set(path, fetched.record);
      const problem = checked
        ? contentProblem(path, fetched.body!, listedAs.get(path) ?? "")
        : undefined;
      if (problem !== undefined) contentProblems.set(path, problem);
    }
  };
  await Promise.all(Array.from({ length: input.concurrency ?? 8 }, worker));
  problems.push(
    ...setProblems({
      manifest: input.manifest,
      index: index.body,
      records,
      contentProblem: (path) => contentProblems.get(path),
    }),
  );

  // The live release's documents and icons, which installs that read its index still need.
  if (input.previous !== undefined) {
    const earlier = (JSON.parse(new TextDecoder().decode(input.previous)) as Manifest).files;
    const kept = Object.entries(earlier).filter(([path]) => {
      const kind = snapshotPathKind(path);
      return (kind === "document" || kind === "icon") && !records.has(path);
    });
    const queue = [...kept];
    const keep = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const [path, expected] = next;
        const fetched = await get(new URL(path, base).href, false);
        if (fetched === undefined) continue;
        retained++;
        if (fetched.record.sha256 !== expected.sha256 || fetched.record.bytes !== expected.bytes)
          problems.push(`${path}: the previous release's file is served with other bytes`);
      }
    };
    await Promise.all(Array.from({ length: input.concurrency ?? 8 }, keep));
  }

  // The catalog client, as a Host runs it. Its requests go through the same checks as ours, and
  // an index it reads or revalidates must be the manifest's too.
  const clientFetch = (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = resource instanceof Request ? resource.url : String(resource);
    const response = await send(url, init);
    if (observe(url, response) !== "index.json") return response;
    if (response.status === 304) {
      const headers = new Headers(
        init?.headers ?? (resource instanceof Request ? resource.headers : undefined),
      );
      checkRevalidation(headers.get("if-none-match"));
      return response;
    }
    if (response.status !== 200) return response;
    const body = new Uint8Array(await response.arrayBuffer());
    checkIndex({ sha256: sha256(body), bytes: body.byteLength }, response.headers.get("etag"));
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof globalThis.fetch;
  const run = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(effect.pipe(Effect.provideService(FetchHttpClient.Fetch, clientFetch)));
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* HttpClient.HttpClient;
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const catalog = createCatalog({
    egress: { policy: { allowLoopbackHttp: true, allowedHttpOrigins: [] }, client },
    feedUrl: input.feedUrl,
  });
  const listing = await run(catalog.list);
  if (listing.feed.status !== "listed")
    problems.push(`the catalog client finds the feed ${listing.feed.status}`);
  if (listing.apps.length !== manifest.entries)
    problems.push(
      `the catalog client lists ${listing.apps.length} entries, the manifest ${manifest.entries}`,
    );
  const ids =
    input.entries && input.entries.length > 0
      ? input.entries
      : (["oauth2", "secrets"] as const).flatMap((kind) => {
          const found = listing.apps.find(
            (app) => app.auth.length > 0 && app.auth.every((auth) => auth.kind === kind),
          );
          return found === undefined ? [] : [found.id];
        });
  const prepared = [];
  for (const id of ids) {
    const app = await run(Effect.result(catalog.prepare({ entry: id })));
    const entry = apps.find((candidate) => candidate.id === id);
    // The document the index names, read again: only its hash was kept.
    const document =
      entry === undefined ? undefined : await get(new URL(entry.source, base).href, true);
    const files =
      document?.body === undefined || document.record.sha256 !== entry?.sha256
        ? undefined
        : (JSON.parse(new TextDecoder().decode(document.body)) as { files: unknown }).files;
    const matchesDocument =
      app._tag === "Success" && files !== undefined && isDeepStrictEqual(app.success.files, files);
    if (!matchesDocument)
      problems.push(`${id}: the prepared source is not the document the index names`);
    prepared.push({
      id,
      files: app._tag === "Success" ? app.success.files.length : 0,
      matchesDocument,
    });
  }
  const feedHost = new URL(input.feedUrl).host;
  for (const host of hosts.keys())
    if (host !== feedHost) problems.push(`a request went to ${host}`);
  for (const app of listing.apps)
    for (const icon of app.icons)
      if (!icon.src.startsWith("data:") && new URL(icon.src).host !== feedHost)
        problems.push(`${app.id}: an icon is served from ${new URL(icon.src).host}`);
  return report(listing.apps.length, prepared);
}
