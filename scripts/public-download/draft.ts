import assert from "node:assert/strict";
import { readdir, readFile, lstat, mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { sha256File } from "@opensteer/shared/fileDigest";
import {
  assetsFor,
  manifestSchema,
  releaseSchema,
  releaseManifest,
  verifyAssets,
  publicGuard,
} from "../desktop-public-release.js";
import { runBounded } from "../command-runner.js";
import { certificationCases, releaseAsset, numericVersion } from "./evidence.js";
export const draftExpectation = z.object({
  tag: z.string().regex(/^(?:desktop-v\d+\.\d+\.\d+|v\d+\.\d+\.\d+-insider)$/u),
  version: numericVersion,
  sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
});
export const draftReceipt = manifestSchema.safeExtend({ downloadedAt: z.string().datetime() });
export async function validateDraft(directory: string, api: unknown, expectation: unknown) {
  const expected = draftExpectation.parse(expectation);
  const release = releaseSchema.extend({ draft: z.literal(true) }).parse(api);
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(path.join(directory, "release.json"), "utf8")),
  );
  releaseManifest(release, manifest);
  publicGuard("steerlabs/opensteer", manifest);
  assert.equal(manifest.privateFeed, false, "Draft must use the public provider");
  assert.equal(manifest.tag, expected.tag);
  assert.equal(manifest.version, expected.version);
  assert.equal(manifest.sourceSha, expected.sourceSha);
  const names = [...assetsFor(manifest.channel), "release.json"].sort();
  assert.deepEqual(
    (await readdir(directory)).sort(),
    names,
    "Unexpected/missing downloaded assets",
  );
  for (const name of names)
    assert((await lstat(path.join(directory, name))).isFile(), "Assets must be regular files");
  await verifyAssets(directory, manifest);
  const rows = (await readFile(path.join(directory, "SHA256SUMS"), "utf8")).trimEnd().split("\n");
  const sums: Record<string, string> = {};
  for (const row of rows) {
    const match = /^([a-f0-9]{64})  ([^/]+)$/u.exec(row);
    assert(match, "Malformed SHA256SUMS");
    assert(!(match[2]! in sums), "Duplicate checksum");
    sums[match[2]!] = match[1]!;
  }
  const expectedSums = Object.fromEntries(
    Object.entries(manifest.assets).filter(([name]) => name !== "SHA256SUMS"),
  );
  assert.deepEqual(sums, expectedSums, "SHA256SUMS disagrees with release.json");
  return manifest;
}
export async function intakeDraft(work: string, expectation: unknown, run = runBounded) {
  const expected = draftExpectation.parse(expectation);
  const query = async () => {
    const releases = z
      .array(z.array(releaseSchema))
      .parse(
        JSON.parse(
          await run(
            "gh",
            ["api", "--paginate", "--slurp", "repos/steerlabs/opensteer/releases?per_page=100"],
            { timeoutMs: 60_000 },
          ),
        ),
      )
      .flat()
      .filter((r) => r.tag_name === expected.tag);
    assert.equal(releases.length, 1, "Expected exactly one accessible release for this tag");
    return releases[0];
  };
  const api = releaseSchema.extend({ draft: z.literal(true) }).parse(await query());
  assert.equal(api.tag_name, expected.tag);
  await mkdir(path.join(work, "builds"), { recursive: true });
  const inputs = await mkdtemp(path.join(work, "builds/draft-inputs-"));
  const directory = path.join(inputs, expected.tag);
  await mkdir(directory);
  await run(
    "gh",
    ["release", "download", expected.tag, "--repo", "steerlabs/opensteer", "--dir", directory],
    { timeoutMs: 610_000 },
  );
  const manifest = await validateDraft(directory, api, expected);
  const after = releaseSchema.extend({ draft: z.literal(true) }).parse(await query());
  assert.equal(after.id, api.id);
  releaseManifest(after, manifest);
  const downloadedZipSha256 = await sha256File(
    path.join(directory, releaseAsset(manifest.channel, manifest.version).zip),
  );
  assert.equal(
    downloadedZipSha256,
    manifest.assets[releaseAsset(manifest.channel, manifest.version).zip],
    "Downloaded ZIP changed after validation",
  );
  return {
    inputs,
    downloadedZipSha256,
    draft: draftReceipt.parse({ ...manifest, downloadedAt: new Date().toISOString() }),
  };
}
export const caseReceipt = z.object({
  name: z.string(),
  passed: z.boolean(),
  installedSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export function draftCertificationPassed(
  draft: { channel: "stable" | "beta"; assets: Record<string, string> },
  input: unknown,
) {
  const parsed = z.array(caseReceipt).safeParse(input);
  if (!parsed.success) return false;
  const results = parsed.data,
    required = certificationCases[draft.channel];
  const expected = draft.assets[releaseAsset(draft.channel, "0.0.0").zip];
  return (
    !!expected &&
    results.length === required.length &&
    new Set(results.map((r) => r.name)).size === required.length &&
    required.every((name) =>
      results.some((r) => r.name === name && r.passed && r.installedSha256 === expected),
    )
  );
}

export function publicationLines(
  draft: { tag: string; channel: "beta" | "stable"; assets: Record<string, string> },
  downloadedZipSha256: string,
  passed: boolean,
): string[] {
  if (!passed) return [];
  z.string()
    .regex(/^[a-f0-9]{64}$/u)
    .parse(downloadedZipSha256);
  assert.equal(
    downloadedZipSha256,
    draft.assets[releaseAsset(draft.channel, "0.0.0").zip],
    "Downloaded ZIP differs from draft manifest",
  );
  const channel = draft.channel === "beta" ? "insider" : "stable";
  return [
    `certified_zip_sha256=${downloadedZipSha256}`,
    `gh workflow run release.yml --repo steerlabs/opensteer --ref main -f channel=${channel}${channel === "insider" ? ` -f insider_tag=${draftExpectation.shape.tag.parse(draft.tag)}` : ""} -f publish=true -f certified_zip_sha256=${downloadedZipSha256}`,
  ];
}
