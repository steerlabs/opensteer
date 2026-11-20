import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { appMaxBytes, createId } from "@opensteer/core";
import {
  RunnerConnectionFenceSchema,
  encodeHomeFileExportBundle,
  homeFilesMaxBytes,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { HomeFilesError, HomeFilesHandler, type HomeFilesTransferClient } from "./home-files.js";

const execFileAsync = promisify(execFile);
const helperBinary = fileURLToPath(
  new URL("../../native-fs-helper/opensteer-native-fs", import.meta.url),
);

const fence = RunnerConnectionFenceSchema.parse({
  bootId: `rbt_${randomUUID()}`,
  connectionGeneration: 1,
  connectionId: `rcn_${randomUUID()}`,
  connectionLeaseId: `rls_${randomUUID()}`,
  runnerId: createId("runner"),
});

function memoryTransfers(): {
  readonly client: HomeFilesTransferClient;
  readonly uploaded: Map<string, { readonly name: string; readonly bytes: Buffer }>;
  readonly downloads: Map<string, Buffer>;
} {
  const uploaded = new Map<string, { readonly name: string; readonly bytes: Buffer }>();
  const downloads = new Map<string, Buffer>();
  return {
    uploaded,
    downloads,
    client: {
      async upload(transfer, file, signal) {
        const chunks: Buffer[] = [];
        for await (const chunk of file.body) {
          signal.throwIfAborted();
          chunks.push(Buffer.from(chunk));
        }
        uploaded.set(transfer.id, { name: file.name, bytes: Buffer.concat(chunks) });
      },
      async download(transfer, maxBytes, signal) {
        signal.throwIfAborted();
        const bytes = downloads.get(transfer.id);
        if (!bytes) throw new HomeFilesError("unavailable", "Transfer missing");
        if (bytes.byteLength > maxBytes) throw new HomeFilesError("file_too_large", "Too large");
        return bytes;
      },
    },
  };
}

describe("HomeFilesHandler", () => {
  it("refuses replaced roots and enforces content and app HTML byte caps before upload", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runner-home-files-bounds-")));
    const home = join(root, "home");
    const html = join(home, "index.html");
    await mkdir(home);
    const transfers = memoryTransfers();
    const handler = new HomeFilesHandler({
      dataDirectory: root,
      helperBinary,
      transfers: transfers.client,
    });
    const signal = new AbortController().signal;
    try {
      await handler.initializeAgentHome(home, signal);
      await writeFile(html, "");
      const request = {
        ...fence,
        pathSegmentsBase64: [Buffer.from("index.html").toString("base64url")],
        requestId: randomUUID(),
        transfer: { id: randomUUID(), token: "t".repeat(43) },
        type: "host.home-files.download" as const,
      };
      await truncate(html, appMaxBytes + 1);
      await expect(
        handler.handle({ ...request, purpose: "app-html" }, signal),
      ).rejects.toMatchObject({ code: "file_too_large", sizeBytes: appMaxBytes + 1 });
      await truncate(html, homeFilesMaxBytes + 1);
      await expect(handler.handle(request, signal)).rejects.toMatchObject({
        code: "file_too_large",
        sizeBytes: homeFilesMaxBytes + 1,
      });
      expect(transfers.uploaded.size).toBe(0);
      await rename(home, join(root, "original"));
      await mkdir(home);
      await expect(
        handler.handle(
          {
            ...fence,
            limit: 5,
            offset: 0,
            pathSegmentsBase64: [],
            requestId: randomUUID(),
            type: "host.home-files.list",
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: "revision_mismatch" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("lists, reads, resolves, downloads and writes rooted files with no-follow guarantees", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runner-home-files-")));
    const homeDir = join(root, "user-home");
    const agentHome = join(homeDir, "Opensteer");
    const dataDirectory = join(root, "runner-data");
    await mkdir(agentHome, { recursive: true });
    await mkdir(join(dataDirectory, "images"), { recursive: true });
    const transfers = memoryTransfers();
    const handler = new HomeFilesHandler({
      agentHomePath: agentHome,
      dataDirectory,
      helperBinary,
      homeDirectory: homeDir,
      transfers: transfers.client,
    });
    const signal = AbortSignal.timeout(15_000);
    try {
      await writeFile(join(agentHome, "note.txt"), "hello world");
      const listed = await handler.handle(
        {
          ...fence,
          limit: 50,
          offset: 0,
          pathSegmentsBase64: [],
          requestId: randomUUID(),
          type: "host.home-files.list",
        },
        signal,
      );
      expect(listed.kind).toBe("list");
      if (listed.kind !== "list") throw new Error("expected list");
      expect(listed.listing.entries).toMatchObject([{ displayName: "note.txt", kind: "file" }]);

      // Resolve absolute, relative, tilde (using Runner's homeDir), and file:// URL.
      const resolvedAbs = await handler.handle(
        {
          ...fence,
          path: join(agentHome, "note.txt"),
          requestId: randomUUID(),
          type: "host.home-files.resolve",
        },
        signal,
      );
      if (resolvedAbs.kind !== "resolve") throw new Error("expected resolve");
      expect(resolvedAbs.name).toBe("note.txt");
      expect(resolvedAbs.metadata.sizeBytes).toBe(11);

      for (const candidate of [
        "note.txt",
        "./note.txt",
        "~/Opensteer/note.txt",
        pathToFileURL(join(agentHome, "note.txt")).href,
      ]) {
        const resolved = await handler.handle(
          {
            ...fence,
            allowRelative: true,
            allowTilde: true,
            path: candidate,
            requestId: randomUUID(),
            type: "host.home-files.resolve",
          },
          signal,
        );
        expect(resolved).toMatchObject({
          key: resolvedAbs.key,
          kind: "resolve",
          name: "note.txt",
          rootScope: resolvedAbs.rootScope,
        });
      }

      // Strict resolve rejects relative and tilde paths.
      await expect(
        handler.handle(
          {
            ...fence,
            path: "~/Opensteer/note.txt",
            requestId: randomUUID(),
            type: "host.home-files.resolve",
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: "not_found" });

      // Inline read with revision check.
      const read = await handler.handle(
        {
          ...fence,
          expectedFileRevision: resolvedAbs.metadata.revision,
          expectedRootScope: resolvedAbs.rootScope,
          maxBytes: 5,
          offset: 0,
          pathSegmentsBase64: [Buffer.from("note.txt").toString("base64url")],
          requestId: randomUUID(),
          type: "host.home-files.read",
        },
        signal,
      );
      if (read.kind !== "read") throw new Error("expected read");
      expect(Buffer.from(read.contentBase64, "base64").toString("utf8")).toBe("hello");
      expect(read.eof).toBe(false);

      // Download via transfer.
      const downloadTransfer = { id: randomUUID(), token: "t".repeat(43) };
      const downloaded = await handler.handle(
        {
          ...fence,
          expectedFileRevision: resolvedAbs.metadata.revision,
          expectedRootScope: resolvedAbs.rootScope,
          maxBytes: 1024,
          pathSegmentsBase64: [Buffer.from("note.txt").toString("base64url")],
          requestId: randomUUID(),
          transfer: downloadTransfer,
          type: "host.home-files.download",
        },
        signal,
      );
      expect(downloaded).toMatchObject({ kind: "download", length: 11 });
      expect(transfers.uploaded.get(downloadTransfer.id)?.bytes.toString("utf8")).toBe(
        "hello world",
      );

      // Oversize download reports file_too_large with exact sizeBytes.
      await expect(
        handler.handle(
          {
            ...fence,
            maxBytes: 4,
            pathSegmentsBase64: [Buffer.from("note.txt").toString("base64url")],
            requestId: randomUUID(),
            transfer: { id: randomUUID(), token: "t".repeat(43) },
            type: "host.home-files.download",
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: "file_too_large", sizeBytes: 11 });

      // Export write via transfer creates directories and files; refuses overwriting existing folder.
      const bundleTransfer = { id: randomUUID(), token: "w".repeat(43) };
      const bundle = encodeHomeFileExportBundle({
        directory: "exported-plugin",
        files: [
          { bytes: Buffer.from("export const ok = true;\n"), path: "index.ts" },
          { bytes: Buffer.from([1, 2, 3]), path: "nested/data.bin" },
        ],
      });
      transfers.downloads.set(bundleTransfer.id, Buffer.from(bundle));
      const written = await handler.handle(
        {
          ...fence,
          directory: "exported-plugin",
          maxBytes: 24 * 1_024 * 1_024,
          requestId: randomUUID(),
          transfer: bundleTransfer,
          type: "host.home-files.write",
        },
        signal,
      );
      expect(written).toMatchObject({ filesWritten: 2, kind: "write" });
      expect(await readFile(join(agentHome, "exported-plugin/index.ts"), "utf8")).toBe(
        "export const ok = true;\n",
      );
      expect([...(await readFile(join(agentHome, "exported-plugin/nested/data.bin")))]).toEqual([
        1, 2, 3,
      ]);

      await expect(
        handler.handle(
          {
            ...fence,
            directory: "exported-plugin",
            maxBytes: 24 * 1_024 * 1_024,
            requestId: randomUUID(),
            transfer: bundleTransfer,
            type: "host.home-files.write",
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("refuses symlinks, FIFOs, outside-root paths, root replacement and invalid output-image names", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "runner-home-files-sec-")));
    const agentHome = join(root, "home");
    const outside = join(root, "outside");
    const dataDirectory = join(root, "runner-data");
    await mkdir(agentHome, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(join(dataDirectory, "images"), { recursive: true });
    const handler = new HomeFilesHandler({
      agentHomePath: agentHome,
      dataDirectory,
      helperBinary,
    });
    const signal = AbortSignal.timeout(15_000);
    try {
      await writeFile(join(agentHome, "inside.txt"), "before");
      await writeFile(join(outside, "secret.txt"), "nope");
      await symlink(join(agentHome, "inside.txt"), join(agentHome, "link.txt"));
      await execFileAsync("mkfifo", [join(agentHome, "pipe")]);

      for (const badPath of [
        join(outside, "secret.txt"),
        `${agentHome}/../outside/secret.txt`,
        join(agentHome, "link.txt"),
        join(agentHome, "pipe"),
        "//server/share/file",
      ]) {
        await expect(
          handler.handle(
            {
              ...fence,
              path: badPath,
              requestId: randomUUID(),
              type: "host.home-files.resolve",
            },
            signal,
          ),
        ).rejects.toBeInstanceOf(HomeFilesError);
      }

      const initial = await handler.handle(
        {
          ...fence,
          path: join(agentHome, "inside.txt"),
          requestId: randomUUID(),
          type: "host.home-files.resolve",
        },
        signal,
      );
      if (initial.kind !== "resolve") throw new Error("expected resolve");

      // Replace root directory -> expectedRootScope fails.
      await rename(agentHome, join(root, "old-home"));
      await mkdir(agentHome);
      await writeFile(join(agentHome, "inside.txt"), "before");
      await expect(
        handler.handle(
          {
            ...fence,
            expectedFileRevision: initial.metadata.revision,
            expectedRootScope: initial.rootScope,
            maxBytes: 10,
            offset: 0,
            pathSegmentsBase64: [Buffer.from("inside.txt").toString("base64url")],
            requestId: randomUUID(),
            type: "host.home-files.read",
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: "revision_mismatch" });

      // Output-images root accepts exact <sha256>.<ext> and rejects arbitrary paths.
      const imgBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
      const imgName = `${createHash("sha256").update(imgBytes).digest("hex")}.png`;
      await writeFile(join(dataDirectory, "images", imgName), imgBytes);
      const readImage = await handler.handle(
        {
          ...fence,
          maxBytes: 64,
          offset: 0,
          pathSegmentsBase64: [Buffer.from(imgName).toString("base64url")],
          requestId: randomUUID(),
          root: "output-images",
          type: "host.home-files.read",
        },
        signal,
      );
      expect(readImage).toMatchObject({ bytesRead: imgBytes.length, kind: "read" });

      await expect(
        handler.handle(
          {
            ...fence,
            maxBytes: 64,
            offset: 0,
            pathSegmentsBase64: [Buffer.from("not-a-hash.png").toString("base64url")],
            requestId: randomUUID(),
            root: "output-images",
            type: "host.home-files.read",
          },
          signal,
        ),
      ).rejects.toMatchObject({ code: "bad_request" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
