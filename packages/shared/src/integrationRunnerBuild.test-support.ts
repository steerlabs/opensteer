import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

export type IntegrationBundleKind = "recovery" | "desktop";
const rebuild = "pnpm test:integration apps/host/src/agents/runner-readiness.integration.test.ts";
const fingerprints = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/u));
export const integrationManifestSchema = z.object({
  version: z.literal(1),
  root: z.string(),
  kind: z.enum(["recovery", "desktop"]),
  entry: z.string(),
  inputs: fingerprints,
  outputs: fingerprints,
});

export function integrationBundleSpec(root: string, kind: IntegrationBundleKind) {
  const app = join(root, "apps", kind === "recovery" ? "runner" : "desktop");
  const output = join(app, kind === "recovery" ? "dist-integration" : "dist");
  return {
    app,
    output,
    entry: join(
      output,
      kind === "recovery" ? "recovery-runner.test-support.js" : "runner-worker.js",
    ),
    sources:
      kind === "recovery"
        ? ["src/test-fixtures/recovery-runner.test-support.ts"]
        : ["src/main.ts", "src/runner-worker.ts"],
    configs:
      kind === "recovery" ? ["tsup.config.ts", "tsup.integration.config.ts"] : ["tsup.config.ts"],
    manifest: join(output, "integration-build.json"),
  };
}

export function integrationBuildRefused(
  kind: IntegrationBundleKind,
  reason: string,
  cause?: unknown,
): Error {
  return new Error(`Integration ${kind} bundle ${reason}. Rebuild with: ${rebuild}`, { cause });
}

export async function snapshotIntegrationInputs(
  paths: readonly string[],
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of [...new Set(paths)].sort())
    result[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  return result;
}

/** Each actual fork validates its entry, transitive sources and shared chunks. */
export async function integrationBundleEntry(
  root: string,
  kind: IntegrationBundleKind,
): Promise<string> {
  return integrationBundleEntrySync(root, kind);
}

/** The Electron fork port is synchronous; it needs the same guard at each fork. */
export function integrationBundleEntrySync(root: string, kind: IntegrationBundleKind): string {
  root = resolve(root);
  const spec = integrationBundleSpec(root, kind);
  try {
    const manifest = integrationManifestSchema.parse(
      JSON.parse(readFileSync(spec.manifest, "utf8")),
    );
    if (
      manifest.root !== root ||
      manifest.kind !== kind ||
      manifest.entry !== spec.entry ||
      !manifest.outputs[spec.entry] ||
      !Object.keys(manifest.inputs).length
    )
      throw new Error("Build identity does not match this entry");
    for (const expected of [manifest.inputs, manifest.outputs])
      for (const [path, hash] of Object.entries(expected))
        if (createHash("sha256").update(readFileSync(path)).digest("hex") !== hash)
          throw new Error("Build fingerprint differs");
    return manifest.entry;
  } catch (cause) {
    throw integrationBuildRefused(kind, "is missing, malformed or stale", cause);
  }
}
