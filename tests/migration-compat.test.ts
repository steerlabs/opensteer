import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob } from "node:path";
import { migrationBaseline, migrationTimeoutMs } from "../scripts/test-migration-compat.js";
import integration from "../vitest.integration.config.js";
import migration from "../vitest.migration-compat.config.js";
import { runMigrationPhase } from "./migration-compat.test-support.js";
import { runBounded } from "../scripts/command-runner.js";

it("preserves phase cancellation through loader resolution", async () => {
  const reason = new Error("MIGRATION_PHASE_CANCELLED");
  await expect(
    runMigrationPhase("/unused", "migrate", "host", "postgres://unused/fixture", {
      signal: AbortSignal.abort(reason),
    }),
  ).rejects.toBe(reason);
});

it("collects the migration journey only in its SQL-change tier", () => {
  const [journey] = migration.test!.include!;
  expect(integration.test!.include!.some((pattern) => matchesGlob(journey!, pattern))).toBe(false);
});

it("requires a released baseline instead of silently testing current HEAD", async () => {
  await expect(migrationBaseline(undefined, async () => undefined)).rejects.toThrow(
    "No previous release",
  );
});

it("pins the migration budget", () => {
  expect(migrationTimeoutMs).toBe(30_000);
});

it("rejects a non-commit baseline before provisioning a database", async () => {
  await expect(migrationBaseline("HEAD")).rejects.toThrow();
});

describe("released baseline provenance", () => {
  let directory: string;
  let released: string;
  let candidate: string;
  let unrelated: string;
  const run: typeof runBounded = (command, args, options) =>
    runBounded(command, args, { ...options, cwd: directory });
  const git = (args: readonly string[]) => run("git", args);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "opensteer-migration-baseline-"));
    await git(["init", "-q"]);
    await git(["config", "user.name", "Migration fixture"]);
    await git(["config", "user.email", "migration@example.invalid"]);
    await git(["config", "commit.gpgsign", "false"]);
    await git(["config", "tag.gpgsign", "false"]);
    await git(["config", "core.hooksPath", "/dev/null"]);
    await git(["commit", "--allow-empty", "-qm", "released"]);
    released = (await git(["rev-parse", "HEAD"])).trim();
    await git(["tag", "v1.0.0"]);
    await git(["commit", "--allow-empty", "-qm", "never deployed"]);
    await git(["tag", "v99.0.0"]);
    await git(["commit", "--allow-empty", "-qm", "candidate"]);
    candidate = (await git(["rev-parse", "HEAD"])).trim();
    const tree = (await git(["write-tree"])).trim();
    unrelated = (await git(["commit-tree", tree, "-m", "unrelated release"])).trim();
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("fails closed on unreadable release state even when the candidate is version-tagged", async () => {
    await git(["tag", "v100.0.0"]);
    try {
      await expect(migrationBaseline(undefined, async () => undefined, run)).rejects.toThrow(
        "--baseline",
      );
    } finally {
      await git(["tag", "-d", "v100.0.0"]);
    }
  });

  it("never uses a reachable tag on a never-deployed revision", async () => {
    await expect(migrationBaseline(undefined, async () => undefined, run)).rejects.toThrow(
      "--baseline",
    );
  });

  it("refuses an explicit baseline resolving to HEAD", async () => {
    await expect(migrationBaseline(candidate, undefined, run)).rejects.toThrow(
      "must not equal HEAD",
    );
  });

  it("refuses an explicit baseline outside HEAD's ancestry", async () => {
    await expect(migrationBaseline(unrelated, undefined, run)).rejects.toThrow("ancestor of HEAD");
  });

  it("accepts the verified deployed revision or an explicit prior ancestor", async () => {
    expect(await migrationBaseline(undefined, async () => released, run)).toBe(released);
    expect(await migrationBaseline(released, undefined, run)).toBe(released);
  });
});
