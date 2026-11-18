/**
 * The pure part of the catalog snapshot: turn a feed's raw documents into a directory that serves
 * as the same feed from any base URL. `index.json` sits at the root, each entry's source at
 * `apps/<id>.json` (the only place the catalog client reads it), and each relative icon at its own
 * relative path. Nothing here touches the network or the disk; `buildSnapshot` reads and writes
 * through the functions it is given.
 */
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { CatalogFeed, CatalogFeedSource } from "@opensteer/plugin-engine-catalog/contracts";

/** Exact string replacements, applied in order. */
export type Rewrites = ReadonlyArray<readonly [from: string, to: string]>;

export interface Problem {
  readonly document: string;
  readonly reason: string;
}

export interface Manifest {
  readonly version: 1;
  /** The feed document `index.json`. */
  readonly feed: { readonly sha256: string; readonly bytes: number };
  /** Entries listed in the feed, duplicates included. */
  readonly entries: number;
  /** Distinct source documents under `apps/`. */
  readonly documents: number;
  readonly icons: number;
  /** Bytes of every file except this manifest. */
  readonly totalBytes: number;
  /** Ids the feed lists more than once; every listing reads the same document. */
  readonly duplicateIds: readonly string[];
  /** Icon addresses outside the feed, left as they are. */
  readonly externalIcons: readonly string[];
  readonly rewrites: ReadonlyArray<{ from: string; to: string; count: number }>;
  /** Every file except this manifest, by path. An entry's source is `apps/<id>.json`. */
  readonly files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>;
}

export interface SnapshotInput {
  /** The feed's `index.json`, as served. */
  readonly feed: string;
  /** An entry's source document as served, or undefined when the feed has none. */
  readonly readSource: (id: string) => Promise<string | undefined>;
  /** A relative icon's bytes, or undefined when the feed has none. */
  readonly readIcon: (path: string) => Promise<Uint8Array | undefined>;
  readonly write: (path: string, bytes: Uint8Array) => Promise<void>;
  readonly rewrites: Rewrites;
}

export interface SnapshotResult {
  readonly manifest: Manifest;
  /** Documents that do not satisfy the catalog contracts. A snapshot with any is not usable. */
  readonly failures: readonly Problem[];
  /** Old strings still present after rewriting. A snapshot with any is not usable. */
  readonly leftovers: ReadonlyArray<{ from: string; count: number; first: string }>;
}

/** Check a mapping module's export: pairs of strings, each old string non-empty and listed once. */
export function checkRewrites(value: unknown): Rewrites {
  if (
    !Array.isArray(value) ||
    !value.every(
      (pair): pair is [string, string] =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string" &&
        pair[0] !== "",
    )
  )
    throw new Error("A mapping is a list of [old, new] string pairs with non-empty old strings");
  const repeated = value.find(([from], index) => value.findIndex(([f]) => f === from) !== index);
  if (repeated) throw new Error(`The mapping lists ${JSON.stringify(repeated[0])} twice`);
  return value;
}

/** The path an entry's source is served at, and whether an id can be one. */
export const sourcePath = (id: string) => `apps/${id}.json`;
const servableId = (id: string) => id !== "." && id !== ".." && encodeURIComponent(id) === id;

/**
 * Where a relative icon lives inside the snapshot, or undefined for an address outside it. The
 * client resolves icons against the feed's URL, so only plain paths that stay below it are copied.
 */
export function iconPath(src: string): string | undefined {
  const base = new URL("https://feed.invalid/catalog/index.json");
  if (!URL.canParse(src, base)) return undefined;
  const url = new URL(src, base);
  if (url.origin !== base.origin || url.search || url.hash) return undefined;
  if (!url.pathname.startsWith("/catalog/")) return undefined;
  const path = url.pathname.slice("/catalog/".length);
  const plain = path
    .split("/")
    .every((segment) => /^[A-Za-z0-9._~-]+$/u.test(segment) && !/^\.\.?$/u.test(segment));
  return plain && path !== "index.json" ? path : undefined;
}

/** Stable text for a JSON value: keys sorted, two-space indentation, one trailing newline. */
export function serialize(value: unknown): string {
  const sorted = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(sorted)
      : item !== null && typeof item === "object"
        ? Object.fromEntries(
            Object.keys(item)
              .sort()
              .map((key) => [key, sorted((item as Record<string, unknown>)[key])]),
          )
        : item;
  return JSON.stringify(sorted(value), null, 2) + "\n";
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Every string value in a JSON document except base64 file contents, with its JSON pointer. */
function* strings(value: unknown, pointer = ""): Generator<[string, string]> {
  if (typeof value === "string") yield [pointer, value];
  else if (Array.isArray(value))
    for (const [index, item] of value.entries()) yield* strings(item, `${pointer}/${index}`);
  else if (value !== null && typeof value === "object")
    for (const [key, item] of Object.entries(value)) {
      if (key === "content" && "encoding" in value) continue;
      yield* strings(item, `${pointer}/${key}`);
    }
}

/** Counts each mapping entry's replacements across every document it rewrites. */
export class Rewriter {
  readonly rewrites: Rewrites;
  readonly counts: number[];
  constructor(rewrites: Rewrites) {
    this.rewrites = rewrites;
    this.counts = rewrites.map(() => 0);
  }
  text(value: string): string {
    return this.rewrites.reduce((text, [from, to], index) => {
      const parts = text.split(from);
      this.counts[index]! += parts.length - 1;
      return parts.join(to);
    }, value);
  }
  /** A copy of a JSON document with every string value rewritten, except base64 contents. */
  json(value: unknown): unknown {
    if (typeof value === "string") return this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.json(item));
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "content" && "encoding" in value ? item : this.json(item),
      ]),
    );
  }
}

const decodeFeed = Schema.decodeUnknownResult(CatalogFeed);
const decodeSource = Schema.decodeUnknownResult(CatalogFeedSource);
const decodeManifest = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

/** What the catalog client refuses when it prepares this document, if anything. */
function sourceProblem(value: unknown): string | undefined {
  const decoded = decodeSource(value);
  if (decoded._tag === "Failure") return `not a catalog source: ${decoded.failure.message}`;
  const { files, package: name } = decoded.success;
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest === undefined || "encoding" in manifest || "object" in manifest)
    return "package.json is missing or not text";
  const parsed = decodeManifest(manifest.content);
  if (parsed._tag === "Failure") return "package.json has no name";
  if (parsed.success.name !== name)
    return `package.json names ${parsed.success.name}, the document ${name}`;
  return undefined;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * Rewrite, validate, lay out and hash a feed. Each index entry gains `sha256`, the hash of the
 * exact bytes of its source document, and its `source` is the path the client reads. Every
 * problem is collected rather than thrown, so one run lists them all; the caller decides whether
 * the result is usable.
 */
export async function buildSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const rewriter = new Rewriter(input.rewrites);
  const failures: Problem[] = [];
  const files: Record<string, { sha256: string; bytes: number }> = {};
  const encoder = new TextEncoder();
  const write = async (path: string, bytes: Uint8Array) => {
    files[path] = { sha256: sha256(bytes), bytes: bytes.byteLength };
    await input.write(path, bytes);
  };
  const remaining = input.rewrites.map(([from]) => ({ from, count: 0, first: "" }));
  const check = (document: string, value: unknown) => {
    for (const [pointer, text] of strings(value))
      for (const leftover of remaining) {
        const count = text.split(leftover.from).length - 1;
        if (count === 0) continue;
        leftover.count += count;
        leftover.first ||= `${document}#${pointer}`;
      }
  };

  const raw = parse(input.feed);
  const rewritten = rewriter.json(raw);
  const feed = decodeFeed(rewritten);
  if (feed._tag === "Failure")
    throw new Error(`index.json is not a catalog feed: ${feed.failure.message}`);
  const apps = (rewritten as { apps: Record<string, unknown>[] }).apps;
  const rawApps = (raw as { apps: { id: string; icons: { src: string }[] }[] }).apps;

  // Each distinct id has one document; an id listed twice reads the same one.
  const ids = new Map<string, string>();
  const duplicateIds = new Set<string>();
  const externalIcons = new Set<string>();
  const icons = new Map<string, string | undefined>();
  for (const [index, entry] of feed.success.apps.entries()) {
    const rawEntry = rawApps[index]!;
    for (const [iconIndex, icon] of entry.icons.entries()) {
      const path = iconPath(icon.src);
      if (path !== undefined) icons.set(path, iconPath(rawEntry.icons[iconIndex]!.src));
      else if (!icon.src.startsWith("data:")) externalIcons.add(icon.src);
    }
    if (!servableId(entry.id))
      failures.push({
        document: `index.json#/apps/${index}`,
        reason: `id ${JSON.stringify(entry.id)} cannot be a path segment`,
      });
    else if (ids.has(entry.id)) duplicateIds.add(entry.id);
    else ids.set(entry.id, rawEntry.id);
  }

  const hashes = new Map<string, string>();
  for (const [id, rawId] of ids) {
    const document = sourcePath(id);
    const text = await input.readSource(rawId);
    const source = text === undefined ? undefined : parse(text);
    if (source === undefined) {
      failures.push({
        document,
        reason: text === undefined ? "the feed has no source document for this entry" : "not JSON",
      });
      continue;
    }
    const output = rewriter.json(source);
    check(document, output);
    const problem = sourceProblem(output);
    if (problem !== undefined) failures.push({ document, reason: problem });
    await write(document, encoder.encode(serialize(output)));
    hashes.set(id, files[document]!.sha256);
  }
  for (const app of apps) {
    const hash = hashes.get(app.id as string);
    if (hash === undefined) continue;
    app.source = sourcePath(app.id as string);
    app.sha256 = hash;
  }

  for (const [path, rawPath] of [...icons].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const bytes = rawPath === undefined ? undefined : await input.readIcon(rawPath);
    if (bytes === undefined) failures.push({ document: path, reason: "the feed has no such icon" });
    else await write(path, bytes);
  }

  check("index.json", rewritten);
  await write("index.json", encoder.encode(serialize(rewritten)));
  const sorted = Object.fromEntries(
    Object.keys(files)
      .sort()
      .map((path) => [path, files[path]!]),
  );
  return {
    manifest: {
      version: 1,
      feed: files["index.json"]!,
      entries: apps.length,
      documents: hashes.size,
      icons: [...icons.keys()].filter((path) => files[path] !== undefined).length,
      totalBytes: Object.values(files).reduce((sum, file) => sum + file.bytes, 0),
      duplicateIds: [...duplicateIds].sort(),
      externalIcons: [...externalIcons].sort(),
      rewrites: input.rewrites.map(([from, to], index) => ({
        from,
        to,
        count: rewriter.counts[index]!,
      })),
      files: sorted,
    },
    failures,
    leftovers: remaining.filter((leftover) => leftover.count > 0),
  };
}

/**
 * Differences between a snapshot directory's files and its manifest: every listed file present
 * with its hash and size, and nothing else beside the manifest. A directory with any is not the
 * snapshot the manifest describes and must not be published.
 */
export function manifestProblems(
  manifest: Pick<Manifest, "files" | "feed">,
  files: Readonly<Record<string, { readonly sha256: string; readonly bytes: number }>>,
): string[] {
  const problems: string[] = [];
  for (const [path, expected] of Object.entries(manifest.files)) {
    const actual = files[path];
    if (actual === undefined) problems.push(`${path} is missing`);
    else if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes)
      problems.push(`${path} differs from the manifest`);
  }
  for (const path of Object.keys(files))
    if (path !== "manifest.json" && manifest.files[path] === undefined)
      problems.push(`${path} is not in the manifest`);
  const index = manifest.files["index.json"];
  if (index?.sha256 !== manifest.feed.sha256)
    problems.push("the manifest's feed is not its index.json");
  return problems;
}
