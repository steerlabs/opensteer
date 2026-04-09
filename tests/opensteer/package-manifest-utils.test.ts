import { describe, expect, test } from "vitest";

import {
  collectWorkspaceProtocolSpecifiers,
  rewriteWorkspaceProtocolSpecifiers,
} from "../../scripts/package-manifest-utils.mjs";

describe("package manifest utils", () => {
  test("rewrites workspace protocol specifiers to concrete package versions", () => {
    const manifest = {
      dependencies: {
        "@opensteer/runtime-core": "workspace:*",
        sharp: "^0.34.5",
      },
      peerDependencies: {
        "@opensteer/engine-abp": "workspace:*",
      },
      optionalDependencies: {
        "@opensteer/browser-core": "workspace:^",
      },
    };

    const rewritten = rewriteWorkspaceProtocolSpecifiers(manifest, {
      "@opensteer/runtime-core": "0.1.7",
      "@opensteer/engine-abp": "0.8.7",
      "@opensteer/browser-core": "0.7.7",
    });

    expect(rewritten).toEqual({
      dependencies: {
        "@opensteer/runtime-core": "0.1.7",
        sharp: "^0.34.5",
      },
      peerDependencies: {
        "@opensteer/engine-abp": "0.8.7",
      },
      optionalDependencies: {
        "@opensteer/browser-core": "^0.7.7",
      },
    });
  });

  test("collects workspace protocol specifiers across dependency sections", () => {
    expect(
      collectWorkspaceProtocolSpecifiers({
        dependencies: {
          opensteer: "0.8.17",
        },
        peerDependencies: {
          "@opensteer/engine-abp": "workspace:*",
        },
      }),
    ).toEqual([
      {
        packageName: "@opensteer/engine-abp",
        section: "peerDependencies",
        specifier: "workspace:*",
      },
    ]);
  });
});
