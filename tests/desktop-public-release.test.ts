import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { sha256File } from "@opensteer/shared/fileDigest";
import { afterEach, describe, expect, it } from "vitest";
import {
  assetNames,
  downloadBase,
  draft,
  manifestSchema,
  prepare,
  publicFeedURL,
  publish,
  verifyInsiderProvenance,
  requireNewerStable,
} from "../scripts/desktop-public-release.js";
import type { runBounded } from "../scripts/command-runner.js";

const exec = promisify(execFile);
const roots: string[] = [];
async function scratch() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "opensteer-public-test-")));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const version = "0.1.220";
const sourceSha = "a".repeat(40);

it("restricts mirror protocols and credentials", () => {
  expect(downloadBase("http://localhost:8080/releases/download")).toContain("localhost");
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com",
    "file:///tmp/feed",
    "https://example.com/?token=x",
  ])
    expect(() => downloadBase(url)).toThrow();
});

it.skipIf(process.platform !== "darwin").each(["stable", "beta"] as const)(
  "prepares %s bytes and updater metadata; refuses wrong signing/feed metadata",
  async (channel) => {
    const beta = channel === "beta";
    const app = "Opensteer.app";
    const zipName = beta ? "Opensteer-mac-arm64.zip" : assetNames[0];
    const metadataName = beta ? "insider-mac.yml" : "latest-mac.yml";
    const expectedFeed = beta ? "https://github.com/steerlabs/opensteer#insider" : publicFeedURL;
    let cache = "opensteer-updater";
    let host = "";
    const root = await scratch();
    const zip = path.join(root, "application.zip");
    await writeFile(zip, "frozen archive bytes");
    let feed = "https://github.com/steerlabs/opensteer";
    let team = "B47U2LLKHW";
    let revision = sourceSha;
    const run: typeof runBounded = async (exe, args, options) => {
      if (exe === "unzip") return `${app}/Contents/Info.plist\n`;
      if (exe === "ditto") {
        await mkdir(path.join(args[3]!, `${app}/Contents/Resources`), { recursive: true });
        await writeFile(
          path.join(args[3]!, `${app}/Contents/Resources/app-update.yml`),
          `provider: github\nowner: steerlabs\nrepo: opensteer\nupdaterCacheDirName: ${cache}\n${host}`,
        );
        return "";
      }
      if (exe === "/usr/libexec/PlistBuddy") {
        const values: Record<string, string> = {
          CFBundleName: beta ? "Opensteer (Beta)" : "Opensteer",
          CFBundleIdentifier: "com.opensteer.opensteer",
          CFBundleShortVersionString: version,
          CFBundleVersion: version,
          CFBundleExecutable: "Opensteer",
          OpensteerSourceRevision: revision,
          OpensteerUpdateFeed: feed,
        };
        return values[args[1]!.replace("Print :", "")]!;
      }
      if (exe === "lipo") return "arm64";
      if (exe === "codesign" && options?.outputFile)
        await writeFile(options.outputFile, `TeamIdentifier=${team}\n`);
      else if (!["codesign", "xcrun", "spctl"].includes(exe))
        throw new Error(`Unexpected command ${exe}`);
      return "";
    };
    const input = {
      channel,
      launchCheckPassed: true,
      appZip: zip,
      version,
      sourceSha,
      out: path.join(root, "assets"),
    };
    const notes = path.join(root, "notes.txt");
    await writeFile(notes, "Known issue: setup is still evolving.");
    const manifest = await prepare({ ...input, notesFile: notes }, run);
    expect(await readFile(path.join(input.out, zipName), "utf8")).toBe("frozen archive bytes");
    expect(manifest.title).toBe(beta ? `Opensteer ${version}` : `Opensteer ${version} (Alpha)`);
    expect(manifest.notes.includes("curl -fsSL")).toBe(!beta);
    expect(manifest.notes).toContain("Known issue");
    const metadata = parseYaml(await readFile(path.join(input.out, metadataName), "utf8"));
    const bytes = await readFile(zip);
    expect(metadata.version).toBe(version + (beta ? "-insider" : ""));
    expect(metadata.files).toEqual([
      {
        url: zipName,
        sha512: createHash("sha512").update(bytes).digest("base64"),
        size: bytes.length,
      },
    ]);
    expect(metadata.path).toBe(zipName);
    expect(metadata.sha512).toBe(metadata.files[0].sha512);
    expect(await readFile(path.join(input.out, zipName + ".blockmap"))).not.toHaveLength(0);
    expect(Object.keys(manifest.assets).sort()).toEqual(
      (beta
        ? [zipName, zipName + ".blockmap", metadataName, "SHA256SUMS"]
        : [...assetNames]
      ).sort(),
    );
    const sums = await readFile(path.join(input.out, "SHA256SUMS"), "utf8");
    expect(sums).toContain(`${await sha256File(zip)}  ${zipName}\n`);
    expect(sums).not.toContain("release.json");
    expect(sums).not.toContain("  SHA256SUMS");
    if (channel === "beta") {
      const published = {
        id: 1,
        immutable: true,
        draft: false,
        prerelease: true,
        tag_name: manifest.tag,
        target_commitish: sourceSha,
        name: manifest.title,
        body: manifest.notes,
        assets: [...Object.keys(manifest.assets), "release.json"].map((name) => ({ name })),
      };
      const promotionRun: typeof runBounded = async (exe, args, options) => {
        if (exe !== "gh") return run(exe, args, options);
        if (args[1] === "download") {
          const dest = args[args.indexOf("--dir") + 1]!;
          for (const name of [...Object.keys(manifest.assets), "release.json"])
            await copyFile(path.join(input.out, name), path.join(dest, name));
          return "";
        }
        return JSON.stringify([[published]]);
      };
      const stableRun: typeof runBounded = (exe, args, options) =>
        exe === "/usr/libexec/PlistBuddy" && args.includes("Print :CFBundleName")
          ? Promise.resolve("Opensteer")
          : promotionRun(exe, args, options);
      const provenance = await verifyInsiderProvenance(
        { repo: "steerlabs/opensteer", tag: manifest.tag, sourceSha, version },
        promotionRun,
      );
      expect(provenance.sourceSha).toBe(sourceSha);
      const stableDir = path.join(root, "stable");
      const stable = await prepare(
        {
          channel: "stable",
          appZip: zip,
          version,
          sourceSha,
          out: stableDir,
          launchCheckPassed: true,
        },
        stableRun,
      );
      expect(stable.launchCheck).toBe("passed");
      const feed = parseYaml(await readFile(path.join(stableDir, "latest-mac.yml"), "utf8"));
      expect(feed.version).toBe(version);
      expect(feed.releaseDate).toEqual(expect.any(String));
    }
    cache = "wrong-cache";
    await expect(prepare(input, run)).rejects.toThrow();
    cache = "opensteer-updater";
    host = "host: private.example.com\n";
    await expect(prepare(input, run)).rejects.toThrow("--allow-private-feed");
    host = "";
    team = "WRONG";
    await expect(prepare(input, run)).rejects.toThrow("signing team");
    team = "B47U2LLKHW";
    revision = "b".repeat(40);
    await expect(prepare(input, run)).rejects.toThrow("revision");
    revision = sourceSha;
    feed = expectedFeed + " ";
    await expect(prepare(input, run)).rejects.toThrow("channel-neutral");
    feed = "http://localhost:8080/feed.json";
    await expect(prepare(input, run)).rejects.toThrow("channel-neutral");
    const privateManifest = await prepare(
      {
        ...input,
        out: path.join(root, "private"),
        allowPrivateFeed: true,
        downloadBase: "http://localhost:8080/releases/download",
      },
      run,
    );
    expect(privateManifest.privateFeed).toBe(true);
    expect(
      parseYaml(await readFile(path.join(root, "private", metadataName), "utf8")).files[0].url,
    ).toBe(zipName);
  },
);

const certifiedZip = (manifest: { assets: Record<string, string>; channel: "stable" | "beta" }) =>
  manifest.assets["Opensteer-mac-arm64.zip"]!;

async function releaseFixture(channel: "stable" | "beta" = "stable") {
  const names =
    channel === "stable"
      ? [...assetNames]
      : [
          "Opensteer-mac-arm64.zip",
          "Opensteer-mac-arm64.zip.blockmap",
          "insider-mac.yml",
          "SHA256SUMS",
        ];
  const dir = await scratch();
  for (const name of names) await writeFile(path.join(dir, name), name);
  await writeFile(
    path.join(dir, "SHA256SUMS"),
    (
      await Promise.all(
        names
          .filter((n) => n !== "SHA256SUMS")
          .map(async (n) => `${await sha256File(path.join(dir, n))}  ${n}\n`),
      )
    ).join(""),
  );
  const assets = Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await sha256File(path.join(dir, name))])),
  );
  const manifest = manifestSchema.parse({
    channel,
    prerelease: channel === "beta",
    tag: channel === "stable" ? `desktop-v${version}` : `v${version}-insider`,
    title: channel === "stable" ? `Opensteer ${version} (Alpha)` : `Opensteer ${version}`,
    notes: "Alpha notes",
    version,
    sourceSha,
    assets,
    feedURL:
      channel === "stable" ? publicFeedURL : "https://github.com/steerlabs/opensteer#insider",
    launchCheck: "passed",
    privateFeed: false,
  });
  await writeFile(path.join(dir, "release.json"), JSON.stringify(manifest));
  const release = {
    id: 123,
    draft: true,
    tag_name: manifest.tag,
    name: manifest.title,
    body: manifest.notes,
    prerelease: channel === "beta",
    target_commitish: manifest.sourceSha,
    assets: [...names, "release.json"].map((name) => ({ name })),
  };
  return { dir, manifest, release };
}

// GitHub's by-tag endpoint returns only published releases; a draft is found by listing.
function releaseApi(release: { draft: boolean }, args: readonly string[]): string {
  if (args.includes("--paginate")) return JSON.stringify([[release]]);
  if (release.draft && args.some((arg) => arg.includes("/releases/tags/")))
    throw new Error("gh: Not Found (HTTP 404)");
  return JSON.stringify(release);
}

it("creates alpha drafts beside legacy releases, reuses exact assets, refuses drift and private public feeds", async () => {
  const { dir, manifest, release } = await releaseFixture();
  let exists = false;
  let uploads = 0;
  let remoteDrift = "";
  const run: typeof runBounded = async (exe, args, options) => {
    expect(exe).toBe("gh");
    if (args[1] === "create" || args[1] === "download")
      expect(options?.timeoutMs).toBeGreaterThanOrEqual(600_000);
    if (args[0] === "api")
      return JSON.stringify([[exists ? release : { ...release, tag_name: "v0.11.2" }]]);
    if (args[1] === "create") {
      uploads++;
      expect(args).toContain("--draft");
      expect(args).toContain(manifest.title);
      // A missing tag is created at --target on publication; without it GitHub would
      // tag the default branch's current HEAD instead of the built source.
      expect(args[args.indexOf("--target") + 1]).toBe(manifest.sourceSha);
      expect(await readFile(args[args.indexOf("--notes-file") + 1]!, "utf8")).toBe(release.body);
    } else if (args[1] === "download") {
      const output = args[args.indexOf("--dir") + 1]!;
      for (const name of [...assetNames, "release.json"])
        await writeFile(
          path.join(output, name),
          name === remoteDrift ? "tampered" : await readFile(path.join(dir, name)),
        );
    } else throw new Error("Unexpected gh command");
    return "";
  };
  await draft(dir, "steerlabs/opensteer", run);
  exists = true;
  await draft(dir, "steerlabs/opensteer", run);
  expect(uploads).toBe(1);
  const missing = release.assets.pop()!;
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("metadata/assets disagree");
  release.assets.push(missing);
  remoteDrift = "release.json";
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("release.json differs");
  remoteDrift = assetNames[0];
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("Asset differs");
  remoteDrift = "";
  release.target_commitish = "main";
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("disagree");
  release.target_commitish = manifest.sourceSha;
  release.body = release.body.replace("Alpha notes", "Changed notes");
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("disagree");
  await writeFile(
    path.join(dir, "release.json"),
    JSON.stringify({ ...manifest, privateFeed: true }),
  );
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("private feed");
  await writeFile(path.join(dir, "release.json"), JSON.stringify(manifest));
  await writeFile(path.join(dir, assetNames[0]), "tampered");
  await expect(draft(dir, "steerlabs/opensteer", run)).rejects.toThrow("Asset differs");
});

async function withInsider(run: typeof runBounded): Promise<typeof runBounded> {
  const insider = await releaseFixture("beta");
  Object.assign(insider.release, { draft: false, immutable: true });
  return async (exe, args, options) => {
    if (exe === "gh" && args[1] === "download" && args[2] === insider.manifest.tag) {
      const dest = args[args.indexOf("--dir") + 1]!;
      for (const name of [...Object.keys(insider.manifest.assets), "release.json"])
        await copyFile(path.join(insider.dir, name), path.join(dest, name));
      return "";
    }
    const result = await run(exe, args, options);
    if (
      exe === "gh" &&
      args[0] === "api" &&
      !args.includes("PATCH") &&
      args.at(-1)?.startsWith("repos/steerlabs/opensteer/releases?")
    ) {
      const pages = JSON.parse(result) as unknown[][];
      pages.push([insider.release]);
      return JSON.stringify(pages);
    }
    return result;
  };
}

// Optional pinning must ship exactly the selected zip, even when a later swap
// rewrote release.json and SHA256SUMS to match the new bytes.
it("binds publication to the verified ZIP and requires certification for Stable", async () => {
  const certified = await releaseFixture("beta");
  const swapped = await releaseFixture("beta");
  const zip = "Opensteer-mac-arm64.zip";
  await writeFile(path.join(swapped.dir, zip), "swapped build");
  swapped.manifest.assets[zip] = await sha256File(path.join(swapped.dir, zip));
  await writeFile(
    path.join(swapped.dir, "SHA256SUMS"),
    Object.entries(swapped.manifest.assets)
      .filter(([n]) => n !== "SHA256SUMS")
      .map(([n, h]) => `${h}  ${n}\n`)
      .join(""),
  );
  swapped.manifest.assets.SHA256SUMS = await sha256File(path.join(swapped.dir, "SHA256SUMS"));
  await writeFile(path.join(swapped.dir, "release.json"), JSON.stringify(swapped.manifest));
  let patches = 0;
  const provider =
    (fixture: Awaited<ReturnType<typeof releaseFixture>>): typeof runBounded =>
    async (exe, args) => {
      if (exe === "gh" && args.includes("PATCH")) patches++;
      else if (exe === "gh" && args[1] === "download") {
        const output = args[args.indexOf("--dir") + 1]!;
        for (const name of [...Object.keys(fixture.manifest.assets), "release.json"])
          await writeFile(path.join(output, name), await readFile(path.join(fixture.dir, name)));
      } else if (exe === "gh") return releaseApi(fixture.release, args);
      else if (exe === "curl") {
        const dest = args[args.indexOf("-o") + 1]!;
        await writeFile(dest, await readFile(path.join(fixture.dir, path.basename(dest))));
      }
      return "";
    };
  const tag = certified.manifest.tag;
  const expected = {
    channel: "beta",
    sourceSha: certified.manifest.sourceSha,
    certifiedZipSha256: certifiedZip(certified.manifest),
  };
  await expect(publish("steerlabs/opensteer", tag, provider(swapped), expected)).rejects.toThrow(
    /certified/u,
  );
  // The workflow's publisher is newer than the source, so it is told which source to expect.
  await expect(
    publish("steerlabs/opensteer", tag, provider(certified), {
      ...expected,
      sourceSha: "f".repeat(40),
    }),
  ).rejects.toThrow(/source/u);
  expect(patches).toBe(0);
  await publish("steerlabs/opensteer", tag, provider(certified), expected);
  expect(patches).toBe(1);
  const stable = await releaseFixture("stable");
  const unchecked = { ...stable.manifest };
  delete unchecked.launchCheck;
  await writeFile(path.join(stable.dir, "release.json"), JSON.stringify(unchecked));
  await expect(
    publish("steerlabs/opensteer", stable.manifest.tag, provider(stable)),
  ).rejects.toThrow(/launch-check evidence/u);
  await writeFile(path.join(stable.dir, "release.json"), JSON.stringify(stable.manifest));
  await expect(
    publish("steerlabs/opensteer", stable.manifest.tag, provider(stable)),
  ).rejects.toThrow(/published immutable insider/);
  await publish("steerlabs/opensteer", stable.manifest.tag, await withInsider(provider(stable)), {
    channel: "stable",
    certifiedZipSha256: certifiedZip(stable.manifest),
  });
  expect(patches).toBe(2);
});

it("publishes only verified drafts through a fake provider and rechecks anonymous asset hashes", async () => {
  const { dir, release, manifest } = await releaseFixture();
  let tamperDraft = false;
  let tamperPublic = false;
  let patches = 0;
  const run: typeof runBounded = async (exe, args, options) => {
    if ((exe === "gh" && args[1] === "download") || exe === "curl")
      expect(options?.timeoutMs).toBeGreaterThanOrEqual(600_000);
    if (exe === "gh" && args.includes("PATCH")) {
      patches++;
      expect(args).toContain("draft=false");
      expect(args).toContain("prerelease=false");
      expect(args).toContain("make_latest=true");
    } else if (exe === "gh" && args[1] === "download") {
      const output = args[args.indexOf("--dir") + 1]!;
      for (const name of [...assetNames, "release.json"])
        await writeFile(
          path.join(output, name),
          tamperDraft && name !== "release.json"
            ? "tampered"
            : await readFile(path.join(dir, name)),
        );
    } else if (exe === "gh") return releaseApi(release, args);
    else if (exe === "curl") {
      expect(args).not.toContain("Authorization");
      const dest = args[args.indexOf("-o") + 1]!;
      await writeFile(
        dest,
        tamperPublic && path.basename(dest) !== "release.json"
          ? "tampered"
          : await readFile(path.join(dir, path.basename(dest))),
      );
    } else throw new Error("Unexpected provider");
    return "";
  };
  await publish("steerlabs/opensteer", manifest.tag, await withInsider(run), {
    certifiedZipSha256: certifiedZip(manifest),
  });
  expect(patches).toBe(1);
  // A draft retargeted away from the built source must not be published.
  release.target_commitish = "main";
  await expect(
    publish("steerlabs/opensteer", manifest.tag, await withInsider(run), {
      certifiedZipSha256: certifiedZip(manifest),
    }),
  ).rejects.toThrow("disagree");
  expect(patches).toBe(1);
  release.target_commitish = manifest.sourceSha;
  // A draft whose bytes drifted must never become public or Latest.
  tamperDraft = true;
  await expect(
    publish("steerlabs/opensteer", manifest.tag, await withInsider(run), {
      certifiedZipSha256: certifiedZip(manifest),
    }),
  ).rejects.toThrow("Asset differs");
  expect(patches).toBe(1);
  tamperDraft = false;
  tamperPublic = true;
  await expect(
    publish("steerlabs/opensteer", manifest.tag, await withInsider(run), {
      certifiedZipSha256: certifiedZip(manifest),
    }),
  ).rejects.toThrow("Asset differs");
  // Rerunning on an already published release only repeats the anonymous check.
  release.draft = false;
  tamperPublic = false;
  await publish("steerlabs/opensteer", manifest.tag, await withInsider(run), {
    certifiedZipSha256: certifiedZip(manifest),
  });
  expect(patches).toBe(2);
});

it("refuses an explicit draft channel mismatch before contacting GitHub", async () => {
  const { dir } = await releaseFixture();
  await expect(
    draft(
      dir,
      "steerlabs/opensteer",
      async () => {
        throw new Error("must not contact GitHub");
      },
      "beta",
    ),
  ).rejects.toThrow("channel");
});

it("beta drafts and publication never mark Latest", async () => {
  const { dir, manifest, release } = await releaseFixture("beta");
  let created = false;
  const run: typeof runBounded = async (exe, args) => {
    if (args.includes("PATCH")) {
      expect(args).toContain("prerelease=true");
      expect(args).toContain("make_latest=false");
    } else if (args[1] === "create") {
      created = true;
      expect(args).toContain("--prerelease");
      expect(args).toContain("--latest=false");
      expect(args).toContain(path.join(dir, "release.json"));
      expect(args).not.toContain(path.join(dir, "install.sh"));
    } else if (args[1] === "download") {
      const output = args[args.indexOf("--dir") + 1]!;
      for (const name of [...Object.keys(manifest.assets), "release.json"])
        await writeFile(path.join(output, name), await readFile(path.join(dir, name)));
    } else if (exe === "curl") {
      const dest = args[args.indexOf("-o") + 1]!;
      await writeFile(dest, await readFile(path.join(dir, path.basename(dest))));
    } else if (args.includes("--paginate") && !created) return "[[]]";
    else return releaseApi(release, args);
    return "";
  };
  await draft(dir, "steerlabs/opensteer", run, "beta");
  await publish("steerlabs/opensteer", manifest.tag, await withInsider(run), { channel: "beta" });
});

it.skipIf(process.platform !== "darwin")("rejects a real ad-hoc-signed archive", async () => {
  const root = await scratch();
  const bundle = await fixtureBundle(root, "com.opensteer.opensteer", version);
  await mkdir(path.join(bundle, "Contents/Resources"));
  await writeFile(
    path.join(bundle, "Contents/Resources/app-update.yml"),
    "provider: github\nowner: steerlabs\nrepo: opensteer\nupdaterCacheDirName: opensteer-updater\n",
  );
  await exec("codesign", ["--sign", "-", bundle]);
  const zip = path.join(root, "adhoc.zip");
  await exec("ditto", ["-c", "-k", "--keepParent", bundle, zip]);
  await expect(
    prepare({ channel: "stable", appZip: zip, version, sourceSha, out: path.join(root, "assets") }),
    // Every metadata check passes and the ad-hoc signature verifies, so only the
    // Developer ID signing authority can refuse it.
  ).rejects.toThrow("Wrong signing team");
});

async function fixtureBundle(root: string, id: string, bundleVersion: string) {
  const bundle = path.join(root, "Opensteer.app");
  await mkdir(path.join(bundle, "Contents/MacOS"), { recursive: true });
  await writeFixturePlist(bundle, id, bundleVersion);
  await writeFile(path.join(root, "main.c"), "int main(void) { return 0; }\n");
  await exec("clang", [
    "-arch",
    "arm64",
    path.join(root, "main.c"),
    "-o",
    path.join(bundle, "Contents/MacOS/Opensteer"),
  ]);
  await exec("codesign", ["--remove-signature", path.join(bundle, "Contents/MacOS/Opensteer")]);
  return bundle;
}

function writeFixturePlist(bundle: string, id: string, bundleVersion: string) {
  return writeFile(
    path.join(bundle, "Contents/Info.plist"),
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleName</key><string>Opensteer</string><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleVersion</key><string>${bundleVersion}</string><key>CFBundleShortVersionString</key><string>${bundleVersion}</string><key>OpensteerSourceRevision</key><string>${sourceSha}</string><key>OpensteerUpdateFeed</key><string>https://github.com/steerlabs/opensteer</string><key>CFBundleExecutable</key><string>Opensteer</string></dict></plist>`,
  );
}

async function fixtureMirror(zip: string, tamper: () => boolean) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url!;
    requests.push(url);
    if (url === "/releases/latest") {
      res.writeHead(302, { Location: `/releases/tag/desktop-v${version}` });
      res.end();
    } else if (url.startsWith("/releases/tag/")) res.end("release");
    else if (url.endsWith("SHA256SUMS")) {
      void sha256File(zip).then((hash) =>
        res.end(
          `${"1".repeat(64)}  latest-mac.yml\n${tamper() ? "0".repeat(64) : hash}  Opensteer-mac-arm64.zip\n${"2".repeat(64)}  Opensteer-mac-arm64.zip.blockmap\n`,
        ),
      );
    } else if (url.endsWith(".zip") && !url.startsWith("/objects/")) {
      res.writeHead(302, { Location: `http://localhost:${port}/objects/application.zip` });
      res.end();
    } else if (url === "/objects/application.zip") {
      void readFile(zip).then((bytes) => res.end(bytes));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server port");
  const port = address.port;
  return {
    requests,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function installer(repositoryUrl: string, target: string, env: NodeJS.ProcessEnv = {}) {
  return exec("sh", [path.resolve("scripts/install.sh")], {
    env: {
      ...process.env,
      ...env,
      OPENSTEER_RELEASE_REPOSITORY_URL: repositoryUrl,
      OPENSTEER_INSTALL_DIRECTORY: target,
      OPENSTEER_INSTALL_NO_OPEN: "1",
    },
  });
}

describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "installer real local mirror (never launch)",
  () => {
    it("pins a redirect once and refuses tampering, wrong identity, unsigned app, symlink and held lock", async () => {
      const root = await scratch();
      const bundle = await fixtureBundle(root, "wrong.identity", version);
      const zip = path.join(root, "application.zip");
      let tamper = true;
      const mirror = await fixtureMirror(zip, () => tamper);
      const target = path.join(root, "Applications");
      const install = () => installer(mirror.url, target);
      try {
        await exec("ditto", ["-c", "-k", "--keepParent", bundle, zip]);
        await expect(install()).rejects.toThrow("SHA-256 mismatch");
        tamper = false;
        await expect(install()).rejects.toThrow("Unexpected bundle id");
        expect(mirror.requests.filter((url) => url === "/releases/latest")).toHaveLength(2);
        await writeFixturePlist(bundle, "com.opensteer.opensteer", version);
        await rm(zip);
        await exec("ditto", ["-c", "-k", "--keepParent", bundle, zip]);
        await expect(install()).rejects.toThrow(/not signed|code object/u);
        await symlink(bundle, path.join(target, "Opensteer.app"));
        await expect(install()).rejects.toThrow("symlink");
        await rm(path.join(target, "Opensteer.app"));
        // Same bundle id and a newer version, but not an Opensteer-signed build:
        // never accept it as the installed release or launch it.
        await mkdir(target, { recursive: true });
        await exec("ditto", [bundle, path.join(target, "Opensteer.app")]);
        await writeFixturePlist(
          path.join(target, "Opensteer.app"),
          "com.opensteer.opensteer",
          "9.9.9",
        );
        await expect(install()).rejects.toThrow("not a valid Opensteer build");
        await rm(path.join(target, "Opensteer.app"), { recursive: true });
        await mkdir(path.join(target, ".opensteer-install.lock"));
        await expect(install()).rejects.toThrow("Another installer");
      } finally {
        await mirror.close();
      }
    });

    // Signing tools and process state are shimmed so the transition is
    // deterministic: while the installer waits for the app to quit, ShipIt
    // installs a newer staged update than the installer's pinned release.
    it.each(["newer ShipIt update", "same-base Beta"])(
      "handles %s during Stable installation",
      async (scenario) => {
        const root = await scratch();
        const bundle = await fixtureBundle(root, "com.opensteer.opensteer", version);
        const zip = path.join(root, "application.zip");
        await exec("ditto", ["-c", "-k", "--keepParent", bundle, zip]);
        const target = path.join(root, "Applications");
        const installed = path.join(target, "Opensteer.app");
        await mkdir(target);
        await exec("ditto", [bundle, installed]);
        await writeFixturePlist(installed, "com.opensteer.opensteer", "0.1.219");
        const state = path.join(root, "state");
        await mkdir(state);
        if (scenario === "same-base Beta") {
          await writeFixturePlist(installed, "com.opensteer.opensteer", version);
          await exec("/usr/libexec/PlistBuddy", [
            "-c",
            "Set :CFBundleName Opensteer (Beta)",
            path.join(installed, "Contents/Info.plist"),
          ]);
        } else await writeFile(path.join(state, "running"), "");
        const shims = path.join(root, "bin");
        await mkdir(shims);
        const shim = (name: string, body: string) =>
          writeFile(path.join(shims, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
        await shim("codesign", `case "$*" in *-dv*) echo TeamIdentifier=B47U2LLKHW >&2 ;; esac`);
        await shim("spctl", "exit 0");
        await shim(
          "ps",
          `[ -e "${state}/running" ] && echo "${installed}/Contents/MacOS/Opensteer"; exit 0`,
        );
        await shim(
          "osascript",
          `/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString 0.1.221" -c "Set :CFBundleVersion 0.1.221" "${installed}/Contents/Info.plist" && rm "${state}/running"`,
        );
        const mirror = await fixtureMirror(zip, () => false);
        try {
          await installer(mirror.url, target, { PATH: `${shims}:${process.env.PATH ?? ""}` });
          await expect(
            exec("/usr/libexec/PlistBuddy", [
              "-c",
              "Print :CFBundleShortVersionString",
              path.join(installed, "Contents/Info.plist"),
            ]),
          ).resolves.toMatchObject({
            stdout: scenario === "same-base Beta" ? `${version}\n` : "0.1.221\n",
          });
          if (scenario === "same-base Beta")
            await expect(
              exec("/usr/libexec/PlistBuddy", [
                "-c",
                "Print :CFBundleName",
                path.join(installed, "Contents/Info.plist"),
              ]),
            ).resolves.toMatchObject({ stdout: "Opensteer\n" });
        } finally {
          await mirror.close();
        }
      },
    );
  },
);

it("refuses older/equal Stable, permits the first Stable and ignores concurrent insiders", async () => {
  const { release } = await releaseFixture();
  expect(() => requireNewerStable(version, [])).not.toThrow();
  expect(() => requireNewerStable(version, [{ ...release, draft: false }])).toThrow(/newer/);
  expect(() => requireNewerStable("0.1.219", [{ ...release, draft: false }])).toThrow(/newer/);
  expect(() => requireNewerStable("0.1.221", [{ ...release, draft: false }])).not.toThrow();
  expect(() =>
    requireNewerStable(version, [
      { ...release, tag_name: "v99.0.0-insider", draft: false, prerelease: true },
    ]),
  ).not.toThrow();
});

it("Stable refuses a draft, mutable or incomplete insider and mismatched source evidence", async () => {
  const fixture = await releaseFixture("beta");
  const input = {
    repo: "steerlabs/opensteer",
    tag: fixture.manifest.tag,
    sourceSha,
    version,
  };
  let missing = false;
  const run: typeof runBounded = async (exe, args) => {
    expect(exe).toBe("gh");
    if (args[1] === "download") {
      const dest = args[args.indexOf("--dir") + 1]!;
      for (const name of [...Object.keys(fixture.manifest.assets), "release.json"]) {
        if (missing && name.endsWith(".blockmap")) continue;
        await writeFile(path.join(dest, name), await readFile(path.join(fixture.dir, name)));
      }
      return "";
    }
    return JSON.stringify([[fixture.release]]);
  };
  await expect(verifyInsiderProvenance(input, run)).rejects.toThrow(/published immutable insider/);
  fixture.release.draft = false;
  await expect(verifyInsiderProvenance(input, run)).rejects.toThrow(/published immutable insider/);
  Object.assign(fixture.release, { immutable: true });
  missing = true;
  await expect(verifyInsiderProvenance(input, run)).rejects.toThrow(/ENOENT/);
  missing = false;
  await expect(
    verifyInsiderProvenance({ ...input, sourceSha: "b".repeat(40) }, run),
  ).rejects.toThrow(/source\/version/);
});
