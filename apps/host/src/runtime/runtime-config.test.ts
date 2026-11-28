import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostConfig } from "@opensteer/config";
import { afterEach, describe, expect, it } from "vitest";
import { createHostRuntime, hostAppRealOrigins } from "./runtime.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Host runtime configuration", () => {
  it("gives apps their own origins only where a loopback Personal Host has app addresses", () => {
    expect(hostAppRealOrigins("loopback")).toBe(true);
    expect(hostAppRealOrigins("networked")).toBe(false);
  });
  it("rejects an invalid configuration before creating local state", async () => {
    const parent = mkdtempSync(join(tmpdir(), "opensteer-invalid-runtime-"));
    temporaryDirectories.push(parent);
    const dataDirectory = join(parent, "must-not-be-created");

    await expect(
      createHostRuntime({
        canonicalOrigin: new URL("http://127.0.0.1:4310"),
        dataDirectory,
        exposure: "networked",
      } as unknown as HostConfig),
    ).rejects.toThrow(/A networked Personal Host requires its public canonical origin/u);
    expect(existsSync(dataDirectory)).toBe(false);
  });
});
