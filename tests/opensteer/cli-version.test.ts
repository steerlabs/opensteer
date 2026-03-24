import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  isOpensteerVersionFlag,
  readOpensteerCliVersion,
} from "../../packages/opensteer/src/cli/version.js";

const OPENSTEER_PACKAGE_JSON = path.resolve(process.cwd(), "packages/opensteer/package.json");

describe("CLI version helpers", () => {
  test("recognizes supported root version flags", () => {
    expect(isOpensteerVersionFlag("--version")).toBe(true);
    expect(isOpensteerVersionFlag("-v")).toBe(true);
    expect(isOpensteerVersionFlag("version")).toBe(false);
    expect(isOpensteerVersionFlag(undefined)).toBe(false);
  });

  test("reads the package version from the local manifest", async () => {
    const manifest = JSON.parse(await readFile(OPENSTEER_PACKAGE_JSON, "utf8")) as {
      readonly version: string;
    };

    await expect(readOpensteerCliVersion()).resolves.toBe(manifest.version);
  });
});
