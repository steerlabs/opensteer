import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  shippedHarnessCatalogEntry,
  shippedHarnessKinds,
} from "../packages/core/src/harness-catalog.js";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

/**
 * A `package.json` cannot import the harness catalog, so each engine's npm
 * package is pinned once in the pnpm catalog and every workspace package
 * references it as `catalog:`. The Runner's `verify-harness-runtimes` test
 * checks installed artifact metadata; `pnpm engines verify` and engine
 * qualification execute every shipped CLI and assert its exact `--version`.
 */
const vendorPackages = shippedHarnessKinds.map((kind) => {
  const { runtime } = shippedHarnessCatalogEntry(kind);
  if (runtime.shape === "installed") throw new Error(`${kind} ships no runtime`);
  return runtime.npmPackage;
});

const workspace = parse(readFileSync(path.join(repositoryRoot, "pnpm-workspace.yaml"), "utf8")) as {
  readonly catalog: Readonly<Record<string, string>>;
};

const packageManifests = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    "apps/*/package.json",
    "packages/*/package.json",
  ],
  { cwd: repositoryRoot, encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

describe("harness vendor pins", () => {
  it("pins every shipped engine's package once, in the pnpm catalog", () => {
    for (const name of vendorPackages) {
      expect(workspace.catalog[name], name).toMatch(/^\d+\.\d+\.\d+$/u);
    }
  });

  it("references every vendor package through the pnpm catalog", () => {
    const vendorNames = new Set(vendorPackages);
    for (const manifestPath of packageManifests) {
      const manifest = JSON.parse(
        readFileSync(path.join(repositoryRoot, manifestPath), "utf8"),
      ) as {
        readonly dependencies?: Readonly<Record<string, string>>;
        readonly devDependencies?: Readonly<Record<string, string>>;
        readonly optionalDependencies?: Readonly<Record<string, string>>;
      };
      for (const dependencies of [
        manifest.dependencies,
        manifest.devDependencies,
        manifest.optionalDependencies,
      ]) {
        for (const [name, specifier] of Object.entries(dependencies ?? {})) {
          if (!vendorNames.has(name)) continue;
          expect(specifier, `${manifestPath} → ${name}`).toBe("catalog:");
        }
      }
    }
  });
});
