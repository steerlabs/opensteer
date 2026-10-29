import { beforeEach, describe, expect, it, vi } from "vitest";
import * as draftFiles from "./attachment-draft-files.js";
import type { HostClient } from "@opensteer/client/host";

const disk = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  copyFailure: null as null | "before" | "partial",
  ordinal: 0,
  writeGate: null as Promise<void> | null,
  sharedBytes: [] as (Uint8Array | undefined)[],
}));

vi.mock("expo-crypto", () => ({
  randomUUID: () => `00000000-0000-4000-8000-${String(++disk.ordinal).padStart(12, "0")}`,
}));
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = parts.map((part) => (part instanceof Directory ? part.uri : part)).join("/");
    }
    create(): void {}
  }
  class File {
    readonly uri: string;
    constructor(directory: string | Directory, name?: string) {
      this.uri =
        name === undefined
          ? String(directory)
          : `${directory instanceof Directory ? directory.uri : directory}/${name}`;
    }
    get exists(): boolean {
      return disk.files.has(this.uri);
    }
    get size(): number {
      return disk.files.get(this.uri)?.byteLength ?? 0;
    }
    get md5(): string | null {
      const bytes = disk.files.get(this.uri);
      return bytes ? [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("") : null;
    }
    get name(): string {
      return this.uri.split("/").at(-1) ?? "";
    }
    get type(): string {
      return "text/plain";
    }
    async copy(destination: File): Promise<void> {
      const bytes = disk.files.get(this.uri);
      if (!bytes) throw new Error("Source disappeared");
      const failure = disk.copyFailure;
      disk.copyFailure = null;
      if (failure === "before") throw new Error("Copy failed before writing");
      disk.files.set(destination.uri, failure === "partial" ? bytes.slice(0, 2) : bytes.slice());
      if (failure === "partial") throw new Error("Copy failed after partial write");
    }
    delete(): void {
      disk.files.delete(this.uri);
    }
    async write(bytes: Uint8Array): Promise<void> {
      await disk.writeGate;
      disk.files.set(this.uri, bytes);
    }
    open() {
      const bytes = disk.files.get(this.uri) ?? new Uint8Array();
      let offset = 0;
      let closed = false;
      return {
        close: () => {
          closed = true;
        },
        readBytes: async (length: number) => {
          await Promise.resolve();
          if (closed) throw new Error("The file was closed before reading finished");
          const chunk = bytes.slice(offset, offset + length);
          offset += chunk.byteLength;
          return chunk;
        },
      };
    }
    static async pickFileAsync() {
      return { canceled: false, result: new File("file:///picker/source.txt") };
    }
  }
  return { Directory, File, Paths: { document: "file:///documents", cache: "file:///cache" } };
});
vi.mock("expo-image-picker", () => ({
  UIImagePickerPreferredAssetRepresentationMode: { Compatible: "compatible" },
  launchImageLibraryAsync: async () => ({ canceled: true, assets: [] }),
}));
vi.mock("expo-sharing", () => ({
  shareAsync: async (uri: string) => {
    disk.sharedBytes.push(disk.files.get(uri));
  },
}));

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const otherDeploymentId = "dep_0192f4a1-9999-4000-8000-000000000009";
const userId = "usr_0192f4a1-aaaa-4000-8000-00000000000a";
const otherUserId = "usr_0192f4a1-bbbb-4000-8000-00000000000b";
const threadId = "thr_0192f4a1-2222-4000-8000-000000000002";
const otherThreadId = "thr_0192f4a1-3333-4000-8000-000000000003";
const intro = { kind: "home-intro" as const, deploymentId, userId };
const target = { deploymentId, userId, threadId };
const sourceBytes = new Uint8Array([11, 22, 33, 44, 55]);

beforeEach(() => {
  disk.files.clear();
  disk.copyFailure = null;
  disk.ordinal = 0;
  disk.writeGate = null;
  disk.sharedBytes = [];
  disk.files.set("file:///picker/source.txt", sourceBytes);
});

describe("sharing a Host attachment", () => {
  const client = {
    readAttachment: async () => new Blob([sourceBytes], { type: "text/plain" }),
  } as unknown as HostClient;

  it("finishes writing before sharing and removes the temporary file afterwards", async () => {
    let release!: () => void;
    disk.writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sharing = draftFiles.shareChatAttachment(client, "attachment", "file.txt");
    await vi.waitFor(() => expect(disk.ordinal).toBe(1));
    expect(disk.sharedBytes).toEqual([]);
    release();
    await sharing;
    expect(disk.sharedBytes).toEqual([sourceBytes]);
    expect([...disk.files.keys()]).toEqual(["file:///picker/source.txt"]);
  });

  it("propagates a failed write without opening the share sheet", async () => {
    disk.writeGate = Promise.reject(new Error("disk full"));
    await expect(draftFiles.shareChatAttachment(client, "attachment", "file.txt")).rejects.toThrow(
      "disk full",
    );
    expect(disk.sharedBytes).toEqual([]);
    expect([...disk.files.keys()]).toEqual(["file:///picker/source.txt"]);
  });
});

describe("Home-intro attachment drafts", () => {
  it("copies a picked file under an explicit local intro scope while rejecting malformed Threads", async () => {
    const picked = await draftFiles.pickChatFile(intro);
    expect(picked?.localUri).toContain("/home-intro/");
    expect(draftFiles.openChatDraftFile(intro, picked!.localUri).size).toBe(sourceBytes.length);
    expect(() =>
      draftFiles.openChatDraftFile(
        { deploymentId, userId, threadId: "not-a-thread" },
        picked!.localUri,
      ),
    ).toThrow();
  });

  it("copies into the real Home Thread idempotently and keeps intro ownership until explicit cleanup", async () => {
    const picked = await draftFiles.pickChatFile(intro);
    const localUri = picked!.localUri;
    const copied = await draftFiles.copyFirstMessageDraftFileToThread(intro, target, localUri);
    expect(copied).toContain(`/${threadId}/`);
    expect(draftFiles.openChatDraftFile(target, copied).size).toBe(sourceBytes.length);
    expect(await draftFiles.copyFirstMessageDraftFileToThread(intro, target, localUri)).toBe(
      copied,
    );
    expect(draftFiles.openChatDraftFile(intro, localUri).size).toBe(sourceBytes.length);
    expect(() => draftFiles.openChatDraftFile(intro, copied)).toThrow();
    expect(() => draftFiles.openChatDraftFile(target, localUri)).toThrow();

    draftFiles.removeChatDraftFile(intro, localUri);
    expect(() => draftFiles.openChatDraftFile(intro, localUri)).toThrow();
    expect(draftFiles.openChatDraftFile(target, copied).size).toBe(sourceBytes.length);
  });

  it("rejects cross-deployment, cross-account and cross-Thread reads and transfers", async () => {
    const picked = await draftFiles.pickChatFile(intro);
    const localUri = picked!.localUri;
    expect(() =>
      draftFiles.openChatDraftFile({ ...intro, deploymentId: otherDeploymentId }, localUri),
    ).toThrow();
    expect(() =>
      draftFiles.openChatDraftFile({ ...intro, userId: otherUserId }, localUri),
    ).toThrow();
    await expect(
      draftFiles.copyFirstMessageDraftFileToThread(
        intro,
        { ...target, userId: otherUserId },
        localUri,
      ),
    ).rejects.toThrow();
    const copied = await draftFiles.copyFirstMessageDraftFileToThread(intro, target, localUri);
    expect(() =>
      draftFiles.openChatDraftFile({ ...target, threadId: otherThreadId }, copied),
    ).toThrow();
  });

  it.each(["before", "partial"] as const)(
    "retains the intro source after a %s-copy failure and returns one stable destination on retry",
    async (failure) => {
      const picked = await draftFiles.pickChatFile(intro);
      const localUri = picked!.localUri;
      disk.copyFailure = failure;
      await expect(
        draftFiles.copyFirstMessageDraftFileToThread(intro, target, localUri),
      ).rejects.toThrow();
      expect(draftFiles.openChatDraftFile(intro, localUri).size).toBe(sourceBytes.length);
      const copied = await draftFiles.copyFirstMessageDraftFileToThread(intro, target, localUri);
      expect(draftFiles.openChatDraftFile(target, copied).size).toBe(sourceBytes.length);
      expect(await draftFiles.copyFirstMessageDraftFileToThread(intro, target, localUri)).toBe(
        copied,
      );
    },
  );
});
