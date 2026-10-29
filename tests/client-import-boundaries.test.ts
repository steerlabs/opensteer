import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { isRecord } from "@opensteer/shared/isRecord";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * The entry points a React Native bundle is allowed to reach. Metro has no
 * `node:*` shims and Hermes has no `crypto` global, so anything these roots
 * pull in transitively must be portable TypeScript. Unlike a web build there
 * is no tree shaking to hide a stray Node import behind an unused export: the
 * bundler follows the module, not the binding.
 *
 * Extend this list when a package becomes client-reachable, and move the
 * Node-only half of a package behind a subpath export — the way
 * `@opensteer/core` keeps `node:crypto` behind `@opensteer/core/crypto` —
 * rather than rewriting a server helper to survive in a root export.
 */
const roots: readonly string[] = [
  "packages/core/src/index.ts",
  "packages/protocol/src/index.ts",
  "packages/protocol/src/browser.ts",
  "packages/protocol/src/desktop.ts",
  "packages/deployment-authority/src/index.ts",
  "packages/control-plane-protocol/src/index.ts",
  "packages/triggers/src/index.ts",
  "packages/channel-core/src/index.ts",
  "packages/integration-core/src/index.ts",
];

/** Every non-test source in `packages/client`, which is client-only by definition. */
const clientPackageRoots = sourcesUnder("packages/client/src");

/** Bare specifiers that only resolve inside a Node runtime. */
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/** Packages whose presence in the graph means the module cannot run on a phone. */
const hostOnlyPackages = new Set(["electron", "react-dom"]);

/**
 * A denied package denies its subpaths. `react-dom/client` and
 * `react-dom/server` are the specifiers the web app actually writes, and an
 * exact-name set would wave them past as ordinary third-party packages the
 * guard does not follow — the same hole a future bare `fs/promises` would use.
 */
function isDenied(specifier: string): boolean {
  if (nodeBuiltins.has(specifier) || hostOnlyPackages.has(specifier)) return true;
  const separator = specifier.indexOf("/", subpathSearchStart(specifier));
  if (separator === -1) return false;
  const root = specifier.slice(0, separator);
  return nodeBuiltins.has(root) || hostOnlyPackages.has(root);
}

/** A `node:` prefix and an npm scope both carry a slash that is part of the
 * package name rather than the start of a subpath. */
function subpathSearchStart(specifier: string): number {
  if (specifier.startsWith("node:")) return "node:".length;
  if (!specifier.startsWith("@")) return 0;
  const scope = specifier.indexOf("/");
  return scope === -1 ? 0 : scope + 1;
}

/**
 * The standard-library members Hermes — the engine the phone runs on — does
 * not have. A browser and Node have all of them, so this is the one class of
 * mistake that passes every test and every typecheck and then throws on a
 * device: sort a copy in place instead of `toSorted`, and group with a `Map`
 * instead of `Object.groupBy`.
 *
 * The list is what the engine this tree ships actually answered when asked
 * (`hermesvm` 250829098.0.17, React Native 0.86), not what a compatibility
 * table says: `toReversed`, `toSpliced`, `Array.prototype.with`, `findLast`,
 * `findLastIndex` and `Promise.withResolvers` are all present there, and only
 * these two are missing. Re-ask the engine before editing this.
 */
const missingInHermes = /\.toSorted\s*\(|\bObject\s*\.\s*groupBy\s*\(/u;

const workspaceManifests = readWorkspaceManifests();

describe("client import boundaries", () => {
  it("keeps the client-reachable graph free of Node-only code", () => {
    const violations = walk([...roots, ...clientPackageRoots]);

    expect(violations).toEqual([]);
  });

  it("reads the specifiers a guard has to see, and ignores the ones it must not", () => {
    expect(
      specifiersOf(
        [
          'import { a } from "./a.js";',
          'import type { B } from "./b.js";',
          'import "./side-effect.js";',
          "import {",
          "  c,",
          "  d,",
          '} from "./c.js";',
          'export * from "./e.js";',
          'export type { F } from "./f.js";',
          'export { g } from "./g.js";',
          'import * as ns from "./h.js";',
          'const lazy = await import("./i.js");',
          " * import { fake } from './comment.js';",
        ].join("\n"),
      ).sort(),
    ).toEqual(
      ["./a.js", "./side-effect.js", "./c.js", "./e.js", "./g.js", "./h.js", "./i.js"].sort(),
    );
  });

  it("keeps the members Hermes does not have out of the client-reachable graph", () => {
    const offenders = reachableFiles([...roots, ...clientPackageRoots]).filter((file) =>
      missingInHermes.test(readFileSync(path.join(repositoryRoot, file), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("recognises each member Hermes is missing, and leaves its neighbours alone", () => {
    expect(
      [
        "const ordered = rows.toSorted(byName);",
        "const ordered = rows\n  .toSorted();",
        "const grouped = Object.groupBy(rows, pick);",
        "const grouped = Object . groupBy (rows, pick);",
      ].filter((sample) => !missingInHermes.test(sample)),
    ).toEqual([]);

    expect(
      [
        "const ordered = [...rows].sort(byName);",
        "const reversed = rows.toReversed();",
        "const spliced = rows.toSpliced(0, 1);",
        "const replaced = rows.with(0, next);",
        "const last = rows.findLast(isReady);",
        "const { promise, resolve } = Promise.withResolvers();",
        "const grouped = groupBy(rows, pick);",
        "rows.toSortedByName();",
      ].filter((sample) => missingInHermes.test(sample)),
    ).toEqual([]);
  });

  it("keeps Web Crypto's SubtleCrypto out of the client-reachable graph", () => {
    // Hermes has no `crypto` global at all. The phone installs the entropy the
    // shared client needs — `getRandomValues` and `randomUUID` — and nothing
    // else: `crypto.subtle` is a whole algorithm surface no polyfill should be
    // asked to stand in for. A digest that has to run on a phone is taken with
    // `@noble/hashes`, the way `hostKeyFingerprint` already takes one.
    const forbidden = /\bcrypto\s*\.\s*subtle\b/u;
    const offenders = reachableFiles([...roots, ...clientPackageRoots]).filter((file) =>
      forbidden.test(readFileSync(path.join(repositoryRoot, file), "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  it("denies a forbidden package by its subpaths as well as its name", () => {
    expect(
      [
        "electron",
        "react-dom",
        "react-dom/client",
        "react-dom/server",
        "node:fs",
        "node:fs/promises",
        "fs/promises",
        "electron/main",
      ].filter((specifier) => !isDenied(specifier)),
    ).toEqual([]);

    expect(
      ["react", "react/jsx-runtime", "zod", "@opensteer/client/host", "react-dom-factory"].filter(
        isDenied,
      ),
    ).toEqual([]);
  });
});

interface Violation {
  readonly specifier: string;
  readonly chain: readonly string[];
}

/**
 * Depth-first over the transitive graph, keeping the first path that reaches
 * each module so a failure names the import chain rather than a bare file.
 */
function walk(entries: readonly string[]): string[] {
  const violations: Violation[] = [];
  const visited = new Set<string>();

  for (const entry of entries) {
    if (!existsSync(path.join(repositoryRoot, entry))) {
      throw new Error(`Import-boundary root ${entry} does not exist.`);
    }
    visit(entry, [entry], visited, violations);
  }

  return violations.map(({ specifier, chain }) => `${specifier} <- ${chain.join(" <- ")}`).sort();
}

/** Every source the client-reachable graph actually pulls in, roots included. */
function reachableFiles(entries: readonly string[]): string[] {
  const visited = new Set<string>();
  for (const entry of entries) visit(entry, [entry], visited, []);
  return [...visited].sort();
}

function visit(
  file: string,
  chain: readonly string[],
  visited: Set<string>,
  violations: Violation[],
): void {
  if (visited.has(file)) return;
  visited.add(file);

  for (const specifier of specifiersOf(readFileSync(path.join(repositoryRoot, file), "utf8"))) {
    if (isDenied(specifier)) {
      violations.push({ specifier, chain });
      continue;
    }
    const resolved = resolve(specifier, file);
    if (resolved === null) continue;
    if (resolved.startsWith("apps/")) {
      violations.push({ specifier: `${specifier} (${resolved})`, chain });
      continue;
    }
    visit(resolved, [resolved, ...chain], visited, violations);
  }
}

/**
 * Resolves to a repository-relative source file, or null for a third-party
 * package the guard does not follow. Throws when a workspace specifier names
 * no export, because an unresolvable `@opensteer/*` import is a broken
 * boundary rather than something to skip quietly.
 */
function resolve(specifier: string, importer: string): string | null {
  if (specifier.startsWith(".")) {
    const target = path.posix.join(path.posix.dirname(importer), specifier);
    const resolved = sourceFileFor(target);
    if (resolved === null) {
      throw new Error(`${importer} imports ${specifier}, which resolves to no source file.`);
    }
    return resolved;
  }

  if (!specifier.startsWith("@opensteer/")) return null;

  const [scope, name, ...rest] = specifier.split("/");
  const packageName = `${scope}/${name}`;
  const manifest = workspaceManifests.get(packageName);
  if (manifest === undefined) {
    throw new Error(`${importer} imports ${specifier}, which is not a workspace package.`);
  }
  const subpath = rest.length === 0 ? "." : `./${rest.join("/")}`;
  const target = manifest.exports[subpath];
  if (target === undefined) {
    throw new Error(`${importer} imports ${specifier}, which ${packageName} does not export.`);
  }
  return path.posix.join(manifest.directory, target);
}

/** NodeNext spells a TypeScript source with the `.js` extension it will emit. */
function sourceFileFor(target: string): string | null {
  const candidates = target.endsWith(".js")
    ? [`${target.slice(0, -".js".length)}.ts`, `${target.slice(0, -".js".length)}.tsx`, target]
    : [`${target}.ts`, `${target}.tsx`, target, `${target}/index.ts`, `${target}/index.tsx`];

  return candidates.find((candidate) => isFile(candidate)) ?? null;
}

function isFile(relativePath: string): boolean {
  const absolute = path.join(repositoryRoot, relativePath);
  return existsSync(absolute) && statSync(absolute).isFile();
}

/**
 * A statement-anchored scan rather than a parse: enough for a guard, and it
 * skips JSDoc lines (which start with `*`) and `import type` / `export type`,
 * which erase before the bundler sees them. `verbatimModuleSyntax` keeps
 * `import { type A } from "x"` as a runtime import, so an inline type modifier
 * is deliberately still followed.
 */
function specifiersOf(source: string): string[] {
  const specifiers: string[] = [];
  const statement = /^[ \t]*(?:import|export)\b([^;'"]*?)\bfrom\s*["']([^"']+)["']/gmu;
  const sideEffect = /^[ \t]*import\s*["']([^"']+)["']/gmu;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;

  for (const match of source.matchAll(statement)) {
    const [, clause, specifier] = match;
    if (clause === undefined || specifier === undefined) continue;
    if (/^\s*type\b/u.test(clause)) continue;
    specifiers.push(specifier);
  }
  for (const match of [...source.matchAll(sideEffect), ...source.matchAll(dynamic)]) {
    const specifier = match[1];
    if (specifier !== undefined) specifiers.push(specifier);
  }

  return specifiers;
}

interface WorkspaceManifest {
  readonly directory: string;
  readonly exports: Readonly<Record<string, string>>;
}

function readWorkspaceManifests(): ReadonlyMap<string, WorkspaceManifest> {
  const manifests = new Map<string, WorkspaceManifest>();

  for (const workspace of ["apps", "packages"]) {
    for (const entry of readdirSync(path.join(repositoryRoot, workspace))) {
      const directory = `${workspace}/${entry}`;
      const manifestPath = path.join(repositoryRoot, directory, "package.json");
      if (!existsSync(manifestPath)) continue;
      const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!isRecord(manifest) || typeof manifest["name"] !== "string") continue;
      const exported = manifest["exports"];
      manifests.set(manifest["name"], {
        directory,
        exports: isRecord(exported) ? stringValuesOf(exported) : {},
      });
    }
  }

  return manifests;
}

/** Conditional export objects are skipped: every workspace subpath is a plain path. */
function stringValuesOf(record: Readonly<Record<string, unknown>>): Record<string, string> {
  const exports: Record<string, string> = {};
  for (const [subpath, target] of Object.entries(record)) {
    if (typeof target === "string") exports[subpath] = target;
  }
  return exports;
}

/** The directory is optional: a parallel change may not have created it yet. */
function sourcesUnder(directory: string): string[] {
  const absolute = path.join(repositoryRoot, directory);
  if (!existsSync(absolute)) return [];

  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
        !entry.name.includes(".test."),
    )
    .map((entry) =>
      path.posix.join(
        directory,
        path.relative(absolute, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
      ),
    );
}
