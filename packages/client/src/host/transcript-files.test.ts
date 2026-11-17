import { afterEach, expect, it, vi } from "vitest";
import { createId, OpensteerError } from "@opensteer/core";
import type {
  FileSource,
  TranscriptFileOpen,
  TranscriptFileOpenInput,
  TranscriptFileContent,
} from "@opensteer/protocol";
import { AssetUrlStore } from "./asset-urls.js";
import { HostClientRequestError } from "./client.js";
import { TranscriptFileController } from "./transcript-files.js";

const controllers: TranscriptFileController[] = [];
afterEach(() => {
  for (const controller of controllers) controller.dispose();
  controllers.length = 0;
});
const source: FileSource = { kind: "path", path: "/home/report.txt" };
function text(text = "Report", revision = "1"): TranscriptFileOpen {
  return {
    status: "ok",
    name: "report.txt",
    sizeBytes: text.length,
    mediaType: "text/plain",
    resource: { kind: "home", key: "opaque", revision },
    preview: { kind: "text", text, truncated: false },
  };
}
/** What the client throws when no answer arrived. */
function unreachable() {
  return new HostClientRequestError({
    code: "internal",
    message: "The Host could not be reached.",
    reason: "transport-unreachable",
    retryable: true,
    status: 500,
  });
}
function setup() {
  const openFile = vi.fn(
    async (_input: TranscriptFileOpenInput, _signal?: AbortSignal): Promise<TranscriptFileOpen> =>
      text(),
  );
  const readFile = vi.fn(async (): Promise<TranscriptFileContent> => ({
    bytes: new Uint8Array([1, 2, 3]),
    metadata: {
      contentType: "application/octet-stream",
      etag: "revision",
      modifiedAt: null,
      sizeBytes: 3,
      truncated: false,
    },
  }));
  const owner = new AbortController();
  const controller = new TranscriptFileController({
    rpc: { openFile, readFile },
    ownerSignal: owner.signal,
  });
  controllers.push(controller);
  return { controller, openFile, readFile, owner };
}
it("coalesces identical opens, retains nullable context, and separates source kind/thread identity", async () => {
  const { controller, openFile } = setup();
  const deferred = Promise.withResolvers<TranscriptFileOpen>();
  openFile.mockReturnValueOnce(deferred.promise);
  const first = controller.open(null, source),
    second = controller.open(null, source);
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1), { timeout: 1000 });
  deferred.resolve(text());
  expect(await first).toEqual(await second);
  expect(openFile.mock.calls[0]![0]).toEqual({ threadId: null, source });
  await controller.open(createId("thread"), source);
  await controller.open(null, { kind: "attachment", attachmentId: createId("attachment") });
  expect(openFile).toHaveBeenCalledTimes(3);
});
it("distinguishes unreachable cached content, infrastructure failure, authoritative absence and sign-in", async () => {
  const { controller, openFile } = setup();
  await controller.open(null, source);
  openFile.mockRejectedValueOnce(unreachable());
  expect(await controller.open(null, source)).toMatchObject({
    status: "unreachable",
    cached: { preview: { text: "Report" } },
  });
  openFile.mockRejectedValueOnce(new OpensteerError({ code: "internal", message: "Failed" }));
  expect(await controller.open(null, source)).toEqual({ status: "failed" });
  openFile.mockRejectedValueOnce(
    new HostClientRequestError({ code: "forbidden", status: 403, message: "Unavailable" }),
  );
  expect(await controller.open(null, source)).toEqual({ status: "unavailable" });
  openFile.mockRejectedValueOnce(new OpensteerError({ code: "unauthorized", message: "Sign in" }));
  await expect(controller.open(null, source)).rejects.toMatchObject({ code: "unauthorized" });
});
it("cancels one view without cancelling a shared read, and the last view discards late bytes", async () => {
  const { controller, openFile } = setup();
  const deferred = Promise.withResolvers<TranscriptFileOpen>();
  openFile.mockReturnValueOnce(deferred.promise);
  const one = new AbortController(),
    two = new AbortController();
  const first = controller.open(null, source, one.signal),
    second = controller.open(null, source, two.signal);
  const rejectedFirst = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const rejectedSecond = expect(second).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(1), { timeout: 1000 });
  one.abort();
  await rejectedFirst;
  expect(openFile.mock.calls[0]![1]?.aborted).toBe(false);
  two.abort();
  await rejectedSecond;
  expect(openFile.mock.calls[0]![1]?.aborted).toBe(true);
  deferred.resolve(text("Should never be cached"));
  await Promise.resolve();
  openFile.mockRejectedValueOnce(unreachable());
  expect(await controller.open(null, source)).toEqual({ status: "unreachable", cached: null });
});
it("clears text and cancels pending operations on owner invalidation and disposal", async () => {
  const { controller, openFile, owner } = setup();
  await controller.open(null, source);
  const deferred = Promise.withResolvers<TranscriptFileOpen>();
  openFile.mockReturnValueOnce(deferred.promise);
  const pending = controller.open(null, source);
  const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(openFile).toHaveBeenCalledTimes(2), { timeout: 1000 });
  owner.abort();
  await rejected;
  deferred.resolve(text("Old owner"));
  await expect(controller.open(null, source)).rejects.toMatchObject({ name: "AbortError" });
});
it("bounds UTF-8 cached text to 4 MiB and evicts the least recently used preview", async () => {
  const { controller, openFile } = setup();
  const halfMiB = "é".repeat(256 * 1024);
  openFile.mockImplementation(async () => text(halfMiB));
  for (let i = 0; i < 8; i++) await controller.open(null, { kind: "path", path: `/${i}` });
  openFile.mockRejectedValueOnce(unreachable());
  expect((await controller.open(null, { kind: "path", path: "/0" })).status).toBe("unreachable");
  await controller.open(null, { kind: "path", path: "/8" });
  openFile.mockRejectedValueOnce(unreachable());
  expect(await controller.open(null, { kind: "path", path: "/1" })).toEqual({
    status: "unreachable",
    cached: null,
  });
  openFile.mockRejectedValueOnce(unreachable());
  expect(await controller.open(null, { kind: "path", path: "/0" })).toMatchObject({
    status: "unreachable",
    cached: { status: "ok" },
  });
  controller.reset();
  openFile.mockRejectedValueOnce(unreachable());
  expect(await controller.open(null, { kind: "path", path: "/0" })).toEqual({
    status: "unreachable",
    cached: null,
  });
});
it("downloads schema-checked bytes on demand and coalesces identical resource revisions", async () => {
  const { controller, openFile, readFile } = setup();
  const resource = {
    kind: "output-image" as const,
    sequence: "123" as import("@opensteer/core").Sequence,
    index: 1,
    revision: "revision",
  };
  const threadId = createId("thread");
  const [first, second] = await Promise.all([
    controller.download(threadId, resource),
    controller.download(threadId, resource),
  ]);
  expect(first).toMatchObject({ status: "ok", bytes: new Uint8Array([1, 2, 3]) });
  expect(first).toBe(second);
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(openFile).not.toHaveBeenCalled();
  readFile.mockRejectedValueOnce(new OpensteerError({ code: "not_found", message: "Missing" }));
  expect(await controller.download(threadId, resource)).toEqual({ status: "unavailable" });
  // A copy or save knows only the source: it reads the revision the open names.
  expect(await controller.original(threadId, source)).toEqual({
    status: "ok",
    name: "report.txt",
    mediaType: "text/plain",
    bytes: new Uint8Array([1, 2, 3]),
  });
  expect(readFile).toHaveBeenLastCalledWith(
    { threadId, resource: { kind: "home", key: "opaque", revision: "1" } },
    expect.any(AbortSignal),
  );
  openFile.mockResolvedValueOnce({ status: "unavailable" });
  expect(await controller.original(threadId, { kind: "path", path: "/gone" })).toEqual({
    status: "unavailable",
  });
});
it("shows an opened image from the preview its open minted, without minting it again", async () => {
  const assetUrls = vi.fn(async () => ({ assets: [] }));
  const store = new AssetUrlStore(assetUrls, { origin: async () => "https://host.example" }, true);
  const deploymentId = "dep_1";
  const threadId = createId("thread");
  const image = { kind: "path" as const, path: "/home/plot.png" };
  const minted = {
    status: "ok" as const,
    url: "/media/token/plot.png",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    revision: "r1",
    mediaType: "image/webp" as const,
    width: 640,
    height: 480,
  };
  const controller = new TranscriptFileController({
    images: { store, deploymentId: () => deploymentId },
    rpc: {
      openFile: async () => ({
        status: "ok",
        name: "plot.png",
        sizeBytes: 10,
        mediaType: "image/png",
        resource: { kind: "home", key: "opaque", revision: "r1" },
        preview: { kind: "image", image: minted },
      }),
      readFile: vi.fn(),
    },
  });
  controllers.push(controller);
  try {
    await controller.open(threadId, image);
    expect(await store.image(deploymentId, threadId, image, "preview")).toMatchObject({
      revision: "r1",
      source: "app://opensteer/media/dep_1/token/plot.png",
    });
    store.confirm(deploymentId, threadId, image, "preview");
    await Promise.resolve();
    expect(assetUrls).not.toHaveBeenCalled();
  } finally {
    store.dispose();
  }
});
