import { afterEach, expect, it, vi } from "vitest";
import { createId, OpensteerError } from "@opensteer/core";
import type {
  FileSource,
  TranscriptFileOpen,
  TranscriptFileOpenInput,
  TranscriptFileContent,
} from "@opensteer/protocol";
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
it("distinguishes offline cached content, infrastructure failure, authoritative absence and sign-in", async () => {
  const { controller, openFile } = setup();
  await controller.open(null, source);
  openFile.mockRejectedValueOnce(
    new HostClientRequestError({
      code: "internal",
      reason: "transport-unreachable",
      status: 500,
      message: "Offline",
    }),
  );
  expect(await controller.open(null, source)).toMatchObject({
    status: "offline",
    cached: { preview: { text: "Report" } },
  });
  openFile.mockRejectedValueOnce(new OpensteerError({ code: "internal", message: "Failed" }));
  expect(await controller.open(null, source)).toEqual({ status: "failed" });
  openFile.mockRejectedValueOnce(
    new HostClientRequestError({ code: "forbidden", status: 403, message: "Unavailable" }),
  );
  expect(await controller.open(null, source)).toEqual({ status: "unavailable" });
  openFile.mockRejectedValueOnce(new TypeError("offline"));
  expect(await controller.open(null, source)).toEqual({ status: "offline", cached: null });
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
  openFile.mockRejectedValueOnce(new TypeError("offline"));
  expect(await controller.open(null, source)).toEqual({ status: "offline", cached: null });
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
  openFile.mockRejectedValueOnce(new TypeError("offline"));
  expect((await controller.open(null, { kind: "path", path: "/0" })).status).toBe("offline");
  await controller.open(null, { kind: "path", path: "/8" });
  openFile.mockRejectedValueOnce(new TypeError("offline"));
  expect(await controller.open(null, { kind: "path", path: "/1" })).toEqual({
    status: "offline",
    cached: null,
  });
  openFile.mockRejectedValueOnce(new TypeError("offline"));
  expect(await controller.open(null, { kind: "path", path: "/0" })).toMatchObject({
    status: "offline",
    cached: { status: "ok" },
  });
  controller.reset();
  openFile.mockRejectedValueOnce(new TypeError("offline"));
  expect(await controller.open(null, { kind: "path", path: "/0" })).toEqual({
    status: "offline",
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
});
