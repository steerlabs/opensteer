import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { personalRuntimeSigningIdentity, personalRuntimeSigningOptions } =
  require("./signing-input.cjs") as {
    personalRuntimeSigningOptions: (identity: string) => string[];
    personalRuntimeSigningIdentity: (environment: NodeJS.ProcessEnv) => string;
  };

describe("Personal runtime package signing", () => {
  it("uses ad-hoc signing without private inputs", () => {
    expect(personalRuntimeSigningIdentity({})).toBe("-");
  });
  it("requires signing authority for releases", () => {
    expect(() => personalRuntimeSigningIdentity({ OPENSTEER_DESKTOP_RELEASE: "1" })).toThrow(
      /valid signing input/,
    );
  });
});

describe("Personal runtime hardening", () => {
  it("allows ad-hoc development executables to load bundled ad-hoc libraries", () => {
    expect(personalRuntimeSigningOptions("-")).toEqual(["--timestamp=none"]);
  });
  it("retains timestamps and hardened runtime for release identities", () => {
    expect(personalRuntimeSigningOptions("Developer ID Application: Example (ABCDE12345)")).toEqual(
      ["--timestamp", "--options", "runtime"],
    );
  });
});
