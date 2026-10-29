import {
  chmod,
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
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NativeFsHelper } from "./native-fs-helper.js";

const temporaryDirectories: string[] = [];
const builtHelper = fileURLToPath(
  new URL(
    `../../native-fs-helper/opensteer-native-fs${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("NativeFsHelper", () => {
  it("preflights the pinned helper identity and exact platform containment", async () => {
    const root = await temporaryDirectory("preflight");
    const result = await new NativeFsHelper({ binary: builtHelper }).preflight(
      root,
      new AbortController().signal,
    );

    expect(result).toMatchObject({
      binaryIdentity: "opensteer-native-fs",
      binaryVersion: "1.6.0",
      containment:
        process.platform === "linux"
          ? "linux-openat2"
          : process.platform === "darwin"
            ? "posix-openat-nofollow"
            : "windows-nt-relative-noreparse",
      platform: process.platform === "win32" ? "windows" : process.platform,
    });
  });

  it("pins directory identities and creates managed directories through the native boundary", async () => {
    const parent = await realpath(await temporaryDirectory("directory-authority"));
    const root = join(parent, "managed", "workspaces");
    const helper = new NativeFsHelper({ binary: builtHelper, rootPolicy: "managed-local" });
    const signal = new AbortController().signal;

    const rootCreation = await helper.ensureRoot({ root }, signal);
    expect(rootCreation.created).toBe(true);
    await expect(helper.ensureRoot({ root }, signal)).resolves.toEqual({
      created: false,
      identity: rootCreation.identity,
    });

    const rootIdentity = await helper.directoryIdentity({ path: ".", root }, signal);
    expect(rootIdentity).toEqual(rootCreation.identity);
    expect(rootIdentity).toMatchObject({
      kind: process.platform === "win32" ? "windows" : "posix",
    });
    expect(rootIdentity.fileId).toMatch(/^(?:[0-9]+|[a-f0-9]{32})$/u);
    expect(rootIdentity.volumeId).toMatch(/^[0-9]+$/u);

    const created = await helper.ensureDirectory(
      { path: "owner/workspace", resume: false, root },
      signal,
    );
    await expect(
      helper.directoryIdentity({ path: "owner/workspace", root }, signal),
    ).resolves.toEqual(created);
    await expect(
      helper.ensureDirectory({ path: "owner/workspace", resume: false, root }, signal),
    ).rejects.toMatchObject({ code: "already-exists" });
    await expect(
      helper.ensureDirectory({ path: "owner/workspace", resume: true, root }, signal),
    ).resolves.toEqual(created);
  });

  it.skipIf(process.platform === "win32")(
    "rejects missing, relative, symlinked, and writable helper executables",
    async () => {
      const root = await temporaryDirectory("trust");
      expect(() => new NativeFsHelper({ binary: "relative-helper" })).toThrow("absolute");
      await expect(
        new NativeFsHelper({ binary: join(root, "missing") }).preflight(
          root,
          new AbortController().signal,
        ),
      ).rejects.toThrow("unavailable");

      const linked = join(root, "linked-helper");
      await symlink(builtHelper, linked);
      await expect(
        new NativeFsHelper({ binary: linked }).preflight(root, new AbortController().signal),
      ).rejects.toThrow("not trusted");

      const writable = await executable(root, "writable", "process.exit(0)");
      await chmod(writable, 0o777);
      await expect(
        new NativeFsHelper({ binary: writable }).preflight(root, new AbortController().signal),
      ).rejects.toThrow("not trusted");
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed on a same-device root that could be renamed outside its pathname boundary",
    async () => {
      const workspace = await temporaryDirectory("non-mount-root");
      const outside = await temporaryDirectory("non-mount-outside");
      const raced = join(workspace, "race");
      const moved = join(outside, "moved");
      await mkdir(raced);
      await writeFile(join(raced, "target.txt"), "safe");
      await rename(raced, moved);
      await mkdir(raced);
      await writeFile(join(raced, "target.txt"), "replacement");
      const helper = new NativeFsHelper({ binary: builtHelper });
      const signal = new AbortController().signal;
      const results = await Promise.allSettled([
        helper.read({ path: "race/target.txt", root: workspace }, signal),
        helper.list({ maxDepth: 2, maxEntries: 10, path: ".", root: workspace }, signal),
        helper.search(
          {
            caseSensitive: true,
            maxEntries: 10,
            maxResults: 10,
            path: ".",
            query: "safe",
            root: workspace,
          },
          signal,
        ),
        helper.write({ content: "unsafe", path: "race/new.txt", root: workspace }, signal),
        helper.replace(
          {
            newText: "unsafe",
            oldText: "replacement",
            path: "race/target.txt",
            replaceAll: false,
            root: workspace,
          },
          signal,
        ),
      ]);
      expect(results).toHaveLength(5);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") expect(String(result.reason)).toContain("mount boundary");
      }
      await expect(readFile(join(moved, "target.txt"), "utf8")).resolves.toBe("safe");
      await expect(readFile(join(raced, "target.txt"), "utf8")).resolves.toBe("replacement");
    },
  );

  it.skipIf(process.platform === "win32")(
    "supports an explicitly authorized managed local root without weakening traversal checks",
    async () => {
      const workspace = await temporaryDirectory("managed-local-root");
      const outside = await temporaryDirectory("managed-local-outside");
      await writeFile(join(workspace, "inside.txt"), "inside");
      await writeFile(join(outside, "outside.txt"), "outside");
      await symlink(outside, join(workspace, "escape"), "dir");
      const helper = new NativeFsHelper({
        binary: builtHelper,
        rootPolicy: "managed-local",
      });
      const signal = new AbortController().signal;

      await expect(
        helper.read({ path: "inside.txt", root: workspace }, signal),
      ).resolves.toMatchObject({
        content: Buffer.from("inside"),
        path: "inside.txt",
      });
      await expect(
        helper.read({ path: "escape/outside.txt", root: workspace }, signal),
      ).rejects.toThrow();
    },
  );

  it.skipIf(process.platform === "win32")("bounds stdout", async () => {
    const root = await temporaryDirectory("process-bounds");
    const oversized = await executable(
      root,
      "oversized",
      "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.alloc(2 * 1024 * 1024 + 1)));",
    );
    await expect(
      new NativeFsHelper({ binary: oversized }).list(
        { maxDepth: 1, maxEntries: 1, path: ".", root },
        new AbortController().signal,
      ),
    ).rejects.toThrow("response exceeds");
  });

  it.skipIf(process.platform === "win32")("suppresses helper stderr", async () => {
    const root = await temporaryDirectory("process-stderr");
    const noisy = await executable(
      root,
      "noisy",
      "process.stderr.write('provider-secret-must-not-reflect'); process.exit(1);",
    );
    const noisyError = await new NativeFsHelper({ binary: noisy })
      .list({ maxDepth: 1, maxEntries: 1, path: ".", root }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(String(noisyError)).toContain("exited unexpectedly");
    expect(String(noisyError)).not.toContain("provider-secret-must-not-reflect");
  });

  it.skipIf(process.platform === "win32")("enforces an absolute timeout", async () => {
    const root = await temporaryDirectory("process-timeout");
    const hanging = await executable(root, "hanging", "setTimeout(() => {}, 60_000);");
    const startedAt = Date.now();
    await expect(
      new NativeFsHelper({ binary: hanging, timeoutMilliseconds: 100 }).list(
        { maxDepth: 1, maxEntries: 1, path: ".", root },
        new AbortController().signal,
      ),
    ).rejects.toThrow("timed out");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it.skipIf(process.platform === "win32")(
    "kills on abort and rejects non-canonical read payloads",
    async () => {
      const root = await temporaryDirectory("abort");
      const hanging = await executable(root, "abort-hanging", "setTimeout(() => {}, 60_000);");
      const controller = new AbortController();
      const pending = new NativeFsHelper({ binary: hanging }).list(
        { maxDepth: 1, maxEntries: 1, path: ".", root },
        controller.signal,
      );
      controller.abort(new Error("test abort"));
      await expect(pending).rejects.toThrow("test abort");

      const malformed = await executable(
        root,
        "malformed-base64",
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({binaryIdentity:'opensteer-native-fs',binaryVersion:'1.6.0',containment:${JSON.stringify(
          process.platform === "linux" ? "linux-openat2" : "posix-openat-nofollow",
        )},ok:true,platform:${JSON.stringify(process.platform)},result:{contentBase64:'YQ',path:'a.txt',size:1}})));`,
      );
      await expect(
        new NativeFsHelper({ binary: malformed }).read(
          { path: "a.txt", root },
          new AbortController().signal,
        ),
      ).rejects.toThrow("invalid read result");
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills a streaming Files helper when the consumer cancels",
    async () => {
      const root = await temporaryDirectory("stream-abort");
      const pidFile = join(root, "child.pid");
      const streaming = await executable(
        root,
        "streaming",
        `const fs=require('node:fs'); process.stdin.resume(); process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(
          pidFile,
        )},String(process.pid)); const header={binaryIdentity:'opensteer-native-fs',binaryVersion:'1.6.0',containment:${JSON.stringify(
          process.platform === "linux" ? "linux-openat2" : "posix-openat-nofollow",
        )},ok:true,platform:${JSON.stringify(process.platform)},result:{length:1048576,metadata:{modifiedAt:null,mode:420,revision:'${"a".repeat(
          43,
        )}',sizeBytes:1048576},offset:0}}; process.stdout.write(JSON.stringify(header)+'\\n'); process.stdout.write(Buffer.alloc(1024)); setInterval(()=>process.stdout.write(Buffer.alloc(1024)),10);});`,
      );
      const helper = new NativeFsHelper({ binary: streaming, rootPolicy: "managed-local" });
      const download = await helper.filesDownload(
        {
          expectedRootIdentity: { fileId: "1", kind: "posix", volumeId: "1" },
          length: 0,
          offset: 0,
          pathSegmentsBase64: [Buffer.from("file").toString("base64url")],
          root,
        },
        new AbortController().signal,
      );
      const pid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      expect(pid).toBeGreaterThan(0);
      download.stream.destroy();
      await expect(waitForProcessExit(pid)).resolves.toBeUndefined();
    },
  );
});

async function temporaryDirectory(label: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `opensteer-native-fs-${label}-`));
  temporaryDirectories.push(path);
  return path;
}

async function executable(directory: string, name: string, body: string): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return path;
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Streaming helper did not exit after its consumer cancelled");
}
