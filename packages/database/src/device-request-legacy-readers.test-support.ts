import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { build } from "esbuild";
import type { z } from "zod";

let readers:
  | Promise<{
      DeploymentSnapshotSchema: z.ZodType;
      NeedsYouPageSchema: z.ZodType;
      PendingRequestViewSchema: z.ZodType;
    }>
  | undefined;

export function devicesLegacyReaders() {
  return (readers ??= (async () => {
    const root = resolve(import.meta.dirname, "../../..");
    const result = await build({
      stdin: {
        contents: `export { DeploymentSnapshotSchema } from "./packages/protocol/src/client.ts";
          export { NeedsYouPageSchema } from "./packages/protocol/src/needs-you.ts";
          export { PendingRequestViewSchema } from "./packages/core/src/requests.ts";`,
        resolveDir: root,
      },
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      plugins: [
        {
          name: "pre-devices-readers",
          setup(builder) {
            builder.onLoad(
              {
                filter:
                  /\/packages\/(?:core\/src\/requests|protocol\/src\/(?:client|needs-you))\.ts$/,
              },
              ({ path }) => ({
                contents: readFileSync(
                  resolve(
                    import.meta.dirname,
                    "fixtures/devices-ef2d57efc",
                    `${basename(path)}.txt`,
                  ),
                  "utf8",
                ),
                loader: "ts",
              }),
            );
          },
        },
      ],
    });
    // Keep released Request kinds, payloads and mandatory page readers independent of current readers.
    return import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString("base64")}`
    );
  })());
}
