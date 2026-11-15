import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { mkdtemp, realpath, rm, writeFile, mkdir, symlink, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { AgentHomeFiles } from "./agent-home-files.js";

it("lists, previews and downloads Agent home through the real native helper", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "host-agent-home-files-")));
  const files = new AgentHomeFiles({
    agentHome: async () => ({ computerId: createId("runner"), path }),
    helperPath: fileURLToPath(
      new URL("../../../runner/native-fs-helper/opensteer-native-fs", import.meta.url),
    ),
  });
  try {
    await writeFile(join(path, "note.txt"), "Folder content");
    const page = await files.list({ parentKey: "", limit: 20 });
    expect(page.entries).toMatchObject([{ name: "note.txt", kind: "file" }]);
    const key = page.entries[0]!.key;
    expect((await files.preview(key)).bytes.toString()).toBe("Folder content");
    expect(await (await files.download(key)).text()).toBe("Folder content");
  } finally {
    files.close();
    await rm(path, { recursive: true, force: true });
  }
});

it("confines absolute paths and refuses symlinks and non-regular nodes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "host-home-authority-")));
  const home = join(root, "home");
  await mkdir(home);
  const files = makeFiles(home);
  try {
    await writeFile(join(home, "inside.txt"), "inside");
    const f = await files.resolveAbsolutePath(join(home, "inside.txt"));
    expect(
      (await files.read(f.key, { maxBytes: 3, expectedRevision: f.revision })).bytes.toString(),
    ).toBe("ins");
    expect(
      (
        await files.readContent(f.key, { maxBytes: 6, expectedRevision: f.revision })
      ).bytes.toString(),
    ).toBe("inside");
    await mkdir(join(root, "home-sibling"));
    await writeFile(join(root, "home-sibling/secret"), "outside");
    await mkdir(join(home, "dir"));
    await writeFile(join(home, "dir/note"), "nested");
    await symlink(join(home, "inside.txt"), join(home, "final"));
    await symlink(join(home, "dir"), join(home, "intermediate"));
    await execFileAsync("mkfifo", [join(home, "pipe")]);
    for (const p of [
      join(root, "home-sibling/secret"),
      `${home}/../home-sibling/secret`,
      `${home}/dir/../inside.txt`,
      `${home}/final`,
      `${home}/intermediate/note`,
      `${home}/pipe`,
      `${home}/dir`,
      `${home}/missing`,
      `${home}/bad\0name`,
      "//server/file",
      "/\\server/file",
    ])
      await expect(files.resolveAbsolutePath(p)).rejects.toThrow();
    for (const key of [
      Buffer.from("../inside.txt").toString("base64url"),
      Buffer.from("dir\0..\0inside.txt").toString("base64url"),
    ])
      await expect(files.read(key, { maxBytes: 10 })).rejects.toThrow();
  } finally {
    files.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("binds both root and file identity across replacement and in-place edits", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "host-home-revisions-")));
  const home = join(root, "home");
  await mkdir(home);
  const files = makeFiles(home);
  try {
    const p = join(home, "file");
    await writeFile(p, "before");
    const f = await files.resolveAbsolutePath(p);
    await rename(p, join(home, "old"));
    await writeFile(p, "before");
    await expect(
      files.read(f.key, { maxBytes: 10, expectedRevision: f.revision }),
    ).rejects.toThrow();
    const replaced = await files.resolveAbsolutePath(p);
    await writeFile(p, "after!");
    await expect(
      files.readContent(replaced.key, { maxBytes: 10, expectedRevision: replaced.revision }),
    ).rejects.toThrow();
    const current = await files.resolveAbsolutePath(p);
    await rename(home, join(root, "old-home"));
    await mkdir(home);
    await writeFile(p, "after!");
    await expect(
      files.readContent(current.key, { maxBytes: 10, expectedRevision: current.revision }),
    ).rejects.toThrow();
  } finally {
    files.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("enforces preview and content caps and propagates cancellation", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-home-caps-")));
  const files = makeFiles(home);
  try {
    const p = join(home, "large");
    await writeFile(p, Buffer.alloc(512 * 1024 + 1, 97));
    const f = await files.resolveAbsolutePath(p);
    const preview = await files.read(f.key, { maxBytes: 512 * 1024, expectedRevision: f.revision });
    expect(preview.bytes.length).toBe(512 * 1024);
    expect(preview.eof).toBe(false);
    await expect(
      files.readContent(f.key, { maxBytes: 100, expectedRevision: f.revision }),
    ).rejects.toMatchObject({
      reason: "file-too-large",
      details: { sizeBytes: 512 * 1024 + 1, maxBytes: 100 },
    });
    const abort = new AbortController();
    abort.abort(new Error("test canceled"));
    await expect(files.read(f.key, { maxBytes: 1 }, abort.signal)).rejects.toThrow("test canceled");
    await expect(
      files.readContent(f.key, { maxBytes: 1, expectedRevision: f.revision }, abort.signal),
    ).rejects.toThrow("test canceled");
    files.close();
    await expect(files.read(f.key, { maxBytes: 1 })).rejects.toThrow();
  } finally {
    files.close();
    await rm(home, { recursive: true, force: true });
  }
});
function makeFiles(path: string) {
  return new AgentHomeFiles({
    agentHome: async () => ({ computerId: createId("runner"), path }),
    helperPath: fileURLToPath(
      new URL("../../../runner/native-fs-helper/opensteer-native-fs", import.meta.url),
    ),
  });
}
