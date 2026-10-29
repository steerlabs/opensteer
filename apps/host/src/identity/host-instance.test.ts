import { lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { loadOrCreateHostInstance } from "./host-instance.js";

describe("Host instance identity", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
    );
  });

  it("creates one private installation identity and reuses it across restarts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-host-instance-"));
    directories.push(dataDirectory);

    const first = await loadOrCreateHostInstance(dataDirectory);
    const second = await loadOrCreateHostInstance(dataDirectory);

    expect(second.hostInstanceId).toBe(first.hostInstanceId);
    expect(first.hostInstanceId).toMatch(/^hst_/);
    expect(JSON.parse(await readFile(first.path, "utf8"))).toEqual({
      hostInstanceId: first.hostInstanceId,
      schemaVersion: 1,
    });
    expect((await lstat(first.path)).mode & 0o777).toBe(0o600);
  });

  it("refuses to follow a substituted identity symlink", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-host-instance-"));
    const targetDirectory = await mkdtemp(join(tmpdir(), "opensteer-host-instance-target-"));
    directories.push(dataDirectory, targetDirectory);
    await mkdir(dataDirectory, { recursive: true });
    const target = join(targetDirectory, "identity.json");
    await symlink(target, join(dataDirectory, "host-instance.json"));

    await expect(loadOrCreateHostInstance(dataDirectory)).rejects.toThrow(
      /Unable to load Host instance identity/,
    );
  });

  it("pins a managed provisioning identity on first start and every restart", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "opensteer-host-instance-managed-"));
    directories.push(dataDirectory);
    const expected = createId("hostInstance");

    await expect(loadOrCreateHostInstance(dataDirectory, expected)).resolves.toMatchObject({
      hostInstanceId: expected,
    });
    await expect(loadOrCreateHostInstance(dataDirectory, expected)).resolves.toMatchObject({
      hostInstanceId: expected,
    });
    await expect(loadOrCreateHostInstance(dataDirectory, createId("hostInstance"))).rejects.toThrow(
      /Unable to load Host instance identity/u,
    );
  });
});
