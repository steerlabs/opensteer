import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { withoutBundleScheme } = createRequire(import.meta.url)("./with-single-url-scheme.cjs") as {
  withoutBundleScheme(
    infoPlist: { CFBundleURLTypes: { CFBundleURLSchemes: string[] }[] },
    bundleIdentifier: string,
  ): { CFBundleURLTypes: { CFBundleURLSchemes: string[] }[] };
};

it("keeps the app's own scheme and gives up the one the desktop owns", () => {
  expect(
    withoutBundleScheme(
      {
        CFBundleURLTypes: [
          { CFBundleURLSchemes: ["com.opensteer.mobile", "com.opensteer.opensteer"] },
          { CFBundleURLSchemes: ["com.opensteer.opensteer"] },
        ],
      },
      "com.opensteer.opensteer",
    ).CFBundleURLTypes,
  ).toEqual([{ CFBundleURLSchemes: ["com.opensteer.mobile"] }]);
});
