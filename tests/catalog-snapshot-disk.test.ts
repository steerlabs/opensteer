import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildSnapshot, serialize, sha256 } from "../scripts/catalog-snapshot/core.ts";
import {
  readTree,
  replaceDirectory,
  separatePlaces,
  stageRelease,
  stagingBeside,
  writeTree,
} from "../scripts/catalog-snapshot/disk.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "catalog-disk-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const documentFor = (id: string, note = "") => ({
  package: `@acme.sh/${id}`,
  files: [
    { path: "index.ts", content: `export default {}; // ${note}` },
    { path: "package.json", content: JSON.stringify({ name: `@acme.sh/${id}` }) },
  ],
});
async function snapshotFiles(note = "") {
  const apps = ["mail", "chat"].map((id) => ({
    id,
    package: `@acme.sh/${id}`,
    name: id,
    description: id,
    auth: [],
    icons: id === "mail" ? [{ src: "icons/mail.svg" }] : [],
    source: `apps/${id}.json`,
  }));
  const { files, failures } = await buildSnapshot({
    feed: JSON.stringify({ version: 1, apps }),
    readSource: async (id) => JSON.stringify(documentFor(id, note)),
    readIcon: async () => new TextEncoder().encode("<svg/>"),
  });
  expect(failures).toEqual([]);
  return files;
}
async function snapshotAt(path: string, note = "") {
  await mkdir(path, { recursive: true });
  await writeTree(path, await snapshotFiles(note));
  return path;
}

describe("where the snapshot tool writes", () => {
  test("refuses an --out that reaches the repository through a symlink", async () => {
    const repository = join(root, "repository");
    await mkdir(repository);
    await symlink(repository, join(root, "outside"));
    // Lexically outside, really inside.
    await expect(
      separatePlaces({ out: join(root, "outside", "snapshot") }, repository),
    ).rejects.toThrow(/--out .*repository.* is inside the repository/u);
    await expect(separatePlaces({ out: join(root, "elsewhere") }, repository)).resolves.toEqual({
      out: join(root, "elsewhere"),
    });
  });

  test("refuses places that overlap each other", async () => {
    const repository = join(root, "repository");
    await mkdir(repository);
    await expect(
      separatePlaces({ out: join(root, "a"), cache: join(root, "a", "cache") }, repository),
    ).rejects.toThrow("overlaps --out");
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    await expect(
      separatePlaces({ out: join(root, "real"), cache: join(root, "alias") }, repository),
    ).rejects.toThrow("overlaps --out");
  });

  test("keeps the previous snapshot until its replacement is in place", async () => {
    const target = await snapshotAt(join(root, "snapshot"), "old");
    const before = await readFile(join(target, "manifest.json"));
    const staged = await stagingBeside(target);
    expect(staged.startsWith(join(root, ".snapshot.staging-"))).toBe(true);
    // A replacement that cannot be moved into place leaves the previous one as it was.
    await rm(staged, { recursive: true });
    await expect(replaceDirectory(target, staged)).rejects.toThrow();
    expect(await readFile(join(target, "manifest.json"))).toEqual(before);
    // A complete one replaces it, and nothing is left beside it.
    const next = await stagingBeside(target);
    await writeTree(next, await snapshotFiles("new"));
    await replaceDirectory(target, next);
    expect(await readFile(join(target, "manifest.json"))).not.toEqual(before);
    expect(await readdir(root)).toEqual(["snapshot"]);
  });
});

describe("assembling a release", () => {
  const stage = async (snapshot: string, previous: string[] = []) => {
    const staging = await mkdtemp(join(root, "staging-"));
    return { staging, result: await stageRelease({ snapshot, previous, staging, site: "s" }) };
  };

  test("deploys only checked files, with its configuration outside the snapshot", async () => {
    const snapshot = await snapshotAt(join(root, "snapshot"));
    const listing = [...(await readTree(snapshot)).keys()];
    const { staging, result } = await stage(snapshot);
    expect([...(await readTree(join(staging, "public"))).keys()].sort()).toEqual(listing.sort());
    const configuration = JSON.parse(await readFile(join(staging, "firebase.json"), "utf8"));
    expect(configuration.hosting).toMatchObject({ site: "s", public: "public", ignore: [] });
    expect(
      Object.fromEntries(
        configuration.hosting.headers.map(
          (rule: { source: string; headers: { value: string }[] }) => [
            rule.source,
            rule.headers[0]!.value,
          ],
        ),
      ),
    ).toEqual({
      "/index.json": "public, max-age=300, must-revalidate",
      "/manifest.json": "public, max-age=300, must-revalidate",
      "/apps/*.json": "public, max-age=300, must-revalidate",
      "/apps/*/*.json": "public, max-age=31536000, immutable",
      "/icons/*": "public, max-age=31536000, immutable",
    });
    expect(result.retained).toBe(0);
    // Nothing was written into the snapshot.
    expect([...(await readTree(snapshot)).keys()].sort()).toEqual(listing.sort());
  });

  test("keeps the previous release's documents so an index cached from it still resolves", async () => {
    const previous = await snapshotAt(join(root, "previous"), "old");
    const snapshot = await snapshotAt(join(root, "snapshot"), "new");
    const { staging, result } = await stage(snapshot, [previous]);
    const deployed = await readTree(join(staging, "public"));
    const old = JSON.parse(await readFile(join(previous, "index.json"), "utf8"));
    for (const app of old.apps) expect(sha256(deployed.get(app.source)!)).toBe(app.sha256);
    // The index and the legacy paths are the new release's.
    expect(deployed.get("index.json")).toEqual(
      new Uint8Array(await readFile(join(snapshot, "index.json"))),
    );
    expect(result.retained).toBe(2);
  });

  test("refuses an unlisted symlink, a listed dotfile and a hash fixed up in the manifest", async () => {
    const snapshot = await snapshotAt(join(root, "snapshot"));
    await symlink("/etc/hosts", join(snapshot, "apps", "extra.json"));
    await expect(stage(snapshot)).rejects.toThrow(/not regular files .*apps\/extra.json/u);
    await rm(join(snapshot, "apps", "extra.json"));

    const fixUp = async (change: () => Promise<void>) => {
      await change();
      const files = await readTree(snapshot);
      const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")));
      manifest.files = Object.fromEntries(
        [...files]
          .filter(([path]) => path !== "manifest.json")
          .map(([path, bytes]) => [path, { sha256: sha256(bytes), bytes: bytes.byteLength }]),
      );
      manifest.feed = manifest.files["index.json"];
      await writeFile(join(snapshot, "manifest.json"), serialize(manifest));
    };
    await fixUp(() => writeFile(join(snapshot, ".firebaserc"), "{}"));
    await expect(stage(snapshot)).rejects.toThrow(".firebaserc has no place in a snapshot");
    await rm(join(snapshot, ".firebaserc"));

    // A document edited at both of its paths, with the manifest made to agree.
    const index = JSON.parse(await readFile(join(snapshot, "index.json"), "utf8"));
    const edited = JSON.stringify(documentFor("mail", "edited"));
    await fixUp(async () => {
      await writeFile(join(snapshot, index.apps[0].source), edited);
      await writeFile(join(snapshot, "apps", "mail.json"), edited);
    });
    await expect(stage(snapshot)).rejects.toThrow("mail: no document with its hash");
  });

  test("refuses a staging directory that overlaps a snapshot", async () => {
    const snapshot = await snapshotAt(join(root, "snapshot"));
    const repository = join(root, "repository");
    await mkdir(repository);
    await expect(
      separatePlaces({ dir: snapshot, staging: join(snapshot, "apps") }, repository),
    ).rejects.toThrow("overlaps --dir");
  });

  test("a dry run needs no credentials and writes nothing into the snapshot", async () => {
    const snapshot = await snapshotAt(join(root, "snapshot"));
    const before = [...(await readTree(snapshot)).keys()].sort();
    const repository = join(import.meta.dirname, "..");
    const { GOOGLE_APPLICATION_CREDENTIALS: _key, FIREBASE_TOKEN: _token, ...env } = process.env;
    const output = execFileSync(
      join(repository, "node_modules", ".bin", "tsx"),
      [
        join(repository, "scripts", "catalog-snapshot", "publish.ts"),
        "--dir",
        snapshot,
        "--site",
        "s",
        "--first",
        "--dry-run",
      ],
      { cwd: root, encoding: "utf8", env: { ...env, HOME: root } },
    );
    expect(output).toContain("Dry run: nothing was uploaded.");
    expect([...(await readTree(snapshot)).keys()].sort()).toEqual(before);
  });
});
