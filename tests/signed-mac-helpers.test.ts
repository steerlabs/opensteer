import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { signedMacHelpers, selectDictationSDK } from "../scripts/signed-mac-helpers.js";

describe("signed Mac helper builds", () => {
  it("uses the same helper list in local and CI builders", async () => {
    expect(signedMacHelpers.map((helper) => helper.script)).toEqual([
      "build-passwords-broker.ts",
      "build-dictation-helper.ts",
    ]);
    const pkg = JSON.parse(await readFile("apps/desktop/package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const helper of signedMacHelpers)
      expect(pkg.scripts[helper.command]).toContain(helper.script);
    for (const file of ["scripts/release-beta-mac.ts", "scripts/build-desktop-macos.ts"]) {
      const source = await readFile(file, "utf8");
      expect(source).toContain("signedMacHelpers");
      expect(source).toMatch(/for \(const helper of signedMacHelpers\)/);
      expect(
        source.indexOf("package:mac", source.indexOf("for (const helper of signedMacHelpers)")),
      ).toBeGreaterThan(0);
    }
  });

  it("uses the selected SDK when it is new enough", async () => {
    const run = vi.fn().mockResolvedValue("26.3\n");
    expect(await selectDictationSDK(run, { DEVELOPER_DIR: "/custom/Xcode" })).toEqual({
      DEVELOPER_DIR: "/custom/Xcode",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("selects CI's Xcode when the current SDK is too old", async () => {
    const run = vi.fn().mockResolvedValueOnce("15.5").mockResolvedValueOnce("26.3");
    expect(await selectDictationSDK(run, {})).toEqual({
      DEVELOPER_DIR: "/Applications/Xcode_26.3.app/Contents/Developer",
    });
  });

  it("fails clearly if no macOS 26 SDK is available", async () => {
    const run = vi.fn().mockResolvedValueOnce("15.5").mockRejectedValueOnce(new Error("missing"));
    await expect(selectDictationSDK(run, {})).rejects.toThrow(/macOS 26 SDK.*Xcode 26/);
  });
});
