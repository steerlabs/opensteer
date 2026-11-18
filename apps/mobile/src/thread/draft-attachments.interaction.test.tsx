// @vitest-environment happy-dom
import { HostTransportError } from "@opensteer/client/connections";
import { stageAttachment, type HostClient } from "@opensteer/client/host";
import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { attachmentMessageMaxCount } from "@opensteer/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createThreadDraftStore } from "../client/thread-drafts.js";
import { discardPastedImage, importPastedImage } from "../platform/attachment-draft-files.js";
import { useDraftAttachments, type DraftAttachments } from "./draft-attachments.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error && error.message ? error.message : fallback,
}));
vi.mock("@opensteer/client/host", () => ({
  HostClientRequestError: class extends Error {},
  // Uploads stay in flight: this case is about what reaches the strip.
  stageAttachment: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("../platform/attachment-draft-files.js", () => ({
  discardPastedImage: vi.fn(),
  importPastedImage: vi.fn(async (_scope: unknown, image: { uri: string; name: string }) => {
    if (image.name === "unreadable.png")
      throw new Error("Choose an available file smaller than 25 MB.");
    return {
      file: {},
      localUri: `${image.uri}.draft`,
      mediaType: "image/png",
      name: image.name,
      sizeBytes: 1_024,
    };
  }),
  openChatDraftFile: vi.fn(),
  pickChatFile: vi.fn(async () => null),
  pickChatPhoto: vi.fn(async () => null),
  removeChatDraftFile: vi.fn(),
}));

const deploymentId = "dep_0192f4a1-1111-4000-8000-000000000001";
const userId = "usr_0192f4a1-aaaa-4000-8000-00000000000a";
const threadId = "thr_0192f4a1-2222-4000-8000-000000000002";
const readyConnection = {
  getSnapshot: () => ({ phase: "ready", readyRevision: 1 }),
  subscribe: () => () => undefined,
  retry: () => undefined,
};

it("pasted images join the strip like picked photos, up to the message's file limit", async () => {
  const drafts = createThreadDraftStore({
    filePath: "/private/drafts.json",
    now: () => new Date("2026-11-14T12:00:00.000Z"),
    privateFiles: new MemoryPrivateFilesystem(),
  });
  await drafts.load();
  const client = { connection: readyConnection } as unknown as HostClient;
  let staged: DraftAttachments | null = null;
  function Harness() {
    staged = useDraftAttachments({
      client,
      draftKey: threadId,
      drafts,
      files: { deploymentId, threadId, userId },
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  const image = (index: number) => ({
    uri: `file:///tmp/pasted-images/${index}.png`,
    mediaType: "image/png",
    name: index === 1 ? "unreadable.png" : `Pasted image ${index}.png`,
  });

  const pasted = Array.from({ length: attachmentMessageMaxCount + 3 }, (_, index) => image(index));
  await act(async () => staged!.paste({ images: pasted, failed: 0, tooLarge: 0 }));

  expect(staged!.items.map((item) => item.name)).toEqual(
    pasted
      .slice(0, attachmentMessageMaxCount + 1)
      .map(({ name }) => name)
      .filter((name) => name !== "unreadable.png"),
  );
  expect(staged!.items.every((item) => item.status === "uploading")).toBe(true);
  expect(staged!.notice).toBe(`A message holds at most ${attachmentMessageMaxCount} files.`);
  // What the message cannot hold is not left behind in temporary storage.
  expect(vi.mocked(importPastedImage)).toHaveBeenCalledTimes(attachmentMessageMaxCount + 1);
  expect(vi.mocked(discardPastedImage).mock.calls.map(([uri]) => uri)).toEqual(
    pasted.slice(attachmentMessageMaxCount + 1).map(({ uri }) => uri),
  );
  await act(async () => root.unmount());
});

function fakeConnection() {
  let state = { phase: "ready", readyRevision: 1 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    retry: () => undefined,
    set(next: Partial<typeof state>) {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

async function mountStrip(connection: ReturnType<typeof fakeConnection>) {
  const drafts = createThreadDraftStore({
    filePath: "/private/drafts.json",
    now: () => new Date("2026-11-14T12:00:00.000Z"),
    privateFiles: new MemoryPrivateFilesystem(),
  });
  await drafts.load();
  const client = { connection } as unknown as HostClient;
  const strip: { current: DraftAttachments | null } = { current: null };
  function Harness() {
    strip.current = useDraftAttachments({
      client,
      draftKey: threadId,
      drafts,
      files: { deploymentId, threadId, userId },
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<Harness />));
  return { root, strip };
}

function controlledUploads() {
  const uploads: { reject(error: unknown): void; resolve(value: unknown): void }[] = [];
  vi.mocked(stageAttachment).mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        uploads.push({ reject, resolve: resolve as (value: unknown) => void });
      }) as ReturnType<typeof stageAttachment>,
  );
  return uploads;
}

const uploaded = {
  id: "att_0192f4a1-3333-4000-8000-000000000003",
  mediaType: "image/png",
  name: "photo.png",
  sizeBytes: 1_024,
};
const photo = {
  images: [
    { uri: "file:///tmp/pasted-images/photo.png", mediaType: "image/png", name: "photo.png" },
  ],
  failed: 0,
  tooLarge: 0,
};

it("an upload the outage interrupted starts again by itself once the connection is back", async () => {
  const uploads = controlledUploads();
  const connection = fakeConnection();
  const { root, strip } = await mountStrip(connection);
  await act(async () => strip.current!.paste(photo));
  expect(uploads).toHaveLength(1);

  await act(async () => {
    connection.set({ phase: "recovering" });
    uploads[0]!.reject(new HostTransportError("unreachable"));
  });
  expect(strip.current!.items[0]).toMatchObject({ error: null, status: "staged" });

  await act(async () => connection.set({ phase: "ready", readyRevision: 2 }));
  expect(uploads).toHaveLength(2);
  await act(async () => uploads[1]!.resolve(uploaded));
  expect(strip.current!.items[0]).toMatchObject({ status: "ready" });
  await act(async () => root.unmount());
});

it("an upload that fails just before the outage is published goes again on recovery", async () => {
  const uploads = controlledUploads();
  const connection = fakeConnection();
  const { root, strip } = await mountStrip(connection);
  await act(async () => strip.current!.paste(photo));

  await act(async () => uploads[0]!.reject(new HostTransportError("unreachable")));
  expect(strip.current!.items[0]).toMatchObject({ status: "error", retryable: true });

  await act(async () => connection.set({ phase: "recovering" }));
  await act(async () => connection.set({ phase: "ready", readyRevision: 2 }));
  expect(uploads).toHaveLength(2);
  await act(async () => uploads[1]!.resolve(uploaded));
  expect(strip.current!.items[0]).toMatchObject({ error: null, status: "ready" });
  await act(async () => root.unmount());
});
