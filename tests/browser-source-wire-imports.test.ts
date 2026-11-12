import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const nodeBuiltins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

/**
 * The extension<->Host contract must not move when the monorepo does: a shipped
 * extension bundles whatever these sources import. Each entry is one directory
 * and the bare specifiers its sources may name besides relative files; tests
 * may also use Vitest and Node builtins.
 */
const boundaries: readonly { readonly root: string; readonly allowed: RegExp }[] = [
  { root: "apps/browser-extension/src", allowed: /^(?:zod|@opensteer\/browser-source-wire\/.+)$/u },
  { root: "packages/browser-source-wire/src", allowed: /^(?:zod|tldts|@noble\/curves\/.+)$/u },
];

describe.each(boundaries)("$root", ({ root, allowed }) => {
  it("imports only its allowed packages and relative files", () => {
    const violations = sourcesUnder(root).flatMap((file) =>
      specifiersOf(readFileSync(path.join(repositoryRoot, file), "utf8"))
        .filter(
          (specifier) =>
            !specifier.startsWith(".") &&
            !allowed.test(specifier) &&
            !(file.endsWith(".test.ts") && (specifier === "vitest" || nodeBuiltins.has(specifier))),
        )
        .map((specifier) => `${file}: ${specifier}`),
    );
    expect(violations).toEqual([]);
  });
});

it("sees value, type, re-export, side-effect and dynamic imports", () => {
  expect(
    specifiersOf(
      [
        'import { a } from "one";',
        'import type { B } from "two";',
        "export {\n  c,\n} from 'three';",
        'import "four";',
        'await import("five");',
        ' * import { doc } from "comment";',
      ].join("\n"),
    ),
  ).toEqual(["one", "two", "three", "four", "five"]);
});

function sourcesUnder(directory: string): string[] {
  return readdirSync(path.join(repositoryRoot, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && /\.tsx?$/u.test(entry.name))
    .map((entry) =>
      path
        .relative(repositoryRoot, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );
}

/** Statement-anchored, so JSDoc lines (which start with `*`) are skipped. */
function specifiersOf(source: string): string[] {
  const statement = /^[ \t]*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']/gmu;
  const sideEffect = /^[ \t]*import\s*["']([^"']+)["']/gmu;
  const dynamic = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
  return [statement, sideEffect, dynamic].flatMap((pattern) =>
    [...source.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])),
  );
}
