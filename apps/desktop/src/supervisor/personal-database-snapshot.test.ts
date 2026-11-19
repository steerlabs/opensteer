import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { PersonalRuntimeIdentity } from "../secrets/personal-deployment-store.js";
import {
  markPersonalStateConverted,
  pinnedSnapshotSourceVersion,
  snapshotDatabase,
} from "./personal-database-snapshot.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

function release(hostVersion: string): PersonalRuntimeIdentity {
  return {
    architecture: "arm64",
    hostVersion,
    manifestSha256: "a".repeat(64),
    operatingSystem: "darwin",
    postgresMajor: 17,
    postgresVersion: "17.5",
    runnerVersion: hostVersion,
  };
}

it("keeps the pinned pre-conversion copy past normal retention until the first healthy start", async () => {
  const deploymentRoot = await mkdtemp(path.join(tmpdir(), "opensteer-snapshot-"));
  roots.push(deploymentRoot);
  const dataDirectory = path.join(deploymentRoot, "postgres");
  await mkdir(dataDirectory);
  await writeFile(path.join(dataDirectory, "PG_VERSION"), "17\n");
  const take = (minute: number, from: string, pinned = false) =>
    snapshotDatabase({
      createdAt: new Date(Date.UTC(2026, 10, 18, 12, minute)),
      dataDirectory,
      deploymentRoot,
      fromRelease: release(from),
      pinned,
      toRelease: release(`${from}-next`),
    });
  const pinned = await take(0, "0.1.700", true);
  for (let minute = 1; minute <= 4; minute++) await take(minute, `0.1.70${minute}`);
  const listed = () => readdir(path.join(deploymentRoot, "snapshots"));
  expect(await listed()).toContain(pinned);
  expect(await pinnedSnapshotSourceVersion(deploymentRoot)).toBe("0.1.700");

  await markPersonalStateConverted(deploymentRoot);
  await take(5, "0.1.705");
  expect(await listed()).not.toContain(pinned);
  expect(await listed()).toHaveLength(3);
});
