/**
 * The pure part of the catalog snapshot: turn a feed's raw documents into files that serve as the
 * same feed from any base URL, and check that a set of files is exactly such a snapshot. Nothing
 * here touches the network or the disk.
 *
 * Layout. Documents and icons are addressed by the SHA-256 of their bytes, so a path never changes
 * meaning and an index cached from an earlier release still finds its documents:
 *
 *   index.json                    the feed; each entry's `source` names its document's path
 *   apps/<id>/<sha256>.json       an entry's source document, `{ package, files }`
 *   apps/<id>.json                the same bytes at the path today's catalog client reads
 *   icons/<sha256>.<ext>          the icons the feed refers to
 *   manifest.json                 every other file's hash and size, and counts
 */
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { CatalogFeed, CatalogFeedSource } from "@opensteer/plugin-engine-catalog/contracts";
import { PackageName } from "@opensteer/plugin-engine-sdk";
import {
  Rewriter,
  rewriteProblems,
  type RewriteRules,
  type Occurrence,
  type Source,
} from "./rewrite.ts";

export interface Problem {
  readonly document: string;
  readonly reason: string;
}
export interface FileRecord {
  readonly sha256: string;
  readonly bytes: number;
}
export interface Manifest {
  readonly version: 2;
  /** The feed document `index.json`. */
  readonly feed: FileRecord;
  /** Entries the index lists, each id once. */
  readonly entries: number;
  readonly documents: number;
  readonly icons: number;
  /** Bytes of every file except this manifest. */
  readonly totalBytes: number;
  /** Ids the source feed listed more than once with identical entries; listed once here. */
  readonly duplicateIds: readonly string[];
  /** SHA-256 of the rewrite rule file the snapshot was built with. Never its strings. */
  readonly rules: string | null;
  /** Every file except this manifest, by path. */
  readonly files: Readonly<Record<string, FileRecord>>;
}

export interface SnapshotInput {
  /** The feed's `index.json`, as served. */
  readonly feed: string;
  /** An entry's source document as served, or undefined when the feed has none. */
  readonly readSource: (id: string) => Promise<string | undefined>;
  /** A relative icon's bytes, or undefined when the feed has none. */
  readonly readIcon: (path: string) => Promise<Uint8Array | undefined>;
  /** Parsed rules, and the SHA-256 of the file they came from. */
  readonly rules?: { readonly rules: RewriteRules; readonly sha256: string };
}

/** The private account of a rewrite: counts per rule and every remaining name with its reason. */
export interface RewriteReport {
  readonly rules: ReadonlyArray<{ id: string; scope: string; count: number }>;
  readonly remaining: readonly Occurrence[];
}

export interface SnapshotResult {
  /** Every file of the snapshot, `manifest.json` included. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly manifest: Manifest;
  /** Problems that make the snapshot unusable. */
  readonly failures: readonly Problem[];
  readonly report: RewriteReport;
}

const segment = /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/u;
const hex64 = /^[0-9a-f]{64}$/u;
/** Whether an id can name its files: one plain path segment that cannot collide with another's. */
export const servableId = (id: string) => segment.test(id) && !id.endsWith(".json");
export const sourcePath = (id: string, sha256: string) => `apps/${id}/${sha256}.json`;
export const legacySourcePath = (id: string) => `apps/${id}.json`;
export const iconFile = (sha256: string, extension: string) => `icons/${sha256}.${extension}`;

/**
 * Where a relative icon lives in the source feed, or undefined for an address outside it. The
 * client resolves icons against the feed's URL, so only plain paths that stay below it are copied.
 */
export function iconPath(src: string): string | undefined {
  const base = new URL("https://feed.invalid/catalog/index.json");
  if (!URL.canParse(src, base)) return undefined;
  const url = new URL(src, base);
  if (url.origin !== base.origin || url.search || url.hash) return undefined;
  if (!url.pathname.startsWith("/catalog/")) return undefined;
  const path = url.pathname.slice("/catalog/".length);
  const plain = path.split("/").every((part) => segment.test(part));
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

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const record = (bytes: Uint8Array): FileRecord => ({
  sha256: sha256(bytes),
  bytes: bytes.byteLength,
});

const decodeFeed = Schema.decodeUnknownResult(CatalogFeed);
const decodeSource = Schema.decodeUnknownResult(CatalogFeedSource);
const isPackageName = Schema.is(PackageName);
const decodeManifestName = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

/** What the catalog client refuses when it prepares this document, or a name it cannot carry. */
function sourceProblem(value: unknown, listed: string): string | undefined {
  const decoded = decodeSource(value);
  if (decoded._tag === "Failure") return `not a catalog source: ${decoded.failure.message}`;
  const { files, package: name } = decoded.success;
  const manifest = files.find((file) => file.path === "package.json");
  if (manifest === undefined || "encoding" in manifest || "object" in manifest)
    return "package.json is missing or not text";
  const parsed = decodeManifestName(manifest.content);
  if (parsed._tag === "Failure") return "package.json has no name";
  if (parsed.success.name !== name)
    return `package.json names ${parsed.success.name}, the document ${name}`;
  if (name !== listed) return `the index lists ${listed}, the document ${name}`;
  if (!isPackageName(name)) return `${name} is not a valid package name`;
  return undefined;
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
const encoder = new TextEncoder();
type Entry = { id: string; package: string; icons: { src: string }[]; [key: string]: unknown };

/**
 * Rewrite, validate, lay out and hash a feed. Every problem is collected rather than thrown, so
 * one run lists them all; the caller decides whether the result is usable.
 */
export async function buildSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const rewriter = new Rewriter(
    input.rules?.rules ?? { version: 1, names: [], rules: [], preserve: [] },
  );
  const failures: Problem[] = [];
  const files = new Map<string, Uint8Array>();

  const raw = parse(input.feed);
  const feed = decodeFeed(raw);
  if (feed._tag === "Failure")
    throw new Error(`index.json is not a catalog feed: ${feed.failure.message}`);
  const { apps: rawApps, ...feedFields } = raw as { apps: Entry[] };

  // One listing per id: an identical repeat is dropped, a different one is a failure.
  const listed = new Map<string, string>();
  const duplicateIds = new Set<string>();
  const unique: { entry: Entry; index: number }[] = [];
  for (const [index, entry] of rawApps.entries()) {
    const text = serialize(entry);
    const earlier = listed.get(entry.id);
    if (earlier === undefined) {
      listed.set(entry.id, text);
      unique.push({ entry, index });
    } else if (earlier === text) duplicateIds.add(entry.id);
    else
      failures.push({
        document: `index.json#/apps/${index}`,
        reason: `${entry.id} is listed again with different fields`,
      });
  }

  const icons = new Map<string, string>();
  const iconFor = async (src: string, document: string) => {
    if (src.startsWith("data:")) return src;
    const path = iconPath(src);
    const extension = path === undefined ? undefined : /\.([A-Za-z0-9]{1,8})$/u.exec(path)?.[1];
    if (path === undefined || extension === undefined) {
      failures.push({ document, reason: `icon ${src} is not a file inside the feed` });
      return src;
    }
    if (!icons.has(path)) {
      const bytes = await input.readIcon(path);
      if (bytes === undefined) {
        failures.push({ document, reason: `the feed has no icon ${path}` });
        return src;
      }
      const name = iconFile(sha256(bytes), extension.toLowerCase());
      files.set(name, bytes);
      icons.set(path, name);
    }
    return icons.get(path)!;
  };

  const apps: Entry[] = [];
  for (const { entry, index } of unique) {
    const at = `index.json#/apps/${index}`;
    if (!servableId(entry.id)) {
      failures.push({ document: at, reason: `id ${JSON.stringify(entry.id)} cannot name a file` });
      continue;
    }
    const output = rewriter.entry(entry);
    output.icons = [];
    for (const icon of entry.icons)
      output.icons.push({ ...icon, src: await iconFor(icon.src, at) });
    const document = legacySourcePath(entry.id);
    const text = await input.readSource(entry.id);
    const source = text === undefined ? undefined : parse(text);
    const decoded = decodeSource(source);
    if (decoded._tag === "Failure") {
      failures.push({
        document,
        reason:
          text === undefined
            ? "the feed has no source document for this entry"
            : source === undefined
              ? "not JSON"
              : `not a catalog source: ${decoded.failure.message}`,
      });
      continue;
    }
    const rewritten = rewriter.document(entry.id, source as Source);
    for (const reason of [
      ...rewritten.problems,
      ...rewriteProblems(source as Source, rewritten.source),
      sourceProblem(rewritten.source, output.package) ?? [],
    ].flat())
      failures.push({ document, reason });
    rewriter.accountSource(entry.id, document, rewritten.source);
    const bytes = encoder.encode(serialize(rewritten.source));
    const hash = sha256(bytes);
    files.set(sourcePath(entry.id, hash), bytes);
    files.set(document, bytes);
    apps.push({ ...output, source: sourcePath(entry.id, hash), sha256: hash });
  }

  const index = { ...feedFields, apps };
  for (const [position, app] of apps.entries())
    for (const [field, value] of Object.entries(app))
      if (typeof value === "string")
        rewriter.account(app.id, `index.json#/apps/${position}/${field}`, value);
  const indexBytes = encoder.encode(serialize(index));
  files.set("index.json", indexBytes);
  if (decodeFeed(index)._tag === "Failure")
    failures.push({ document: "index.json", reason: "the rewritten index is not a catalog feed" });

  const unaccounted = rewriter.remaining.filter((occurrence) => occurrence.reason === null);
  for (const occurrence of unaccounted)
    failures.push({
      document: occurrence.location,
      reason: "a name remains that no rule rewrites and no preserve entry keeps",
    });

  const sorted = [...files.keys()].sort();
  const records = Object.fromEntries(sorted.map((path) => [path, record(files.get(path)!)]));
  const manifest: Manifest = {
    version: 2,
    feed: records["index.json"]!,
    entries: apps.length,
    documents: apps.length,
    icons: icons.size,
    totalBytes: Object.values(records).reduce((sum, file) => sum + file.bytes, 0),
    duplicateIds: [...duplicateIds].sort(),
    rules: input.rules?.sha256 ?? null,
    files: records,
  };
  files.set("manifest.json", encoder.encode(serialize(manifest)));
  return {
    files,
    manifest,
    failures,
    report: {
      rules: (input.rules?.rules.rules ?? []).map((rule) => ({
        id: rule.id,
        scope: rule.scope,
        count: rewriter.counts.get(rule.id)!,
      })),
      remaining: rewriter.remaining,
    },
  };
}

/** The kind of path a snapshot file has, or undefined for one that has no place in a snapshot. */
export function snapshotPathKind(
  path: string,
): "index" | "manifest" | "document" | "legacy" | "icon" | undefined {
  if (path === "index.json") return "index";
  if (path === "manifest.json") return "manifest";
  const parts = path.split("/");
  if (parts[0] === "apps" && parts.length === 3 && servableId(parts[1]!))
    return hex64.test(parts[2]!.replace(/\.json$/u, "")) && parts[2]!.endsWith(".json")
      ? "document"
      : undefined;
  if (parts[0] === "apps" && parts.length === 2 && parts[1]!.endsWith(".json"))
    return servableId(parts[1]!.slice(0, -".json".length)) ? "legacy" : undefined;
  if (parts[0] === "icons" && parts.length === 2) {
    const [hash, extension, ...rest] = parts[1]!.split(".");
    return hex64.test(hash!) && /^[a-z0-9]{1,8}$/u.test(extension ?? "") && rest.length === 0
      ? "icon"
      : undefined;
  }
  return undefined;
}

/**
 * Every way a set of files differs from the snapshot its `manifest.json` describes: each file
 * listed with its hash and size and nothing else present; every path one the layout allows; each
 * content-addressed file named by its own hash; every index entry's document present, hashed as
 * the entry says, valid, and the same bytes at its legacy path; every icon an entry names present.
 * Files with any problem must not be published.
 */
export function snapshotProblems(files: ReadonlyMap<string, Uint8Array>): string[] {
  const problems: string[] = [];
  const manifestBytes = files.get("manifest.json");
  const manifest = manifestBytes && (parse(new TextDecoder().decode(manifestBytes)) as Manifest);
  if (!manifest || manifest.version !== 2 || typeof manifest.files !== "object")
    return ["manifest.json is missing or not a version 2 manifest"];
  for (const [path, expected] of Object.entries(manifest.files)) {
    const bytes = files.get(path);
    if (bytes === undefined) problems.push(`${path} is missing`);
    else if (!isDeepStrictEqualRecord(record(bytes), expected))
      problems.push(`${path} differs from the manifest`);
  }
  for (const path of files.keys()) {
    if (path !== "manifest.json" && manifest.files[path] === undefined)
      problems.push(`${path} is not in the manifest`);
    const kind = snapshotPathKind(path);
    if (kind === undefined) problems.push(`${path} has no place in a snapshot`);
    const bytes = files.get(path)!;
    if (kind === "document" && path.split("/")[2] !== `${sha256(bytes)}.json`)
      problems.push(`${path} is not named by its hash`);
    if (kind === "icon" && !path.startsWith(`icons/${sha256(bytes)}.`))
      problems.push(`${path} is not named by its hash`);
  }
  const index = files.get("index.json");
  if (index === undefined) return [...problems, "index.json is missing"];
  if (!isDeepStrictEqualRecord(record(index), manifest.feed))
    problems.push("the manifest's feed is not its index.json");
  const rawIndex = parse(new TextDecoder().decode(index));
  if (decodeFeed(rawIndex)._tag === "Failure")
    return [...problems, "index.json is not a catalog feed"];
  // As written: decoding drops the fields the contract does not name, such as `sha256`.
  const apps = (rawIndex as { apps: (Entry & { source: string; sha256?: unknown })[] }).apps;
  if (manifest.entries !== apps.length)
    problems.push("the manifest's entry count is not the index's");
  const referenced = new Set(["index.json"]);
  const seen = new Set<string>();
  for (const app of apps) {
    if (seen.has(app.id)) problems.push(`${app.id} is listed twice`);
    seen.add(app.id);
    const hash = typeof app.sha256 === "string" ? app.sha256 : "";
    if (app.source !== sourcePath(app.id, hash) || !hex64.test(hash))
      problems.push(`${app.id}: its source is not its document's content address`);
    const bytes = files.get(app.source);
    if (bytes === undefined || sha256(bytes) !== hash)
      problems.push(`${app.id}: no document with its hash`);
    else {
      const legacy = files.get(legacySourcePath(app.id));
      if (legacy === undefined || !Buffer.from(legacy).equals(bytes))
        problems.push(`${app.id}: ${legacySourcePath(app.id)} is not the same document`);
      const problem = sourceProblem(parse(new TextDecoder().decode(bytes)), app.package);
      if (problem !== undefined) problems.push(`${app.id}: ${problem}`);
    }
    referenced.add(app.source).add(legacySourcePath(app.id));
    for (const icon of app.icons) {
      if (icon.src.startsWith("data:")) continue;
      if (snapshotPathKind(icon.src) !== "icon" || !files.has(icon.src))
        problems.push(`${app.id}: icon ${icon.src} is not a file in the snapshot`);
      referenced.add(icon.src);
    }
  }
  for (const path of files.keys())
    if (path !== "manifest.json" && !referenced.has(path))
      problems.push(`${path} is not referenced by the index`);
  return problems;
}

const isDeepStrictEqualRecord = (a: FileRecord, b: FileRecord | undefined) =>
  b !== undefined && a.sha256 === b.sha256 && a.bytes === b.bytes;
