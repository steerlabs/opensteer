import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

/**
 * A Home is one person's, and what a connected agent may use is what that person granted: there
 * is no organization above them, no work Home and no work policy. Nothing of them comes back in
 * the product's own source.
 */
const repository = path.resolve(import.meta.dirname, "..");
const roots = [
  "apps/control-plane/src",
  "apps/desktop/src",
  "apps/home-provisioner/src",
  "apps/host/src",
  "apps/mobile/src",
  "apps/runner/src",
  "apps/web/src",
  "deploy",
  "packages/agent-tools/src",
  "packages/client/src",
  "packages/config/src",
  "packages/control-plane-protocol/src",
  "packages/core/src",
  "packages/database/src",
  "packages/protocol/src",
];
const sourceFile = /\.(?:[cm]?[jt]sx?|json|sh|ya?ml|env|sql|css)$/u;
const testFile = /\.test\.|test-support|__snapshots__|\.fixture\.|\/fixtures\//u;
const words =
  /organi[sz]ation|work[-_ ]?home|(?<![Nn]et)work_?policy|work_?audit|work_?assignment/iu;

/** The migrations that drop what organizations and work Homes left, by its old names. */
const droppingMigrations = new Set([
  "apps/control-plane/src/database/one-person-account-migration.ts",
  "packages/database/src/one-person-home-migration.ts",
]);

/** Other products' own words, quoted exactly: none is about an Opensteer organization. */
const otherProducts: readonly { readonly file: string; readonly line: string }[] = [
  // Better Auth's SSO plugin keeps this column in its own table.
  { file: "packages/database/src/baseline-schema.ts", line: `"organization_id" text,` },
  { file: "packages/database/src/schema.ts", line: "organizationId: string | null;" },
  // Claude's and Perplexity's settings are called this in their apps.
  { file: "packages/client/src/host/connected-agents.ts", line: "Organization settings" },
];

it("names no organization, work Home or work policy in the product's source", () => {
  const found: string[] = [];
  for (const root of roots)
    for (const file of sources(path.join(repository, root))) {
      const relative = path.relative(repository, file);
      if (droppingMigrations.has(relative)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((text, index) => {
          if (!words.test(text)) return;
          const quoted = otherProducts.some(
            (other) => other.file === relative && text.includes(other.line),
          );
          if (!quoted) found.push(`${relative}:${index + 1}: ${text.trim().slice(0, 120)}`);
        });
    }
  expect(found).toEqual([]);
});

it("keeps the exemptions true: each still quotes what it says it quotes", () => {
  for (const other of otherProducts)
    expect(readFileSync(path.join(repository, other.file), "utf8")).toContain(other.line);
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
