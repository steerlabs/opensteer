import { test, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assetsFor } from "../scripts/desktop-public-release.js";
import {
  validateDraft,
  draftCertificationPassed,
  publicationLines,
} from "../scripts/public-download/draft.js";

test("draft intake binds exact public manifest, API draft, expectations and both checksum records", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opensteer-draft-"));
  const hash = (b: string) => createHash("sha256").update(b).digest("hex");
  const assets: Record<string, string> = {};
  for (const name of assetsFor("beta").filter((n) => n !== "SHA256SUMS")) {
    writeFileSync(path.join(dir, name), name);
    assets[name] = hash(name);
  }
  const sums = Object.entries(assets)
    .map(([name, h]) => `${h}  ${name}\n`)
    .join("");
  writeFileSync(path.join(dir, "SHA256SUMS"), sums);
  assets.SHA256SUMS = hash(sums);
  const manifest = {
    channel: "beta",
    prerelease: true,
    tag: "v1.2.3-insider",
    title: "Opensteer Beta 1.2.3",
    notes: "notes",
    version: "1.2.3",
    sourceSha: "a".repeat(40),
    assets,
    feedURL: "https://github.com/steerlabs/opensteer#insider",
    privateFeed: false,
  };
  const release = {
    id: 1,
    draft: true,
    prerelease: true,
    tag_name: manifest.tag,
    target_commitish: manifest.sourceSha,
    name: manifest.title,
    body: manifest.notes,
    assets: [...Object.keys(assets), "release.json"].map((name) => ({ name })),
  };
  const expected = { tag: manifest.tag, version: manifest.version, sourceSha: manifest.sourceSha };
  const write = () => writeFileSync(path.join(dir, "release.json"), JSON.stringify(manifest));
  write();
  try {
    expect((await validateDraft(dir, release, expected)).version).toBe("1.2.3");
    await expect(validateDraft(dir, { ...release, draft: false }, expected)).rejects.toThrow();
    for (const change of [
      { version: "1.2.4" },
      { sourceSha: "b".repeat(40) },
      { tag: "desktop-v1.2.3" },
    ])
      await expect(validateDraft(dir, release, { ...expected, ...change })).rejects.toThrow();
    await expect(
      validateDraft(dir, { ...release, assets: [...release.assets, { name: "extra" }] }, expected),
    ).rejects.toThrow();
    const originalFeed = manifest.feedURL;
    manifest.privateFeed = true;
    manifest.feedURL = "https://example.com/feed";
    write();
    await expect(validateDraft(dir, release, expected)).rejects.toThrow();
    manifest.privateFeed = false;
    manifest.feedURL = originalFeed;
    write();
    writeFileSync(path.join(dir, "extra"), "unexpected");
    await expect(validateDraft(dir, release, expected)).rejects.toThrow();
    rmSync(path.join(dir, "extra"));
    writeFileSync(path.join(dir, "SHA256SUMS"), "");
    assets.SHA256SUMS = hash("");
    write();
    await expect(validateDraft(dir, release, expected)).rejects.toThrow();
    writeFileSync(path.join(dir, "SHA256SUMS"), sums);
    assets.SHA256SUMS = hash(sums);
    write();
    writeFileSync(path.join(dir, "Opensteer-Beta-mac-arm64.zip"), "tamper");
    await expect(validateDraft(dir, release, expected)).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("certification requires every channel case to install the exact draft zip", () => {
  const draft = {
    channel: "beta" as const,
    assets: { "Opensteer-Beta-mac-arm64.zip": "a".repeat(64) },
  };
  const results = ["beta:menu", "beta:quit"].map((name) => ({
    name,
    passed: true,
    installedSha256: "a".repeat(64),
  }));
  expect(draftCertificationPassed(draft, results)).toBe(true);
  expect(draftCertificationPassed(draft, results.slice(0, 1))).toBe(false);
  for (const change of [
    { passed: false },
    { installedSha256: "b".repeat(64) },
    { installedSha256: undefined },
  ])
    expect(draftCertificationPassed(draft, [results[0]!, { ...results[1]!, ...change }])).toBe(
      false,
    );
  expect(draftCertificationPassed(draft, [...results, results[0]!])).toBe(false);
});

test("stable draft certification requires menu, tray and quit with no Beta substitution", () => {
  const draft = {
    channel: "stable" as const,
    assets: { "Opensteer-mac-arm64.zip": "a".repeat(64) },
  };
  const rows = ["stable:menu", "stable:tray", "stable:quit"].map((name) => ({
    name,
    passed: true,
    installedSha256: "a".repeat(64),
  }));
  expect(draftCertificationPassed(draft, rows)).toBe(true);
  expect(draftCertificationPassed(draft, [rows[0], rows[2]])).toBe(false);
  expect(
    draftCertificationPassed(draft, [...rows.slice(0, 2), { ...rows[2], name: "beta:quit" }]),
  ).toBe(false);
});

test("PASS publication output binds the downloaded draft ZIP, never the local N+1 ZIP", () => {
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  const downloaded = hash("downloaded CI draft zip"),
    next = hash("local bump zip");
  const draft = {
    tag: "v1.2.3-insider",
    channel: "beta" as const,
    assets: { "Opensteer-Beta-mac-arm64.zip": downloaded },
  };
  const lines = publicationLines(draft, downloaded, true);
  expect(lines).toEqual([
    `certified_zip_sha256=${downloaded}`,
    `gh workflow run release.yml --repo steerlabs/opensteer --ref main -f channel=insider -f publish=true -f certified_zip_sha256=${downloaded}`,
  ]);
  expect(lines.join("\n")).not.toContain(next);
  expect(() => publicationLines(draft, next, true)).toThrow();
  expect(publicationLines(draft, next, false)).toEqual([]);
  const stable = publicationLines(
    { tag: "desktop-v1.2.3", channel: "stable", assets: { "Opensteer-mac-arm64.zip": downloaded } },
    downloaded,
    true,
  );
  // Stable rebuilds the published insider of the same version; insiders take no tag.
  expect(stable[1]).toContain("-f channel=stable -f insider_tag=v1.2.3-insider -f publish=true");
});
