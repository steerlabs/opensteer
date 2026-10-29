import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
const require = createRequire(import.meta.url);
const { helperArchitecturesMatch } = require("./after-sign.cjs") as {
  helperArchitecturesMatch: (helper: string, app: string, release: boolean) => boolean;
};
describe("packaged helper architecture policy", () => {
  it.each([
    ["arm64", "arm64", false, true],
    ["x86_64", "x86_64", false, true],
    ["arm64 x86_64", "arm64", false, true],
    ["x86_64", "arm64", false, false],
    ["", "arm64", false, false],
    ["arm64", "arm64", true, false],
    ["x86_64", "x86_64", true, false],
    ["arm64 x86_64", "arm64", true, true],
    ["x86_64 arm64", "x86_64", true, true],
  ] as const)("checks helper %s for app %s in release=%s", (helper, app, release, valid) => {
    expect(helperArchitecturesMatch(helper, app, release)).toBe(valid);
  });
});
