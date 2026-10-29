import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from "node:fs/promises";
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

it.skipIf(process.platform !== "darwin")(
  "prepares unchanged bytes, alpha feed/notes and refuses wrong signing/feed metadata",
  async () => {
    const root = await scratch();
    const zip = path.join(root, "application.zip");
    await writeFile(zip, "frozen archive bytes");
    let feed = publicFeedURL;
    let team = "B47U2LLKHW";
    let revision = sourceSha;
    const run: typeof runBounded = async (exe, args, options) => {
      if (exe === "unzip") return "Opensteer.app/Contents/Info.plist\n";
      if (exe === "ditto") {
        await mkdir(path.join(args[3]!, "Opensteer.app"));
        return "";
      }
      if (exe === "/usr/libexec/PlistBuddy") {
        const values: Record<string, string> = {
          CFBundleIdentifier: "com.opensteer.opensteer",
          CFBundleShortVersionString: version,
          CFBundleVersion: version,
          CFBundleExecutable: "Opensteer",
          OpensteerSourceRevision: revision,
          OpensteerUpdateFeedURL: feed,
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
    const input = { appZip: zip, version, sourceSha, out: path.join(root, "assets") };
    const notes = path.join(root, "notes.txt");
    await writeFile(notes, "Known issue: setup is still evolving.");
    const manifest = await prepare({ ...input, notesFile: notes }, run);
    expect(await readFile(path.join(input.out, assetNames[0]), "utf8")).toBe(
      "frozen archive bytes",
    );
    expect(manifest.title).toBe(`Opensteer ${version} (Alpha)`);
    expect(manifest.notes).toContain("curl -fsSL");
    expect(manifest.notes).toContain("Known issue");
    const json = JSON.parse(await readFile(path.join(input.out, assetNames[1]), "utf8"));
    expect(json.currentRelease).toBe(version);
    expect(json.releases[0].updateTo.name).toBe(manifest.title);
    expect(json.releases[0].updateTo.url).toBe(
      `https://github.com/steerlabs/opensteer/releases/download/desktop-v${version}/${assetNames[0]}`,
    );
    team = "WRONG";
    await expect(prepare(input, run)).rejects.toThrow("signing team");
    team = "B47U2LLKHW";
    revision = "b".repeat(40);
    await expect(prepare(input, run)).rejects.toThrow("revision");
    revision = sourceSha;
    feed = "http://localhost:8080/feed.json";
    await expect(prepare(input, run)).rejects.toThrow("--allow-private-feed");
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
  },
);

async function releaseFixture() {
  const dir = await scratch();
  for (const name of assetNames) await writeFile(path.join(dir, name), name);
  const assets = Object.fromEntries(
    await Promise.all(
      assetNames.map(async (name) => [name, await sha256File(path.join(dir, name))]),
    ),
  );
  const manifest = manifestSchema.parse({
    tag: `desktop-v${version}`,
    title: `Opensteer ${version} (Alpha)`,
    notes: "Alpha notes",
    version,
    sourceSha,
    assets,
    feedURL: publicFeedURL,
    privateFeed: false,
  });
  await writeFile(path.join(dir, "release.json"), JSON.stringify(manifest));
  const release = {
    id: 123,
    draft: true,
    tag_name: manifest.tag,
    name: manifest.title,
    body: `${manifest.notes}\n\n<!-- opensteer-release-manifest\n${JSON.stringify(manifest)}\n-->\n`,
    assets: assetNames.map((name) => ({ name })),
  };
  return { dir, manifest, release };
}

it("creates alpha drafts beside legacy releases, reuses exact assets, refuses drift and private public feeds", async () => {
  const { dir, manifest, release } = await releaseFixture();
  let exists = false;
  let uploads = 0;
  const run: typeof runBounded = async (exe, args) => {
    expect(exe).toBe("gh");
    if (args[0] === "api")
      return JSON.stringify([[exists ? release : { ...release, tag_name: "v0.11.2" }]]);
    if (args[1] === "create") {
      uploads++;
      expect(args).toContain("--draft");
      expect(args).toContain(manifest.title);
      expect(await readFile(args[args.indexOf("--notes-file") + 1]!, "utf8")).toBe(release.body);
    } else if (args[1] === "download") {
      const output = args[args.indexOf("--dir") + 1]!;
      for (const name of assetNames) await writeFile(path.join(output, name), name);
    } else throw new Error("Unexpected gh command");
    return "";
  };
  await draft(dir, "steerlabs/opensteer", run);
  exists = true;
  await draft(dir, "steerlabs/opensteer", run);
  expect(uploads).toBe(1);
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

it("publishes only verified drafts through a fake provider and rechecks anonymous asset hashes", async () => {
  const { release, manifest } = await releaseFixture();
  let tamperDraft = false;
  let tamperPublic = false;
  let patches = 0;
  const run: typeof runBounded = async (exe, args) => {
    if (exe === "gh" && args.includes("PATCH")) {
      patches++;
      expect(args).toContain("draft=false");
      expect(args).toContain("prerelease=false");
      expect(args).toContain("make_latest=true");
    } else if (exe === "gh" && args[1] === "download") {
      const output = args[args.indexOf("--dir") + 1]!;
      for (const name of assetNames)
        await writeFile(path.join(output, name), tamperDraft ? "tampered" : name);
    } else if (exe === "gh") return JSON.stringify(release);
    else if (exe === "curl") {
      expect(args).not.toContain("Authorization");
      const dest = args[args.indexOf("-o") + 1]!;
      await writeFile(dest, tamperPublic ? "tampered" : path.basename(dest));
    } else throw new Error("Unexpected provider");
    return "";
  };
  await publish("steerlabs/opensteer", manifest.tag, run);
  expect(patches).toBe(1);
  // A draft whose bytes drifted must never become public or Latest.
  tamperDraft = true;
  await expect(publish("steerlabs/opensteer", manifest.tag, run)).rejects.toThrow("Asset differs");
  expect(patches).toBe(1);
  tamperDraft = false;
  tamperPublic = true;
  await expect(publish("steerlabs/opensteer", manifest.tag, run)).rejects.toThrow("Asset differs");
  // Rerunning on an already published release only repeats the anonymous check.
  release.draft = false;
  tamperPublic = false;
  await publish("steerlabs/opensteer", manifest.tag, run);
  expect(patches).toBe(2);
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
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleVersion</key><string>${bundleVersion}</string><key>CFBundleShortVersionString</key><string>${bundleVersion}</string><key>CFBundleExecutable</key><string>Opensteer</string></dict></plist>`,
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
        res.end(`${tamper() ? "0".repeat(64) : hash}  Opensteer-mac-arm64.zip\n`),
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
    it("keeps a newer update ShipIt installed while the installer waited", async () => {
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
      await writeFile(path.join(state, "running"), "");
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
        ).resolves.toMatchObject({ stdout: "0.1.221\n" });
      } finally {
        await mirror.close();
      }
    });
  },
);
