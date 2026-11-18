// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostTransportError } from "@opensteer/client/connections";
import { HostClientRequestError, stageAttachment, type HostClient } from "@opensteer/client/host";
import { composerDrafts } from "../composer-drafts.js";
import {
  discardAllStagedFiles,
  useStagedAttachments,
  type StagedAttachments,
} from "./use-staged-attachments.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock("@opensteer/client/host", async (original) => ({
  ...(await original<typeof import("@opensteer/client/host")>()),
  stageAttachment: vi.fn(),
}));

/** A connection a test moves between ready and recovering. */
function fakeConnection(phase: "ready" | "recovering" = "ready") {
  let state = { phase, readyRevision: phase === "ready" ? 1 : 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    retry: () => undefined,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next: Partial<typeof state>) {
      state = { ...state, ...next };
      listeners.forEach((listener) => listener());
    },
  };
}

const scope = "staged-files-test";
let root: Root | null = null;
let files: StagedAttachments;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  discardAllStagedFiles();
  localStorage.clear();
});

function Tray({ client }: { readonly client: HostClient }) {
  files = useStagedAttachments({ client, scope, deploymentId: "deployment" });
  return null;
}

/** Opens a draft holding one file the Host already has, as a reload does. */
async function reopen(getAttachment: HostClient["getAttachment"], connection = fakeConnection()) {
  const part = {
    artifactId: "file-1",
    mediaType: "text/plain",
    name: "notes.txt",
    type: "artifact",
  };
  composerDrafts.update(scope, {
    files: [{ mediaType: "text/plain", name: "notes.txt", part: part as never, sizeBytes: 3 }],
  });
  const client = { connection, getAttachment } as unknown as HostClient;
  root = createRoot(document.createElement("div"));
  await act(async () => root?.render(<Tray client={client} />));
}

describe("a saved file checked against the Host", () => {
  it("offers another try when the Host could not be reached, then is ready", async () => {
    const getAttachment = vi
      .fn<HostClient["getAttachment"]>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({
        id: "file-1",
        mediaType: "text/plain",
        name: "notes.txt",
        sizeBytes: 3,
        state: "ready",
      } as never);
    await reopen(getAttachment);
    expect(files.items[0]).toMatchObject({ retryable: true, status: "failed" });

    await act(async () => files.retry(files.items[0]!.localId));

    expect(files.items[0]).toMatchObject({ error: null, status: "ready" });
  });

  it("asks for the file again when the Host no longer has it", async () => {
    await reopen(
      vi
        .fn<HostClient["getAttachment"]>()
        .mockRejectedValue(
          new HostClientRequestError({ code: "not_found", message: "Gone.", status: 404 }),
        ),
    );
    expect(files.items[0]).toMatchObject({ retryable: false, status: "failed" });
  });
});

const notes = {
  id: "file-1",
  mediaType: "text/plain",
  name: "notes.txt",
  sizeBytes: 3,
  state: "ready",
} as never;

describe("files during an outage", () => {
  it("a saved file waits for the connection instead of failing its check", async () => {
    const connection = fakeConnection("recovering");
    const getAttachment = vi.fn<HostClient["getAttachment"]>().mockResolvedValue(notes);
    await reopen(getAttachment, connection);
    expect(files.items[0]).toMatchObject({ error: null, status: "waiting" });
    expect(getAttachment).not.toHaveBeenCalled();

    await act(async () => connection.set({ phase: "ready", readyRevision: 1 }));

    expect(files.items[0]).toMatchObject({ error: null, status: "ready" });
  });

  it("a file the outage interrupted uploads by itself once the connection is back", async () => {
    const uploads: { reject(error: unknown): void; resolve(value: unknown): void }[] = [];
    vi.mocked(stageAttachment).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          uploads.push({ reject, resolve: resolve as (value: unknown) => void });
        }) as ReturnType<typeof stageAttachment>,
    );
    const connection = fakeConnection();
    const client = { connection } as unknown as HostClient;
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Tray client={client} />));
    await act(async () => files.add([new File(["abc"], "notes.txt", { type: "text/plain" })]));
    await vi.waitFor(() => expect(uploads).toHaveLength(1), { timeout: 1_000 });

    await act(async () => {
      connection.set({ phase: "recovering" });
      uploads[0]!.reject(new HostTransportError("unreachable"));
    });
    expect(files.items[0]).toMatchObject({ error: null, status: "waiting" });

    // Picked while still out of reach: it waits rather than starting an upload.
    await act(async () => files.add([new File(["def"], "more.txt", { type: "text/plain" })]));
    expect(files.items[1]).toMatchObject({ status: "waiting" });
    expect(uploads).toHaveLength(1);

    await act(async () => connection.set({ phase: "ready", readyRevision: 2 }));
    await vi.waitFor(() => expect(uploads).toHaveLength(3), { timeout: 1_000 });
    await act(async () => {
      uploads[1]!.resolve(notes);
      uploads[2]!.resolve({ ...(notes as object), id: "file-2", name: "more.txt" });
    });
    expect(files.items.map((item) => item.status)).toEqual(["ready", "ready"]);
  });

  it("a failure just before the outage is published goes again on recovery", async () => {
    const connection = fakeConnection();
    const getAttachment = vi
      .fn<HostClient["getAttachment"]>()
      .mockRejectedValueOnce(new HostTransportError("unreachable"))
      .mockResolvedValue(notes);
    await reopen(getAttachment, connection);
    expect(files.items[0]).toMatchObject({ retryable: true, status: "failed" });

    await act(async () => connection.set({ phase: "recovering" }));
    await act(async () => connection.set({ phase: "ready", readyRevision: 2 }));

    expect(files.items[0]).toMatchObject({ error: null, status: "ready" });
  });
});

it.each(["upload", "saved check"] as const)(
  "restarts a %s that fails after its replacement connection is ready",
  async (operation) => {
    const connection = fakeConnection();
    const held = Promise.withResolvers<never>();
    const started = Promise.withResolvers<void>();
    const read = vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve();
        return held.promise;
      })
      .mockResolvedValue(notes);
    if (operation === "saved check") await reopen(read, connection);
    else {
      vi.mocked(stageAttachment).mockImplementation(() => read());
      const client = { connection } as unknown as HostClient;
      root = createRoot(document.createElement("div"));
      await act(async () => root?.render(<Tray client={client} />));
      await act(async () => files.add([new File(["abc"], "notes.txt", { type: "text/plain" })]));
    }
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce(), { timeout: 1_000 });
    await started.promise;
    await act(async () => connection.set({ phase: "recovering" }));
    await act(async () => connection.set({ phase: "ready", readyRevision: 2 }));
    expect(read).toHaveBeenCalledOnce();
    await act(async () => held.reject(new HostTransportError("unreachable")));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 1_000 });
    expect(files.items[0]).toMatchObject({ status: "ready" });
  },
);
