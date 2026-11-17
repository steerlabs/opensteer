import { expect, it } from "vitest";
import { browserIdentity, greaseBrand, reducedUserAgentMetadata } from "./identity.js";

it("computes the GREASE brand the way Chromium seeds it from the major", () => {
  // 152 is measured from the shipped engine's own userAgentData; the rest
  // pin the algorithm so an engine bump cannot silently change the brand.
  expect(greaseBrand(152)).toEqual({ brand: "Not?A_Brand", version: "24" });
  expect(greaseBrand(151)).toEqual({ brand: "Not=A?Brand", version: "99" });
  expect(greaseBrand(153)).toEqual({ brand: "Not_A Brand", version: "8" });
});

it("keeps the JS metadata and the wire brand list in the same order", () => {
  const identity = browserIdentity(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.7977.169 Electron/45.0.0 Safari/537.36",
    { architecture: "arm", bitness: "64", platformVersion: "26.6.2" },
  );
  expect(identity.userAgent).toContain("Chrome/153.0.0.0");
  expect(identity.clientHints?.brands).toBe('"Chromium";v="153", "Not_A Brand";v="8"');
  expect(identity.userAgentMetadata?.brands).toEqual([
    { brand: "Chromium", version: "153" },
    { brand: "Not_A Brand", version: "8" },
  ]);
  expect(identity.userAgentMetadata?.fullVersionList).toEqual([
    { brand: "Chromium", version: "153.0.7977.169" },
    { brand: "Not_A Brand", version: "8.0.0.0" },
  ]);
});

it("builds metadata from a bare engine version for the Playwright surface", () => {
  expect(
    reducedUserAgentMetadata("151.0.7922.34", "macOS", {
      architecture: "arm",
      bitness: "64",
      platformVersion: "26.0.0",
    }),
  ).toEqual({
    brands: [
      { brand: "Chromium", version: "151" },
      { brand: "Not=A?Brand", version: "99" },
    ],
    fullVersionList: [
      { brand: "Chromium", version: "151.0.7922.34" },
      { brand: "Not=A?Brand", version: "99.0.0.0" },
    ],
    fullVersion: "151.0.7922.34",
    platform: "macOS",
    platformVersion: "26.0.0",
    architecture: "arm",
    model: "",
    mobile: false,
    bitness: "64",
  });
  expect(reducedUserAgentMetadata("unknown", "macOS")).toBeUndefined();
});
