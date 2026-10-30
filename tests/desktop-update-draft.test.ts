import { test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256File } from "@opensteer/shared/fileDigest";
import { assetsFor } from "../scripts/desktop-public-release.js";
import type { runBounded } from "../scripts/command-runner.js";
import {
  validateDraft,
  draftCertificationPassed,
  intakeOlder,
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

test("the older fixture is an explicit input, verified before the N+1 build", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "opensteer-older-")));
  const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
  try {
    // A fresh machine without --older stops before any download, build or output.
    const bin = path.join(root, "bin"),
      calls = path.join(root, "gh-calls"),
      work = path.join(root, "work");
    mkdirSync(bin);
    mkdirSync(work);
    writeFileSync(path.join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${calls}"\nexit 1\n`, {
      mode: 0o755,
    });
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/public-download/eu-run.ts",
        "--draft",
        "v1.2.3-insider",
        "--expect-version",
        "1.2.3",
        "--expect-sha",
        "a".repeat(40),
      ],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          OPENSTEER_UPDATE_JOURNEY_DIR: work,
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(cli.status).not.toBe(0);
    expect(cli.stderr).toMatch(/--older is required/u);
    expect(existsSync(calls)).toBe(false);
    expect(readdirSync(work)).toEqual([]);

    const n = { channel: "beta" as const, version: "1.2.3" };
    // A local signed build directory, as build-next writes it.
    const local = path.join(work, "builds", "b".repeat(40), "beta");
    await expect(intakeOlder(work, local, n)).rejects.toThrow(/no build\.json/u);
    mkdirSync(local, { recursive: true });
    const zip = path.join(local, "Opensteer-Beta-mac-arm64.zip");
    writeFileSync(zip, "older signed build");
    writeFileSync(
      path.join(local, "build.json"),
      JSON.stringify({ revision: "b".repeat(40), channel: "beta", version: "1.2.2", zip }),
    );
    writeFileSync(
      path.join(local, "archive-check.json"),
      JSON.stringify({ sha256: hash("older signed build") }),
    );
    expect(await intakeOlder(work, local, n)).toMatchObject({
      version: "1.2.2",
      revision: "b".repeat(40),
      zip,
      sha256: hash("older signed build"),
    });
    await expect(intakeOlder(work, local, { ...n, version: "1.2.2" })).rejects.toThrow(/below N/u);
    await expect(intakeOlder(work, local, { ...n, channel: "stable" })).rejects.toThrow(/channel/u);
    writeFileSync(zip, "changed");
    await expect(intakeOlder(work, local, n)).rejects.toThrow(/changed/u);

    // A release tag (published or draft) is downloaded and verified like the draft.
    const published = path.join(root, "published");
    mkdirSync(published);
    const assets: Record<string, string> = {};
    for (const name of assetsFor("beta").filter((x) => x !== "SHA256SUMS")) {
      writeFileSync(path.join(published, name), `older ${name}`);
      assets[name] = hash(`older ${name}`);
    }
    const sums = Object.entries(assets)
      .map(([name, h]) => `${h}  ${name}\n`)
      .join("");
    writeFileSync(path.join(published, "SHA256SUMS"), sums);
    assets.SHA256SUMS = hash(sums);
    const manifest = {
      channel: "beta",
      prerelease: true,
      tag: "v1.2.2-insider",
      title: "Opensteer Beta 1.2.2",
      notes: "notes",
      version: "1.2.2",
      sourceSha: "c".repeat(40),
      assets,
      feedURL: "https://github.com/steerlabs/opensteer#insider",
      privateFeed: false,
    };
    writeFileSync(path.join(published, "release.json"), JSON.stringify(manifest));
    const release = {
      id: 2,
      draft: false,
      prerelease: true,
      tag_name: manifest.tag,
      target_commitish: manifest.sourceSha,
      name: manifest.title,
      body: manifest.notes,
      assets: [...Object.keys(assets), "release.json"].map((name) => ({ name })),
    };
    const fake: typeof runBounded = async (exe, args) => {
      if (exe === "gh" && args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1]!;
        for (const name of readdirSync(published))
          copyFileSync(path.join(published, name), path.join(dir, name));
        return "";
      }
      return JSON.stringify([[release]]);
    };
    const fromTag = await intakeOlder(work, "v1.2.2-insider", n, fake);
    expect(fromTag).toMatchObject({ version: "1.2.2", revision: "c".repeat(40) });
    expect(await sha256File(fromTag.zip)).toBe(fromTag.sha256);
    await expect(intakeOlder(work, "v1.2.3-insider", n, fake)).rejects.toThrow(/below N/u);
    await expect(intakeOlder(work, "desktop-v1.2.2", n, fake)).rejects.toThrow(/channel/u);
    writeFileSync(path.join(published, "Opensteer-Beta-mac-arm64.zip"), "tamper");
    await expect(intakeOlder(work, "v1.2.2-insider", n, fake)).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
