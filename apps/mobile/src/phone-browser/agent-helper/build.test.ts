import { build } from "esbuild";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("bundles one document-start script without imports or a code-execution entry point", async () => {
  const built = await build({
    entryPoints: [fileURLToPath(new URL("./entry.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "safari17",
    write: false,
    legalComments: "none",
  });
  expect(built.outputFiles).toHaveLength(1);
  const context: Record<string, unknown> = {
    crypto: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
    TextEncoder,
    TextDecoder,
    URL,
    AbortController,
    addEventListener: () => {},
  };
  runInNewContext(built.outputFiles![0]!.text, context, {
    timeout: 1_000,
    contextCodeGeneration: { strings: false, wasm: false },
  });
  const descriptor = Object.getOwnPropertyDescriptor(context, "__opensteerAgentHelper")!;
  expect(descriptor.configurable).toBe(false);
  expect(descriptor.writable).toBe(false);
  const helper = descriptor.value as {
    version: number;
    documentId: string;
    invoke(input: unknown): Promise<unknown>;
  };
  expect(helper.version).toBe(1);
  expect(helper.documentId).toMatch(/^[a-f0-9]{32}$/u);
  await expect(
    helper.invoke({
      documentId: helper.documentId,
      name: "evaluate",
      args: "navigator.clipboard.readText()",
    }),
  ).resolves.toMatchObject({ error: { code: "unsupported-operation" } });
});
