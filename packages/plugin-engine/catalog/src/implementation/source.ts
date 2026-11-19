/** Network adapter for the official app feed: an index of vetted apps and each app's source. */
import { Effect, Exit, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { isTextFile } from "@opensteer/plugin-engine-sdk";
import {
  CatalogEntry,
  CatalogFeed,
  CatalogFeedSource,
  CatalogImportFailed,
  CatalogSourceUnverified,
  CatalogUnavailable,
  PreparedApp,
  type CatalogFeedEntry,
  type CatalogIcon,
  type CatalogSource,
} from "../contracts/catalog.ts";
import { unknownEntryRecovery } from "../contracts/setup.ts";

// An agent may pass a server URL; the reply says what install takes, without repeating it.
const entryMissing = (id: string) =>
  new CatalogImportFailed({
    code: "entry_missing",
    reason: URL.canParse(id)
      ? "This URL is not a catalog entry. Install takes the id of an entry the catalog lists; add a remote MCP server by its URL with the custom MCP import."
      : "This entry is no longer in the catalog. Refresh and choose another app.",
    recovery: unknownEntryRecovery,
  });

const decodeManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

/** The Host reads icons for its clients, so only web and inline image addresses are kept. */
const iconUrl = (src: string, base: string) => {
  if (!URL.canParse(src, base)) return undefined;
  const url = new URL(src, base);
  return ["https:", "http:"].includes(url.protocol) || url.href.startsWith("data:image/")
    ? url.href
    : undefined;
};

const resolveIcons = (icons: readonly CatalogIcon[], base: string) =>
  icons.flatMap((icon) => {
    const src = iconUrl(icon.src, base);
    return src === undefined ? [] : [{ ...icon, src }];
  });

/** The index's apps as last read, with the validator that lets the feed confirm them unchanged. */
interface KeptIndex {
  readonly etag: string;
  readonly listed: readonly CatalogFeedEntry[];
}

/**
 * The address of an entry's source document, or none unless it is below the index on the index's
 * own origin: a relative path of plain segments, none of them `.` or `..`.
 */
export const sourceAddress = (source: string, feedUrl: string) => {
  if (!/^[\w.~-]+(?:\/[\w.~-]+)*$/u.test(source)) return undefined;
  if (source.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  const base = new URL(".", feedUrl);
  const address = new URL(source, base);
  return address.origin === base.origin && address.pathname.startsWith(base.pathname)
    ? address.href
    : undefined;
};

const hex = (digest: ArrayBuffer) =>
  Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Read the feed at `feedUrl`, its `index.json`. Redirects are not followed. Listing reads only the
 * index, and asks the feed whether the index changed since the last read: an unchanged index is
 * not downloaded or decoded again. Listings that start while one is reading share its read.
 *
 * Preparing reads the index the same way, then the chosen entry's `source` document, and installs
 * it only when it is what the index lists: below the index, its bytes matching the
 * entry's `sha256` when it has one, and its package, its `package.json` name and the entry's
 * package the same. A `verified` feed, Opensteer's own, must list each id once and a valid hash
 * for every entry it installs; another feed's first entry with an id is the one listed and
 * installed. Each refusal is `CatalogSourceUnverified`, with its reason logged.
 */
export const catalogSource = (
  client: HttpClient.HttpClient,
  feedUrl: string,
  options: { readonly verified: boolean } = { verified: false },
): CatalogSource => {
  /** A missing document reads as `None`; any other failure is `CatalogUnavailable`. */
  const read = (url: string) =>
    Effect.gen(function* () {
      const response = yield* client.get(url);
      if (response.status === 404) return Option.none<Uint8Array<ArrayBuffer>>();
      if (response.status !== 200) return yield* new CatalogUnavailable();
      return Option.some(new Uint8Array(yield* response.arrayBuffer));
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeout("30 seconds"),
      Effect.mapError(() => new CatalogUnavailable()),
    );
  let kept: KeptIndex | undefined;
  const readIndex = Effect.gen(function* () {
    const previous = kept;
    // Blocked egress usually never answers, and a person waits on this in onboarding, so the feed
    // has 10 seconds to start answering. The transfer and decoding share the 30 seconds below.
    const response = yield* client
      .get(
        feedUrl,
        previous === undefined ? undefined : { headers: { "if-none-match": previous.etag } },
      )
      .pipe(Effect.timeout("10 seconds"));
    if (response.status === 304 && previous !== undefined) return previous.listed;
    if (response.status !== 200) return yield* new CatalogUnavailable();
    const feed = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogFeed))(
      yield* response.text,
    );
    const etag = response.headers["etag"];
    kept = etag === undefined ? undefined : { etag, listed: feed.apps };
    return feed.apps;
  }).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("30 seconds"),
    Effect.mapError(() => new CatalogUnavailable()),
  );
  // Settled through a native promise, so on Workers each waiting request resumes in its own I/O
  // context (see the SDK's Handoff). An interrupted read settles with nothing, and its waiters read.
  let reading:
    Promise<Exit.Exit<readonly CatalogFeedEntry[], CatalogUnavailable> | undefined> | undefined;
  const listed: Effect.Effect<readonly CatalogFeedEntry[], CatalogUnavailable> = Effect.suspend(
    () => {
      const shared = reading;
      if (shared !== undefined)
        return Effect.promise(() => shared).pipe(
          Effect.flatMap((exit) => (exit === undefined ? listed : exit)),
        );
      let settle: (
        exit: Exit.Exit<readonly CatalogFeedEntry[], CatalogUnavailable> | undefined,
      ) => void = () => undefined;
      reading = new Promise((resolve) => {
        settle = resolve;
      });
      return readIndex.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            reading = undefined;
            settle(Exit.hasInterrupts(exit) ? undefined : exit);
          }),
        ),
      );
    },
  );
  /**
   * The entry each id lists and installs. Opensteer's own feed lists each id once, so an id it
   * repeats is a fault: it maps to none, is not listed and installs nothing. Another feed's first
   * entry with an id is the one listed and installed.
   */
  const installable = (entries: readonly CatalogFeedEntry[]) => {
    const byId = new Map<string, CatalogFeedEntry | undefined>();
    for (const entry of entries)
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
      else if (options.verified) byId.set(entry.id, undefined);
    return byId;
  };
  const list = listed.pipe(
    Effect.map((entries) =>
      [...installable(entries).values()].flatMap((entry) => {
        if (entry === undefined) return [];
        const { source: _source, sha256: _sha256, ...listing } = entry;
        return [CatalogEntry.make({ ...listing, icons: resolveIcons(listing.icons, feedUrl) })];
      }),
    ),
  );
  const refuse = (id: string, reason: string) =>
    Effect.logWarning("Catalog app source refused").pipe(
      Effect.annotateLogs({ "catalog.entry.id": id, reason }),
      Effect.andThen(Effect.fail(new CatalogSourceUnverified())),
    );
  return {
    list,
    prepare: (id) =>
      Effect.gen(function* () {
        // Feed entry ids are never URLs, so one is refused without reading the feed.
        if (URL.canParse(id)) return yield* entryMissing(id);
        const entries = installable(yield* listed);
        const entry = entries.get(id);
        if (entry === undefined) {
          if (!entries.has(id)) return yield* entryMissing(id);
          yield* Effect.annotateCurrentSpan({ "catalog.entry.id": id });
          return yield* refuse(id, "Opensteer's feed lists this id more than once");
        }
        // Only a listed catalog identifier is recorded, never an arbitrary lookup input.
        yield* Effect.annotateCurrentSpan({ "catalog.entry.id": id });
        const reference = sourceAddress(entry.source, feedUrl);
        if (reference === undefined)
          return yield* refuse(id, "the entry's source is not a document below the index");
        if (entry.sha256 !== undefined && !/^[0-9a-f]{64}$/u.test(entry.sha256))
          return yield* refuse(id, "the entry's sha256 is not a hex SHA-256");
        if (options.verified && entry.sha256 === undefined)
          return yield* refuse(id, "the entry lists no sha256");
        const found = yield* read(reference);
        if (Option.isNone(found)) return yield* entryMissing(id);
        const sha256 = hex(
          yield* Effect.promise(() => crypto.subtle.digest("SHA-256", found.value)),
        );
        if (entry.sha256 !== undefined && sha256 !== entry.sha256)
          return yield* refuse(id, "the document's bytes do not match the entry's sha256");
        const source = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogFeedSource))(
          new TextDecoder().decode(found.value),
        ).pipe(Effect.mapError(() => new CatalogUnavailable()));
        const manifest = Option.fromNullishOr(
          source.files.find((file) => file.path === "package.json"),
        ).pipe(
          Option.filter(isTextFile),
          Option.flatMap((file) => decodeManifest(file.content)),
        );
        if (
          source.package !== entry.package ||
          !Option.exists(manifest, ({ name }) => name === source.package)
        )
          return yield* refuse(
            id,
            "the entry's package, the document's package and its package.json name differ",
          );
        return PreparedApp.make({
          files: source.files,
          origin: { reference, name: source.package, commit: null, sha256 },
          name: entry.name,
        });
      }),
  };
};

/** Refuse an install when the catalog is off: no entry is listed, so none can be prepared. */
export const turnedOffPrepare = (id: string) => Effect.fail(entryMissing(id));
