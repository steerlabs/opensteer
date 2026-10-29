import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "@opensteer/config";
import { afterEach, describe, expect, it } from "vitest";
import { createHostRuntime } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Host runtime configuration", () => {
  it("rejects an unpinned managed Account Host before creating local state", async () => {
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
