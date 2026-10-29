import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { cloneTestDatabase } from "../packages/database/src/test-database.test-support.js";
import { runMigrationPhase } from "./migration-compat.test-support.js";

const previous = process.env.OPENSTEER_MIGRATION_BASELINE_ROOT!;
const current = resolve(import.meta.dirname, "..");

async function checkUpgrade(
  authority: "host" | "controlPlane",
  signal: AbortSignal,
  control?: "break-column" | "timeout",
) {
  const clone = await cloneTestDatabase(authority);
  const directory = await mkdtemp(join(tmpdir(), "opensteer-migration-fixture-"));
  const receipt = join(directory, "fixture.json");
  try {
    await runMigrationPhase(previous, "seed", authority, clone.url, { receipt, signal }).catch(
      (error: unknown) => {
        throw new Error("Previous-release fixture seed failed before migration", { cause: error });
      },
    );
    const start = performance.now();
    try {
      await runMigrationPhase(current, "migrate", authority, clone.url, {
        receipt,
        ...(control ? { control } : {}),
        signal,
      });
    } catch (error) {
      if (control) expect(await readFile(`${receipt}.control`, "utf8")).toBe(control);
      throw error;
    }
    if (control) expect(await readFile(`${receipt}.control`, "utf8")).toBe(control);
    expect(performance.now() - start).toBeLessThan(30_000);
    const replay = await runMigrationPhase(previous, "replay", authority, clone.url, {
      receipt,
      signal,
    });
    expect(replay).toContain("PREVIOUS_STORE_READ_WRITE_OK");
  } finally {
    try {
      await clone.drop();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

it.for(["host", "controlPlane"] as const)(
  "upgrades the released %s schema and preserves its store",
  { timeout: 60_000 },
  async (authority, { signal }) => {
    await checkUpgrade(authority, signal);
  },
);

it.runIf(process.env.OPENSTEER_MIGRATION_COMPAT_CONTROLS === "1")(
  "rejects a migration that renames a previous-store column",
  { timeout: 60_000 },
  async ({ signal }) => {
    await expect(checkUpgrade("host", signal, "break-column")).rejects.toThrow(
      /display_name|displayName/,
    );
  },
);

it.runIf(process.env.OPENSTEER_MIGRATION_COMPAT_CONTROLS === "1")(
  "rejects a migration beyond the 30-second budget and drains it",
  { timeout: 60_000 },
  async ({ signal }) => {
    await expect(checkUpgrade("host", signal, "timeout")).rejects.toThrow(
      /deadline|statement timeout/,
    );
  },
);
