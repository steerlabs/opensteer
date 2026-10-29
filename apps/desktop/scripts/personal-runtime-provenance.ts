import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readPersonalRuntimeRelease } from "../src/releases/personal-runtime-release.js";

/** Bind reusable runtime bytes to the frozen source before packaging them. */
export async function readProvenPersonalRuntime(
  source: string,
  expected: {
    architecture: "arm64" | "amd64";
    operatingSystem: "darwin";
    runnerSourceRevision?: string | undefined;
    sourceRevision: string;
    version: string;
  },
) {
  const proof = z
    .strictObject({
      schemaVersion: z.literal(1),
      sourceRevision: z.string(),
      runnerSourceRevision: z
        .string()
        .regex(/^[a-f0-9]{40}$/u)
        .optional(),
      version: z.string(),
      releaseManifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .parse(JSON.parse(await readFile(`${source}.provenance.json`, "utf8")));
  const personal = await readPersonalRuntimeRelease(source, expected);
  if (
    proof.sourceRevision !== expected.sourceRevision ||
    proof.version !== expected.version ||
    (proof.runnerSourceRevision ?? proof.sourceRevision) !==
      (expected.runnerSourceRevision ?? expected.sourceRevision) ||
    proof.releaseManifestSha256 !== personal.identity.manifestSha256
  )
    throw new Error("Personal runtime source provenance does not match frozen release");
  if (
    personal.manifest.hostVersion !== expected.version ||
    personal.manifest.runnerVersion !== expected.version
  )
    throw new Error("Personal runtime versions differ from canonical release");
  return personal;
}
