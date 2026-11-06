import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runFileMaxBytes } from "@opensteer/protocol";
import { RunFiles } from "./run-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runner-run-files-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const files = new RunFiles({
    dataDirectory: join(root, "private"),
    helperBinary: fileURLToPath(
      new URL("../../native-fs-helper/opensteer-native-fs", import.meta.url),
    ),
    transport: { mode: "development", hostOrigin: new URL("http://localhost") },
  });
  const controller = new AbortController();
  return {
    root,
    workspace,
    files,
    controller,
    access: {
      roots: [workspace, join(root, "private")],
      directory: join(root, "attachments"),
      signal: controller.signal,
    },
  };
}
it("copies from a descriptor confined to the current Workspace", async () => {
  const { workspace, root, files, access } = await fixture();
  await writeFile(join(workspace, "ok"), "inside");
  await writeFile(join(root, "outside"), "secret");
  await symlink(join(root, "outside"), join(workspace, "link"));
  await symlink(root, join(workspace, "parent"));
  await mkdir(join(workspace, "directory"));
  await mkdir(join(root, "private"));
  await writeFile(join(root, "private", "key"), "secret");
  for (const path of [
    "link",
    "parent/outside",
    "../outside",
    join(root, "outside"),
    "directory",
    join(root, "private", "key"),
  ])
    await expect(files.source(path, access)).rejects.toThrow();
  const source = await files.source("ok", access);
  const path = await files.install(source, access.directory, access.signal);
  expect(await readFile(path, "utf8")).toBe("inside");
  expect((await stat(path)).mode & 0o777).toBe(0o444);
  expect(await readdir(join(path, ".."))).toEqual(["ok"]);
});
it("publishes only complete, bounded bytes and removes partial copies", async () => {
  const { files, access } = await fixture();
  for (const size of [2, 5, runFileMaxBytes + 1]) {
    await expect(
      files.install(
        { name: "bad", size, body: Readable.from([Buffer.from("data")]) },
        access.directory,
        access.signal,
      ),
    ).rejects.toThrow();
  }
  expect(await readdir(access.directory)).toEqual([]);
});
it("cancel prevents publication and scratch is removed on failure", async () => {
  const { files, controller, access } = await fixture();
  await expect(
    files.scratch(async (directory) => {
      await writeFile(join(directory, "sensitive"), "bytes");
      throw new Error("helper failed");
    }),
  ).rejects.toThrow("helper failed");
  expect(await readdir(files.scratchRoot)).toEqual([]);
  async function* body() {
    yield Buffer.from("a");
    controller.abort();
    yield Buffer.from("b");
  }
  await expect(
    files.install({ name: "file", size: 2, body: body() }, access.directory, access.signal),
  ).rejects.toThrow();
  expect(await readdir(access.directory)).toEqual([]);
});

it("keeps exports unpublished until fsync and the full declared size arrive", async () => {
  const { files, access } = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  async function* body() {
    yield Buffer.from("a");
    entered();
    await waiting;
    yield Buffer.from("b");
  }
  const publishing = files.install(
    { name: "photo", size: 2, body: body() },
    access.directory,
    access.signal,
  );
  try {
    await started;
    const [folder] = await readdir(access.directory);
    expect(await readdir(join(access.directory, folder!))).toEqual([".partial"]);
  } finally {
    release();
  }
  expect(await readFile(await publishing, "utf8")).toBe("ab");
});

it("stages same-Runner sends and exports through private scratch and removes it afterward", async () => {
  const { files: base, workspace, access } = await fixture();
  const files = new RunFiles({
    ...base.options,
    port: { withRunFiles: async (_execution, _signal, work) => await work(access) },
  });
  const invocation = {
    access: "read-write" as const,
    effect: "write" as const,
    contract: "contract",
    deadline: Date.now() + 30_000,
  };
  const message = {
    arguments: { files: ["input.txt"] },
    files: { run: { runId: "run", bindingGeneration: 1 } },
  } as unknown as import("@opensteer/protocol").HostIntegrationsInvoke;
  await writeFile(join(workspace, "input.txt"), "send bytes");
  expect(
    await files.invoke(message, "send", invocation, access.signal, async (args, _signal, call) => {
      const names = args.files as string[];
      expect(names).toHaveLength(1);
      expect(names[0]).not.toContain("/");
      expect(await readFile(join(call.scratchDirectory!, names[0]!), "utf8")).toBe("send bytes");
      return { accepted: true };
    }),
  ).toEqual({ accepted: true });
  expect(await readdir(files.scratchRoot)).toEqual([]);
  const result = await files.invoke(
    message,
    "export",
    invocation,
    access.signal,
    async (_args, _signal, call) => {
      await writeFile(join(call.scratchDirectory!, "export"), "photo");
      return { file: "export", name: "photo.jpg", mediaType: "image/jpeg", sizeBytes: 5 };
    },
  );
  const output = result as { path: string };
  expect(output.path).toContain(join(access.directory, "exports"));
  expect(await readFile(output.path, "utf8")).toBe("photo");
  expect(await readdir(files.scratchRoot)).toEqual([]);
});

it("removes stale helper scratch at integration startup", async () => {
  const { files } = await fixture();
  await mkdir(join(files.scratchRoot, "old"), { recursive: true });
  await writeFile(join(files.scratchRoot, "old", "photo"), "bytes");
  const { prepareIntegrationsModule } = await import("../computer-apps/prepare.js");
  const prepared = prepareIntegrationsModule({
    dataDirectory: files.options.dataDirectory,
    platform: "linux",
  });
  prepared?.close?.();
  await expect(stat(files.scratchRoot)).rejects.toMatchObject({ code: "ENOENT" });
});
