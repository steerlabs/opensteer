import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * The product is spelled Opensteer. The uppercase-S variant is easy to type and
 * impossible to spot in review, so this guard fails the build with the exact
 * locations instead of relying on attention.
 *
 * Scope is prose and user-visible surfaces. Machine-readable spellings are a
 * different word and are deliberately untouched: `@opensteer/*` package names,
 * the `opensteer` binary, database, and cookie names, `com.opensteer.opensteer`,
 * `app://opensteer`, and identifiers such as `OpensteerError` are all lowercase
 * and never match a case-sensitive search for the mixed-case variant.
 */

// Built by concatenation so this file does not fail its own scan. It is also
// excluded by path below, but keeping the whole word out of the source means a
// future move of this file cannot silently disable the guard.
const wrongSpelling = new RegExp(String.raw`\bOpen` + String.raw`Steer\b`, "u");
const scannedExtensions = new Set([
  ".cjs",
  ".go",
  ".html",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

/** This file states the misspelling in order to search for it. */
const guardPath = "tests/product-name-spelling.test.ts";

const neverScanned = new Set([guardPath, "pnpm-lock.yaml"]);

/**
 * Temporary. Every entry here is a file owned by an in-flight branch that this
 * consolidation pass was not allowed to touch. Empty this list once that work
 * lands and sweep the files in the same change.
 */
const inFlightAllowlist = new Set([
  "apps/desktop/scripts/electron-browser-smoke.ts",
  "apps/desktop/src/app/electron-window.ts",
  "apps/desktop/src/bridge/context.ts",
  "apps/desktop/src/bridge/registration.test.ts",
  "apps/desktop/src/main.ts",
  "apps/desktop/src/preload.ts",
  "packages/client/src/mock/mock-host-client.ts",
  "packages/database/src/integration-store.ts",
  "packages/database/src/migrations.ts",
  "packages/database/src/schema.ts",
  "packages/protocol/src/desktop.ts",
]);

/**
 * The durable `system` principal is seeded with a stored display name. That is a
 * database value, not prose: the migration and every fixture that recreates the
 * row must agree byte for byte, so seed literals keep their original spelling.
 */
function isDatabaseSeedLine(line: string): boolean {
  return (
    (/values\s*\([^)]*'Open/iu.test(line) && /'Open[sS]teer'/u.test(line)) ||
    (/displayName:\s*"Open/iu.test(line) && wrongSpelling.test(line))
  );
}

async function trackedFiles(): Promise<readonly string[]> {
  const { stdout } = await promisify(execFile)("git", ["ls-files", "-z"], {
    cwd: resolve("."),
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean);
}

describe("product name spelling", () => {
  it("spells the product Opensteer in every prose and user-visible surface", async () => {
    const candidates = (await trackedFiles()).filter(
      (file) =>
        scannedExtensions.has(extname(file)) &&
        !neverScanned.has(file) &&
        !inFlightAllowlist.has(file),
    );

    const offenders = (
      await Promise.all(
        candidates.map(async (file) => {
          let contents: string;
          try {
            contents = await readFile(resolve(file), "utf8");
          } catch (error) {
            // A tracked file deleted in the working tree has nothing to scan.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
          if (!wrongSpelling.test(contents)) return [];
          return contents
            .split("\n")
            .flatMap((line, index) =>
              wrongSpelling.test(line) && !isDatabaseSeedLine(line)
                ? [`${file}:${index + 1}: ${line.trim().slice(0, 120)}`]
                : [],
            );
        }),
      )
    ).flat();

    expect(offenders).toStrictEqual([]);
  });

  it("keeps the allowlist honest by refusing entries that no longer need one", async () => {
    const tracked = new Set(await trackedFiles());
    const stale = [...inFlightAllowlist].filter((file) => !tracked.has(file));
    expect(stale).toStrictEqual([]);
  });
});
