/**
 * Check a served catalog against the snapshot it should be. Every file the manifest lists is
 * downloaded and must match its hash and size exactly, the served index included, and the served
 * set must pass the same relationship checks the publisher applies. No verification request
 * follows a redirect: one is a failure. Then the engine's catalog client lists the feed and
 * prepares entries, as a Host does.
 */
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { createCatalog } from "@opensteer/plugin-engine-catalog";
import { sha256, snapshotProblems, type Manifest } from "./core.ts";

export interface ServedReport {
  readonly feedUrl: string;
  readonly checked: { readonly files: number; readonly documents: number; readonly icons: number };
  readonly listed: number;
  readonly prepared: ReadonlyArray<{ id: string; files: number; matchesDocument: boolean }>;
  /** Requests per host, ours and the catalog client's. */
  readonly hosts: Readonly<Record<string, number>>;
  readonly problems: readonly string[];
}

export async function verifyServed(input: {
  readonly feedUrl: string;
  /** The snapshot's `manifest.json`, as published. */
  readonly manifest: Uint8Array;
  /** Entries to prepare; by default the first OAuth and the first key-based one. */
  readonly entries?: readonly string[];
  readonly concurrency?: number;
}): Promise<ServedReport> {
  const problems: string[] = [];
  const hosts = new Map<string, number>();
  const count = (url: string) => {
    const host = new URL(url).host;
    hosts.set(host, (hosts.get(host) ?? 0) + 1);
  };
  const manifest = JSON.parse(new TextDecoder().decode(input.manifest)) as Manifest;
  const base = new URL(".", input.feedUrl);

  /** One verification GET: no redirect followed, 200 or nothing. */
  const get = async (url: string): Promise<Uint8Array | undefined> => {
    count(url);
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    if (response.status >= 300 && response.status < 400) {
      problems.push(`${url} redirects (HTTP ${response.status})`);
      return undefined;
    }
    if (response.status !== 200) {
      problems.push(`${url}: HTTP ${response.status}`);
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  };

  // The index first: exactly the manifest's, or nothing else is worth reading.
  const index = await get(input.feedUrl);
  if (
    index !== undefined &&
    (sha256(index) !== manifest.feed.sha256 || index.byteLength !== manifest.feed.bytes)
  )
    problems.push("the served index.json is not the manifest's (hash or size differs)");
  if (index === undefined || problems.length > 0)
    return {
      feedUrl: input.feedUrl,
      checked: { files: 0, documents: 0, icons: 0 },
      listed: 0,
      prepared: [],
      hosts: Object.fromEntries(hosts),
      problems,
    };

  const served = new Map<string, Uint8Array>([
    ["index.json", index],
    ["manifest.json", input.manifest],
  ]);
  const servedManifest = await get(new URL("manifest.json", base).href);
  if (servedManifest !== undefined && !Buffer.from(servedManifest).equals(input.manifest))
    problems.push("the served manifest.json is not this manifest");
  const pending = Object.keys(manifest.files).filter((path) => path !== "index.json");
  const worker = async () => {
    for (let path = pending.shift(); path !== undefined; path = pending.shift()) {
      const bytes = await get(new URL(path, base).href);
      if (bytes !== undefined) served.set(path, bytes);
    }
  };
  await Promise.all(Array.from({ length: input.concurrency ?? 8 }, worker));
  problems.push(...snapshotProblems(served));

  // The catalog client, as a Host runs it, with every request it makes counted.
  const client = await Effect.runPromise(
    Effect.gen(function* () {
      return (yield* HttpClient.HttpClient).pipe(
        HttpClient.tapRequest((request) => Effect.sync(() => count(request.url))),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const catalog = createCatalog({
    egress: { policy: { allowLoopbackHttp: true, allowedHttpOrigins: [] }, client },
    feedUrl: input.feedUrl,
  });
  const listing = await Effect.runPromise(catalog.list);
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
  const apps = (
    JSON.parse(new TextDecoder().decode(index)) as { apps: { id: string; source: string }[] }
  ).apps;
  const prepared = [];
  for (const id of ids) {
    const app = await Effect.runPromise(Effect.result(catalog.prepare({ entry: id })));
    const source = apps.find((entry) => entry.id === id)?.source;
    const document = source === undefined ? undefined : served.get(source);
    const files =
      document === undefined
        ? undefined
        : (JSON.parse(new TextDecoder().decode(document)) as { files: unknown }).files;
    const matchesDocument = app._tag === "Success" && isDeepStrictEqual(app.success.files, files);
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
  const paths = [...served.keys()];
  return {
    feedUrl: input.feedUrl,
    checked: {
      files: served.size,
      documents: paths.filter((path) => path.startsWith("apps/")).length,
      icons: paths.filter((path) => path.startsWith("icons/")).length,
    },
    listed: listing.apps.length,
    prepared,
    hosts: Object.fromEntries(hosts),
    problems: [...new Set(problems)],
  };
}
