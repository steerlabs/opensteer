import { resolve } from "node:path";
import { expect, it } from "vitest";
import { cloneTestDatabase } from "../packages/database/src/test-database.test-support.js";
import { runMigrationPhase } from "./migration-compat.test-support.js";

const previous = process.env.OPENSTEER_MIGRATION_BASELINE_ROOT!;
const current = resolve(import.meta.dirname, "..");

async function checkUpgrade(signal: AbortSignal) {
  const authority = "controlPlane";
  const clone = await cloneTestDatabase(authority);
  try {
    await runMigrationPhase(previous, "seed", authority, clone.url, {
      signal,
    }).catch((error: unknown) => {
      throw new Error("Previous-release fixture seed failed before migration", {
        cause: error,
      });
    });
    const start = performance.now();
    await runMigrationPhase(current, "migrate", authority, clone.url, { signal });
    expect(performance.now() - start).toBeLessThan(30_000);
    const replay = await runMigrationPhase(previous, "replay", authority, clone.url, {
      signal,
    });
    expect(replay).toContain("PREVIOUS_STORE_READ_WRITE_OK");
  } finally {
    await clone.drop();
  }
}

it(
  "upgrades the released Account schema and preserves its store",
  { timeout: 60_000 },
  async ({ signal }) => {
    await checkUpgrade(signal);
  },
);
