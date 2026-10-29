import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RunnerBootIdSchema } from "@opensteer/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerReadinessFile } from "./readiness-file.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("RunnerReadinessFile", () => {
  it("exists only while the authenticated Host connection is current", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-runner-ready-"));
    directories.push(directory);
    const filePath = path.join(directory, "state", "ready.json");
    const readiness = new RunnerReadinessFile(filePath);

    await readiness.initialize();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });

    const bootId = RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111");
    await readiness.connected(bootId);
    await expect(readFile(filePath, "utf8")).resolves.toBe(
      `${JSON.stringify({ bootId, pid: process.pid, state: "connected", version: 1 })}\n`,
    );

    await readiness.disconnected();
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes a rapid connect-disconnect transition without leaving a stale marker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "opensteer-runner-ready-"));
    directories.push(directory);
    const filePath = path.join(directory, "ready.json");
    const readiness = new RunnerReadinessFile(filePath);
    await readiness.initialize();

    const connected = readiness.connected(
      RunnerBootIdSchema.parse("rbt_11111111-1111-4111-8111-111111111111"),
    );
    const disconnected = readiness.disconnected();
    await Promise.all([connected, disconnected]);

    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
