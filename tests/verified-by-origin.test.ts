import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * A connected agent is verified by one thing: the origin of the redirect address the person
 * consents to, listed in the signed agent directory. Nothing is verified "through a platform", by a
 * statement an embedding product signs, and that does not come back in the product's own source.
 */
const repository = path.resolve(import.meta.dirname, "..");
const roots = [
  "apps/control-plane/src",
  "apps/host/src",
  "apps/mobile/src",
  "apps/web/src",
  "deploy",
  "packages/client/src",
  "packages/control-plane-protocol/src",
  "packages/database/src",
  "packages/protocol/src",
];
const sourceFile = /\.(?:[cm]?[jt]sx?|json|sh|ya?ml|env|sql|css)$/u;
const testFile = /\.test\.|test-support|__snapshots__|\.fixture\.|\/fixtures\//u;
const words =
  /embedder|embeds_?via|platform-and-embedder|verified (?:via|through) a platform|who\.pair/iu;

/** The migrations that drop what it left, by its old names. */
const droppingMigrations = new Set([
  "apps/control-plane/src/agent-directory/platform-verification-removal-migration.ts",
  "packages/database/src/platform-verification-removal-migration.ts",
]);

it("verifies a connected agent by its origin alone, with no embedder or platform pairing", () => {
  const found: string[] = [];
  for (const root of roots)
    for (const file of sources(path.join(repository, root))) {
      const relative = path.relative(repository, file);
      if (droppingMigrations.has(relative)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, index) => {
          if (words.test(text))
            found.push(`${relative}:${index + 1}: ${text.trim().slice(0, 120)}`);
        });
    }
  expect(found).toEqual([]);
  for (const migration of droppingMigrations)
    expect(readFileSync(path.join(repository, migration), "utf8")).toMatch(words);
});

function* sources(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "build") continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (sourceFile.test(entry.name) && !testFile.test(full)) yield full;
  }
}
