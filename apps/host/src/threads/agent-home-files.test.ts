import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { RunFileRelay } from "../agents/run-file-relay.js";
import { AgentHomeFiles } from "./agent-home-files.js";
import { createInProcessHomeFilesTransport } from "./home-files.test-support.js";

it("lists, previews and downloads Agent home through the hosting Runner", async () => {
  const path = await realpath(await mkdtemp(join(tmpdir(), "host-agent-home-files-")));
  const files = makeFiles(path);
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

it("fails clearly when the hosting Runner is offline, lacks capability, or cancels a transfer", async () => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "host-home-proxy-errors-")));
  const runnerId = createId("runner");
  let online = false;
  let supported = true;
  const { transport } = createInProcessHomeFilesTransport({
    agentHomePath: home,
    online: () => online,
    runnerId,
    supported: () => supported,
  });
  const files = new AgentHomeFiles({
    agentHome: async () => ({ computerId: runnerId, path: home }),
    transport,
  });
  try {
    await writeFile(join(home, "hello.txt"), "hello");
    await expect(files.list({ parentKey: "", limit: 10 })).rejects.toMatchObject({
      code: "runner_offline",
    });

    online = true;
    supported = false;
    await expect(files.list({ parentKey: "", limit: 10 })).rejects.toMatchObject({
      code: "conflict",
      reason: "unsupported-runner",
    });

    supported = true;
    await files.writeDirectory({
      directory: "exported-draft",
      files: [{ bytes: Buffer.from("export const a = 1;"), path: "index.ts" }],
    });
    expect(await readFile(join(home, "exported-draft/index.ts"), "utf8")).toBe(
      "export const a = 1;",
    );
    await expect(
      files.writeDirectory({
        directory: "exported-draft",
        files: [{ bytes: Buffer.from("export const a = 2;"), path: "index.ts" }],
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    // Cancelled in-flight transfer rejects cleanly without hanging.
    const relay = new RunFileRelay();
    const started = Promise.withResolvers<void>();
    const stalledFiles = new AgentHomeFiles({
      agentHome: async () => ({ computerId: runnerId, path: home }),
      transport: {
        relay,
        requestHomeFile: (_runnerId, _request, signal) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            if (signal.aborted) {
              reject(signal.reason ?? new Error("transfer aborted"));
              return;
            }
            signal.addEventListener(
              "abort",
              () => reject(signal.reason ?? new Error("transfer aborted")),
              { once: true },
            );
          }),
      },
    });
    const controller = new AbortController();
    const pending = stalledFiles.download(
      Buffer.from("hello.txt").toString("base64url"),
      controller.signal,
    );
    await started.promise;
    controller.abort(new Error("user cancelled"));
    await expect(pending).rejects.toThrow("user cancelled");
    stalledFiles.close();
  } finally {
    files.close();
    await rm(home, { recursive: true, force: true });
  }
});

function makeFiles(path: string) {
  const runnerId = createId("runner");
  const { transport } = createInProcessHomeFilesTransport({
    agentHomePath: path,
    runnerId,
  });
  return new AgentHomeFiles({
    agentHome: async () => ({ computerId: runnerId, path }),
    transport,
  });
}
