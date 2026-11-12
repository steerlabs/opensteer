import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "@opensteer/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "@opensteer/core";
import { createHostRuntime, hostAppRealOrigins } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Host runtime configuration", () => {
  it("uses the personal service policy for app origins", () => {
    const shape = { kind: "personal" } as const;
    const policy = core.deploymentPolicy(shape);
    const mocked = vi.spyOn(core, "deploymentPolicy").mockReturnValue({
      ...policy,
      services: { personal: true, team: false },
    } as core.DeploymentPolicy);
    try {
      expect(hostAppRealOrigins(shape)).toBe(true);
    } finally {
      mocked.mockRestore();
    }
  });
  it("rejects an unpinned Account-adopted Host before creating local state", async () => {
    const parent = mkdtempSync(join(tmpdir(), "opensteer-invalid-runtime-"));
    temporaryDirectories.push(parent);
    const dataDirectory = join(parent, "must-not-be-created");

    await expect(
      createHostRuntime({
        account: {},
        dataDirectory,
      } as unknown as HostConfig),
    ).rejects.toThrow(/requires a pinned deployment and Host instance identity/u);
    expect(existsSync(dataDirectory)).toBe(false);
  });
});
