/**
 * Read a served catalog feed the way a Host does: list it with the engine's catalog client,
 * prepare entries for install, confirm each prepared source is the document the index hashes, and
 * report every host the client contacted and every host the listing's icons load from. Fails
 * when any check does, or when a request or an icon leaves the feed's own host.
 *
 *   pnpm catalog:verify --feed <index.json URL> [--entry <id>]... [--manifest <manifest.json>]
 *
 * Without `--entry` it prepares the first OAuth entry and the first key-based entry.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { createCatalog } from "@opensteer/plugin-engine-catalog";
import type { Manifest } from "./core.ts";

const { values } = parseArgs({
  options: {
    feed: { type: "string" },
    entry: { type: "string", multiple: true, default: [] },
    manifest: { type: "string" },
  },
});
if (!values.feed) throw new Error("--feed <index.json URL> is required");
const feedUrl = values.feed;

const hosts = new Map<string, number>();
const report = await Effect.runPromise(
  Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.tapRequest((request) =>
        Effect.sync(() => {
          const host = new URL(request.url).host;
          hosts.set(host, (hosts.get(host) ?? 0) + 1);
        }),
      ),
    );
    const catalog = createCatalog({
      egress: { policy: { allowLoopbackHttp: true, allowedHttpOrigins: [] }, client },
      feedUrl,
    });
    const started = performance.now();
    const listing = yield* catalog.list;
    const listMs = Math.round(performance.now() - started);
    if (listing.feed.status !== "listed") throw new Error(`The feed is ${listing.feed.status}`);
    const ids =
      values.entry.length > 0
        ? values.entry
        : (["oauth2", "secrets"] as const).map((kind) => {
            const found = listing.apps.find(
              (app) => app.auth.length > 0 && app.auth.every((auth) => auth.kind === kind),
            );
            if (found === undefined) throw new Error(`No ${kind} entry is listed`);
            return found.id;
          });
    // The index as served, for the hashes the listing does not carry.
    const index = JSON.parse(
      yield* client.get(feedUrl).pipe(Effect.flatMap((response) => response.text)),
    ) as { apps: { id: string; sha256?: string }[] };
    const prepared = [];
    for (const id of ids) {
      const app = yield* catalog.prepare({ entry: id });
      const response = yield* client.get(new URL(`apps/${id}.json`, feedUrl).href);
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const document = JSON.parse(new TextDecoder().decode(bytes)) as { files: unknown };
      prepared.push({
        id,
        auth: listing.apps.find((entry) => entry.id === id)?.auth.map((auth) => auth.kind),
        package: app.origin?.name,
        files: app.files.length,
        bytes: bytes.byteLength,
        sha256,
        matchesIndex: index.apps.find((entry) => entry.id === id)?.sha256 === sha256,
        matchesPrepared: isDeepStrictEqual(document.files, app.files),
      });
    }
    // People's browsers load icons from the addresses the listing gives.
    const iconHosts = new Set(
      listing.apps.flatMap((app) =>
        app.icons.flatMap((icon) => (icon.src.startsWith("data:") ? [] : [new URL(icon.src).host])),
      ),
    );
    return { feedUrl, listed: listing.apps.length, listMs, iconHosts: [...iconHosts], prepared };
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

const manifest = values.manifest
  ? (JSON.parse(await readFile(values.manifest, "utf8")) as Manifest)
  : undefined;
const feedHost = new URL(feedUrl).host;
const problems = [
  ...(manifest && manifest.entries !== report.listed
    ? [`listed ${report.listed} entries, the manifest ${manifest.entries}`]
    : []),
  ...report.prepared.flatMap((entry) =>
    entry.matchesIndex && entry.matchesPrepared
      ? []
      : [`${entry.id}: the prepared source is not the document the index hashes`],
  ),
  ...[...hosts.keys()]
    .filter((host) => host !== feedHost)
    .map((host) => `a request went to ${host}`),
  ...report.iconHosts
    .filter((host) => host !== feedHost)
    .map((host) => `an icon is served from ${host}`),
];
console.log(JSON.stringify({ ...report, hosts: Object.fromEntries(hosts), problems }, null, 2));
if (problems.length > 0) process.exit(1);
