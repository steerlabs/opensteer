import path from "node:path";

export const opensteerVitestAliases = [
  {
    find: "@opensteer/browser-core",
    replacement: path.resolve(__dirname, "packages/browser-core/src/index.ts"),
  },
  {
    find: "@opensteer/conformance",
    replacement: path.resolve(__dirname, "packages/conformance/src/index.ts"),
  },
  {
    find: "@opensteer/engine-abp",
    replacement: path.resolve(__dirname, "packages/engine-abp/src/index.ts"),
  },
  {
    find: "@opensteer/engine-playwright",
    replacement: path.resolve(__dirname, "packages/engine-playwright/src/index.ts"),
  },
  {
    find: "@opensteer/protocol",
    replacement: path.resolve(__dirname, "packages/protocol/src/index.ts"),
  },
  {
    find: "@opensteer/runtime-core",
    replacement: path.resolve(__dirname, "packages/runtime-core/src/index.ts"),
  },
] as const;

export const opensteerVitestInclude = ["tests/**/*.test.ts"] as const;
