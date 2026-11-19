import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildSnapshot,
  checkLive,
  previousChoice,
  publishedManifest,
  releaseIntervalSeconds,
  serialize,
  sha256,
} from "../scripts/catalog-snapshot/core.ts";
import { publishLockOf, publishRelease } from "../scripts/catalog-snapshot/release.ts";
import { liveManifest } from "../scripts/catalog-snapshot/served.ts";
import { takeSnapshot } from "../scripts/catalog-snapshot/take.ts";
import {
  asideOf,
  holdLock,
  lockOf,
  readTree,
  recoverBeside,
  refuseLinks,
  replaceDirectory,
  separatePlaces,
  stageRelease,
  stagingBeside,
  writeFileAtomic,
  writeTree,
} from "../scripts/catalog-snapshot/disk.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "catalog-disk-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const published = "2026-11-18T00:00:00.000Z";
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

describe("temporary files and the swap", () => {
  test("never writes through a symlink at a temporary path or on the way to the file", async () => {
    const victim = join(root, "repository-file");
    await writeFile(victim, "keep");
    const target = join(root, "out.rewrites.json");
    // The adjacent `.part` name an earlier version wrote through.
    await symlink(victim, `${target}.part`);
    await writeFileAtomic(target, new TextEncoder().encode("report"));
    expect(await readFile(target, "utf8")).toBe("report");
    expect(await readFile(victim, "utf8")).toBe("keep");
    // A symlink at the target itself is replaced, not followed.
    await rm(target);
    await symlink(victim, target);
    await writeFileAtomic(target, new TextEncoder().encode("again"));
    expect(await readFile(victim, "utf8")).toBe("keep");
    // A directory reached through a symlink is refused.
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "cache"));
    await expect(
      writeFileAtomic(join(root, "cache", "apps.json"), new TextEncoder().encode("x")),
    ).rejects.toThrow("through a symlink");
    expect(await readdir(join(root, "real"))).toEqual([]);
  });

  test("refuses a cache that holds a symlink", async () => {
    await mkdir(join(root, "cache", "apps"), { recursive: true });
    await writeFile(join(root, "cache", "index.json"), "{}");
    await refuseLinks(join(root, "cache"));
    await symlink(join(root, "elsewhere"), join(root, "cache", "apps", "mail.json"));
    await expect(refuseLinks(join(root, "cache"))).rejects.toThrow(/symlinks are refused.*mail/u);
  });

  test("puts back a snapshot left aside by a stopped swap and clears stale staging", async () => {
    const target = await snapshotAt(join(root, "snapshot"), "old");
    const before = await readFile(join(target, "manifest.json"));
    // Stopped between the two renames: the earlier snapshot aside, the new one still staged.
    const staged = await stagingBeside(target);
    await writeTree(staged, await snapshotFiles("new"));
    await rename(target, asideOf(target));
    expect(await recoverBeside(target)).toEqual([
      expect.stringContaining("the earlier snapshot was put back"),
      expect.stringContaining("left by an interrupted run"),
    ]);
    expect(await readFile(join(target, "manifest.json"))).toEqual(before);
    expect(await readdir(root)).toEqual(["snapshot"]);
    // Stopped after both renames, before the earlier one was removed.
    await mkdir(asideOf(target));
    expect(await recoverBeside(target)).toEqual([expect.stringContaining("swap that completed")]);
    expect(await readdir(root)).toEqual(["snapshot"]);
    // A missing parent is created.
    expect(await recoverBeside(join(root, "a", "b", "snapshot"))).toEqual([]);
    expect(await readdir(join(root, "a"))).toEqual(["b"]);
    await expect(recoverBeside("/")).rejects.toThrow("is a mount root");
  });
});

describe("the snapshot tool", () => {
  /** Rebuild from a cache, as `--offline`; returns what it said. */
  const run = async (options: { out: string; cache: string; rules?: string }) => {
    const lines: string[] = [];
    await takeSnapshot({ ...options, offline: true }, (line) => lines.push(line));
    return lines.join("\n");
  };
  async function cache(note = "") {
    const path = join(root, "cache");
    await rm(path, { recursive: true, force: true });
    await mkdir(join(path, "apps"), { recursive: true });
    await mkdir(join(path, "icons"));
    const apps = ["mail", "chat"].map((id) => ({
      id,
      package: `@acme.sh/${id}`,
      name: id,
      description: id,
      auth: [],
      icons: id === "mail" ? [{ src: "icons/mail.svg" }] : [],
      source: `apps/${id}.json`,
    }));
    await writeFile(join(path, "index.json"), JSON.stringify({ version: 1, apps }));
    for (const id of ["mail", "chat"])
      await writeFile(join(path, "apps", `${id}.json`), JSON.stringify(documentFor(id, note)));
    await writeFile(join(path, "icons", "mail.svg"), "<svg/>");
    return path;
  }
  const rulesFile = async (names: string[]) => {
    const path = join(root, "rules.json");
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        names,
        rules: [{ id: "c", scope: "comments", from: "old", to: "new" }],
        preserve: [],
      }),
    );
    return path;
  };

  test("writes its report beside the snapshot it describes, and never through a link", async () => {
    const out = join(root, "out");
    const victim = join(root, "repository-file");
    await writeFile(victim, "keep");
    await symlink(victim, `${out}.rewrites.json.part`);
    await run({ out, cache: await cache("old"), rules: await rulesFile([]) });
    expect(await readFile(victim, "utf8")).toBe("keep");
    const manifest = await readFile(join(out, "manifest.json"));
    const report = JSON.parse(await readFile(`${out}.rewrites.json`, "utf8"));
    expect(report.manifestSha256).toBe(sha256(manifest));
    expect(report.rules).toEqual([{ id: "c", scope: "comments", count: 2 }]);

    // A build that fails leaves the snapshot and its report as they were.
    await expect(
      run({ out, cache: join(root, "cache"), rules: await rulesFile(["new"]) }),
    ).rejects.toThrow("Not usable");
    expect(await readFile(join(out, "manifest.json"))).toEqual(manifest);
    expect(JSON.parse(await readFile(`${out}.rewrites.json`, "utf8")).manifestSha256).toBe(
      sha256(manifest),
    );
    expect(await readFile(`${out}.rewrites.failed.json`, "utf8")).toContain('"remaining"');

    // A report that describes another build is removed; a build without rules leaves none.
    await writeFile(`${out}.rewrites.json`, JSON.stringify({ manifestSha256: "0".repeat(64) }));
    const output = await run({ out, cache: await cache("other") });
    expect(output).toContain("did not describe the snapshot");
    expect((await readdir(root)).sort()).toEqual(
      ["cache", "out", "out.rewrites.json.part", "repository-file", "rules.json"].sort(),
    );
  });

  test("commits the report with its snapshot, so a stop after the swap keeps it", async () => {
    const out = join(root, "out");
    await run({ out, cache: await cache("old"), rules: await rulesFile([]) });
    // A second build, stopped after its swap and before its report was moved into place.
    const other = join(root, "other");
    await run({ out: other, cache: await cache("other"), rules: await rulesFile([]) });
    const swapped = await readFile(`${other}.rewrites.json`, "utf8");
    expect(await readFile(join(other, "manifest.json"))).not.toEqual(
      await readFile(join(out, "manifest.json")),
    );
    await rm(out, { recursive: true });
    await rename(other, out);
    await rename(`${other}.rewrites.json`, `${out}.rewrites.next.json`);
    // The next run puts that report in place before it builds (this build fails, changing nothing).
    await expect(
      run({ out, cache: join(root, "cache"), rules: await rulesFile(["other"]) }),
    ).rejects.toThrow("Not usable");
    expect(await readFile(`${out}.rewrites.json`, "utf8")).toBe(swapped);
    expect(JSON.parse(swapped).manifestSha256).toBe(
      sha256(await readFile(join(out, "manifest.json"))),
    );
    // One left by a run stopped before its swap describes no snapshot there, and goes.
    await writeFile(
      `${out}.rewrites.next.json`,
      JSON.stringify({ manifestSha256: "0".repeat(64) }),
    );
    const output = await run({ out, cache: await cache("new") });
    expect(output).toContain("left by a run stopped before its swap");
    // A report path that is a link is refused.
    await symlink(join(root, "cache", "index.json"), `${out}.rewrites.json`);
    await expect(run({ out, cache: join(root, "cache") })).rejects.toThrow("is a symlink");
  });

  test("recovers from a stop between the swap's renames", async () => {
    const out = join(root, "nested", "out");
    await run({ out, cache: await cache("old") });
    const manifest = await readFile(join(out, "manifest.json"));
    await rename(out, asideOf(out));
    await mkdir(join(root, "nested", ".out.staging-stale"));
    const output = await run({ out, cache: await cache("new") });
    expect(output).toContain("the earlier snapshot was put back");
    expect(output).toContain(".out.staging-stale, left by an interrupted run");
    expect(await readFile(join(out, "manifest.json"))).not.toEqual(manifest);
    expect(await readdir(join(root, "nested"))).toEqual(["out"]);
  });

  test("lets one run at a time write an output, so recovery never removes a running build", async () => {
    const out = join(root, "out");
    await run({ out, cache: await cache("old") });
    const manifest = await readFile(join(out, "manifest.json"));
    // A first run still going: it holds the lock, and its build and the earlier snapshot it set
    // aside look like what a stopped run leaves.
    const release = await holdLock(lockOf(out), "--out", () => {});
    const building = await stagingBeside(out);
    await rename(out, asideOf(out));
    await expect(run({ out, cache: await cache("new") })).rejects.toThrow(
      `is in use by process ${process.pid}`,
    );
    expect((await readdir(root)).sort()).toEqual(
      [".out.lock", ".out.previous", basename(building), "cache"].sort(),
    );
    await rename(asideOf(out), out);
    await rm(building, { recursive: true });
    await release();
    expect(await readdir(root)).not.toContain(".out.lock");

    // A lock left by a run that is no longer going is taken over, and the run says so.
    const ended = spawn(process.execPath, ["-e", ""]);
    await new Promise((done) => ended.on("exit", done));
    await writeFile(lockOf(out), JSON.stringify({ pid: ended.pid, started: "then" }));
    const output = await run({ out, cache: await cache("new") });
    expect(output).toContain(`took over the lock ${lockOf(out)} from process ${ended.pid}`);
    expect(await readFile(join(out, "manifest.json"))).not.toEqual(manifest);
    expect((await readdir(root)).sort()).toEqual(["cache", "out"]);
  });

  test("refuses an input that is a name recovery reserves beside --out", async () => {
    const out = join(root, "data", "catalog");
    await run({ out, cache: await cache("old") });
    const manifest = await readFile(join(out, "manifest.json"));
    const rules = await rulesFile([]);
    for (const name of [
      ".catalog.staging-cache",
      ".catalog.previous",
      ".catalog.lock",
      "catalog.rewrites.next.json",
    ]) {
      const reserved = join(root, "data", name);
      await rename(await cache("new"), reserved);
      // The waiting report is also one of the tool's own places, so it overlaps first.
      const refused = (key: string, path: string) =>
        name.endsWith(".json") && key === "cache"
          ? /overlaps --cache/u
          : `--${key} ${path} is or lies inside`;
      await expect(run({ out, cache: reserved })).rejects.toThrow(refused("cache", reserved));
      await expect(run({ out, cache: join(reserved, "inner") })).rejects.toThrow(
        refused("cache", join(reserved, "inner")),
      );
      await rename(rules, join(reserved, "rules.json"));
      await expect(
        run({ out, cache: join(root, "cache"), rules: join(reserved, "rules.json") }),
      ).rejects.toThrow(refused("rules", join(reserved, "rules.json")));
      await rename(join(reserved, "rules.json"), rules);
      // Nothing was removed or moved.
      expect(await readFile(join(reserved, "index.json"), "utf8")).toContain('"apps"');
      expect(await readFile(join(out, "manifest.json"))).toEqual(manifest);
      await rename(reserved, join(root, "cache"));
    }
  });

  test("refuses a cache holding a symlink", async () => {
    const path = await cache();
    await writeFile(join(root, "outside.json"), JSON.stringify(documentFor("mail")));
    await rm(join(path, "apps", "mail.json"));
    await symlink(join(root, "outside.json"), join(path, "apps", "mail.json"));
    await expect(run({ out: join(root, "out"), cache: path })).rejects.toThrow(
      /symlinks are refused/u,
    );
  });
});

describe("assembling a release", () => {
  const stage = async (snapshot: string, previous: string[] = []) => {
    const staging = await mkdtemp(join(root, "staging-"));
    const result = await stageRelease({ snapshot, previous, staging, site: "s", published });
    return { staging, result };
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
    // The release's manifest is the snapshot's, recording when it was published.
    const manifest = await readFile(join(snapshot, "manifest.json"));
    expect(await readFile(join(staging, "public", "manifest.json"))).toEqual(
      Buffer.from(publishedManifest(manifest, published)),
    );
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

  test("a dry run needs no credentials, reads no site and writes nothing into the snapshot", async () => {
    const snapshot = await snapshotAt(join(root, "snapshot"));
    const before = [...(await readTree(snapshot)).keys()].sort();
    const lines: string[] = [];
    const deploys: string[] = [];
    // An address nothing listens on: a dry run must not read it.
    await publishRelease(
      { dir: snapshot, site: "s", first: true, dryRun: true, siteUrl: "http://127.0.0.1:9/" },
      (line) => lines.push(line),
      (command) => void deploys.push(command.join(" ")),
    );
    expect(lines.join("\n")).toContain("was not read");
    expect(lines.join("\n")).toContain("Dry run: nothing was uploaded.");
    expect(deploys).toEqual([]);
    expect([...(await readTree(snapshot)).keys()].sort()).toEqual(before);
  });

  test("takes --previous or --first, and refuses a blank --previous", () => {
    expect(previousChoice("/s", false)).toBe("/s");
    expect(previousChoice(undefined, true)).toBeUndefined();
    for (const [previous, first] of [
      ["", false],
      [" ", false],
      [undefined, false],
      ["/s", true],
    ] as const)
      expect(() => previousChoice(previous, first)).toThrow(/blank|Pass --previous/u);
  });
});

describe("publishing over the live release", () => {
  const now = new Date("2026-11-18T12:00:00.000Z");
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

  test("requires --previous to be exactly the live release, published long enough ago", async () => {
    const previous = (await snapshotFiles("old")).get("manifest.json")!;
    const other = (await snapshotFiles("other")).get("manifest.json")!;
    const live = publishedManifest(previous, ago(releaseIntervalSeconds + 1));
    const check = (input: Partial<Parameters<typeof checkLive>[0]>) =>
      checkLive({ live, previous, now, ignoreInterval: false, ...input });
    expect(check({})).toContain("the live release is --previous");
    // A stale --previous: another snapshot, or the live one with any byte changed.
    expect(() => check({ previous: other })).toThrow("--previous is not the live release");
    const edited = new Uint8Array(live);
    edited[edited.length - 1] = 0x20;
    expect(() => check({ live: edited })).toThrow("--previous is not the live release");
    expect(() => check({ live: previous })).toThrow("--previous is not the live release");
    // Too soon after the live release, unless asked to.
    const recent = publishedManifest(previous, ago(60));
    expect(() => check({ live: recent })).toThrow(/published 1 minutes ago; wait until/u);
    expect(check({ live: recent, ignoreInterval: true })).toContain("the live release is");
    // --first only for a site that serves no manifest.
    expect(() => check({ previous: undefined })).toThrow("--first, but the site already serves");
    expect(check({ live: undefined, previous: undefined })).toBe("the site serves no manifest yet");
    expect(() => check({ live: undefined })).toThrow("the site serves no manifest: pass --first");
  });

  test("deploys only over the live release it was given, long enough after it", async () => {
    const previous = await snapshotAt(join(root, "previous"), "old");
    const snapshot = await snapshotAt(join(root, "snapshot"), "new");
    const other = await snapshotAt(join(root, "other"), "other");
    let live: Uint8Array | undefined;
    const server = createServer((request, response) => {
      if (request.url === "/manifest.json" && live !== undefined) response.end(live);
      else response.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const deployed: { command: string; manifest: string; previous: boolean }[] = [];
    const publish = (options: { previous?: string; first?: boolean }) =>
      publishRelease(
        { dir: snapshot, site: `s-${basename(root)}`, siteUrl, ...options },
        () => {},
        async (command, cwd) => {
          const files = await readTree(join(cwd, "public"));
          const old = JSON.parse(await readFile(join(previous, "index.json"), "utf8"));
          deployed.push({
            command: command.join(" "),
            manifest: new TextDecoder().decode(files.get("manifest.json")),
            previous: files.has(old.apps[0].source),
          });
        },
      );
    const manifestOf = async (path: string) => readFile(join(path, "manifest.json"));
    try {
      live = publishedManifest(await manifestOf(previous), "2026-01-01T00:00:00.000Z");
      await expect(publish({ previous: other })).rejects.toThrow(
        "--previous is not the live release",
      );
      await expect(publish({ first: true })).rejects.toThrow(
        "--first, but the site already serves a manifest",
      );
      await expect(publish({ previous: " " })).rejects.toThrow("--previous is blank");
      expect(deployed).toEqual([]);
      // The live release given as --previous, published long ago: deployed with its documents.
      await publish({ previous });
      expect(deployed).toEqual([
        {
          command: expect.stringContaining("firebase-tools@15.34.2 deploy --only hosting"),
          manifest: expect.stringMatching(/"published": "\d{4}-/u),
          previous: true,
        },
      ]);
      live = publishedManifest(await manifestOf(previous), new Date().toISOString());
      await expect(publish({ previous })).rejects.toThrow("wait until 65 minutes have passed");
      live = undefined;
      await expect(publish({ previous })).rejects.toThrow(
        "the site serves no manifest: pass --first",
      );
      expect(deployed).toHaveLength(1);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test("publishes to a site one at a time, and only over the release it checked", async () => {
    const previous = await snapshotAt(join(root, "previous"), "old");
    const snapshot = await snapshotAt(join(root, "snapshot"), "new");
    const other = await snapshotAt(join(root, "other"), "other");
    const live = publishedManifest(
      await readFile(join(previous, "manifest.json")),
      "2026-01-01T00:00:00.000Z",
    );
    // Another publish deploys `other` after this one's first read of the live release.
    const answers = [
      live,
      publishedManifest(await readFile(join(other, "manifest.json")), now.toISOString()),
    ];
    let reads = 0;
    const server = createServer((request, response) => {
      if (request.url === "/manifest.json") response.end(answers[Math.min(reads++, 1)]);
      else response.writeHead(404).end();
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const siteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const site = `s-${basename(root)}`;
    let deployed = 0;
    const publish = () =>
      publishRelease(
        { dir: snapshot, site, siteUrl, previous },
        () => {},
        () => {
          deployed++;
        },
      );
    try {
      // Refused while another publish to the site holds its lock, before the site is read.
      const unlock = await holdLock(publishLockOf(site), "publishing", () => {});
      await expect(publish()).rejects.toThrow(`is in use by process ${process.pid}`);
      expect(reads).toBe(0);
      await unlock();
      // The live release changed between the check and the deploy: nothing is deployed.
      await expect(publish()).rejects.toThrow("changed since it was checked");
      expect({ reads, deployed }).toEqual({ reads: 2, deployed: 0 });
      // The lock is released either way.
      await expect(readFile(publishLockOf(site))).rejects.toThrow("ENOENT");
    } finally {
      await new Promise((done) => server.close(done));
    }
  });

  test("reads the live manifest without following a redirect", async () => {
    const answers: Record<string, [number, string]> = {
      "/a/manifest.json": [200, "{}"],
      "/b/manifest.json": [404, ""],
      "/c/manifest.json": [302, ""],
    };
    const server = createServer((request, response) => {
      const [status, body] = answers[request.url!] ?? [500, ""];
      response.writeHead(status, status === 302 ? { location: "/a/manifest.json" } : {}).end(body);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect(new TextDecoder().decode(await liveManifest(`${base}/a/manifest.json`))).toBe("{}");
      expect(await liveManifest(`${base}/b/manifest.json`)).toBeUndefined();
      await expect(liveManifest(`${base}/c/manifest.json`)).rejects.toThrow("HTTP 302");
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});
