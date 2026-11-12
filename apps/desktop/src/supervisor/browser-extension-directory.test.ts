import { mkdtemp, readFile, readdir, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { syncBrowserExtensionDirectory } from "./browser-extension-directory.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "extension-sync-"));
  roots.push(root);
  const directory = path.join(root, "Browser Extension");
  const zipPath = path.join(root, "extension.zip");
  const logs: string[] = [];
  const options = {
    userDataDirectory: root,
    zipPath,
    log: (message: string) => logs.push(message),
  };
  const bundle = async (id: string) => {
    await writeFile(
      zipPath,
      zipSync({
        "manifest.json": strToU8(
          JSON.stringify({ background: { service_worker: `b/${id}/worker.js` } }),
        ),
        "connect.html": strToU8(`<script src="b/${id}/connect.js"></script>`),
        "icons/probe.png": strToU8(id),
        [`b/${id}/worker.js`]: strToU8(id),
        [`b/${id}/connect.js`]: strToU8(id),
      }),
    );
  };
  const current = async () =>
    JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")).background
      .service_worker;
  return { root, directory, zipPath, options, logs, bundle, current };
}

describe("browser extension folder", () => {
  it("installs, updates root files last, and retains only current and previous builds", async () => {
    const f = await fixture();
    await f.bundle("one");
    expect(await syncBrowserExtensionDirectory(f.options)).toBe(f.directory);
    expect(await f.current()).toBe("b/one/worker.js");
    expect(await readFile(path.join(f.directory, "b/one/worker.js"), "utf8")).toBe("one");
    for (const id of ["two", "three"]) {
      await f.bundle(id);
      const published: string[] = [];
      await syncBrowserExtensionDirectory({
        ...f.options,
        afterPublish: (name) => published.push(name),
      });
      expect(published).toEqual([`b/${id}`, "connect.html", "icons/probe.png", "manifest.json"]);
    }
    expect(await f.current()).toBe("b/three/worker.js");
    expect(await readdir(path.join(f.directory, "b"))).toEqual(["three", "two"]);
    expect(await readFile(path.join(f.directory, "connect.html"), "utf8")).toContain("b/three/");
    expect(await readFile(path.join(f.directory, "icons/probe.png"), "utf8")).toBe("three");
    const before = await stat(path.join(f.directory, "manifest.json"));
    await syncBrowserExtensionDirectory({
      ...f.options,
      afterPublish: () => {
        throw new Error("unexpected write");
      },
    });
    expect((await stat(path.join(f.directory, "manifest.json"))).mtimeMs).toBe(before.mtimeMs);
    expect(f.logs).toEqual([]);
  });

  it.each(["b/two", "connect.html", "icons/probe.png"])(
    "recovers after interruption at %s",
    async (step) => {
      const f = await fixture();
      await f.bundle("one");
      await syncBrowserExtensionDirectory(f.options);
      await f.bundle("two");
      expect(
        await syncBrowserExtensionDirectory({
          ...f.options,
          afterPublish: (name) => {
            if (name === step) throw new Error("interrupted");
          },
        }),
      ).toBe(f.directory);
      expect(await f.current()).toBe("b/one/worker.js");
      expect(await readFile(path.join(f.directory, await f.current()), "utf8")).toBe("one");
      await syncBrowserExtensionDirectory(f.options);
      expect(await f.current()).toBe("b/two/worker.js");
    },
  );

  it.each(["../escape", "/absolute", "b/../escape"])("refuses unsafe entry %s", async (name) => {
    const f = await fixture();
    await writeFile(f.zipPath, zipSync({ [name]: strToU8("bad") }));
    expect(await syncBrowserExtensionDirectory(f.options)).toBeNull();
    expect(f.logs[0]).toContain("Unsafe");
    expect(await readdir(f.root)).toEqual(["extension.zip"]);
  });

  it.each(["symlink", "oversized"])("refuses a %s entry before writing", async (kind) => {
    const f = await fixture();
    const zip = Buffer.from(zipSync({ "worker.js": strToU8("bad") }));
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (kind === "symlink") zip.writeUInt32LE(0xa1ff0000, central + 38);
    else zip.writeUInt32LE(33 * 1024 * 1024, central + 24);
    await writeFile(f.zipPath, zip);
    expect(await syncBrowserExtensionDirectory(f.options)).toBeNull();
    expect(f.logs[0]).toContain(kind === "symlink" ? "Unsafe" : "too large");
    expect(await readdir(f.root)).toEqual(["extension.zip"]);
  });

  it("skips a flat archive without writing", async () => {
    const f = await fixture();
    await writeFile(
      f.zipPath,
      zipSync({
        "manifest.json": strToU8('{"background":{"service_worker":"worker.js"}}'),
        "worker.js": strToU8("old"),
      }),
    );
    expect(await syncBrowserExtensionDirectory(f.options)).toBeNull();
    expect(f.logs[0]).toContain("flat-layout");
    expect(await readdir(f.root)).toEqual(["extension.zip"]);
  });

  it("serializes concurrent installs", async () => {
    const f = await fixture();
    await f.bundle("one");
    expect(
      await Promise.all([
        syncBrowserExtensionDirectory(f.options),
        syncBrowserExtensionDirectory(f.options),
      ]),
    ).toEqual([f.directory, f.directory]);
    expect(await readdir(path.join(f.directory, "b"))).toEqual(["one"]);
  });
});
