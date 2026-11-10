import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, test } from "vitest";

test("every shipped phone-browser entry bundles for a browser without any Node built-in or test fake", async () => {
  const result = await build({
    entryPoints: [
      "manager.ts",
      "native-port.ts",
      "descriptor.ts",
      "presentation.ts",
      "cdp.ts",
      "state.ts",
    ].map((name) => fileURLToPath(new URL(name, import.meta.url))),
    bundle: true,
    platform: "browser",
    format: "esm",
    outdir: "/not-written",
    write: false,
    metafile: true,
    treeShaking: false,
    logLevel: "silent",
    plugins: [
      {
        name: "no-node",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (args.path.startsWith("node:") || builtinModules.includes(args.path))
              throw new Error(`Node built-in ${args.path} reached by ${args.importer}`);
            return undefined;
          });
        },
      },
    ],
  });
  expect(
    Object.keys(result.metafile.inputs).some((file) =>
      file.endsWith("portable-session-cdp-router.ts"),
    ),
  ).toBe(true);
  expect(
    Object.keys(result.metafile.inputs).filter((file) => /test-support|\.test\./u.test(file)),
  ).toEqual([]);
});
