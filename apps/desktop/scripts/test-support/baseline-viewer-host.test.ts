import {
  BrowserRuntime,
  type BrowserAttachment,
  type BrowserFrame,
} from "@opensteer/browser-runtime-core";
import {
  FakeContext,
  FakeLaunchedBrowser,
  FakeLauncher,
  FakePage,
  FakeTicketVerifier,
  flushMicrotasks,
  jpeg,
  testSessionFilesRoot,
  validClaims,
} from "@opensteer/browser-runtime-core/test-support";
import { BrowserWatchStore, type WebSocketClient } from "@opensteer/client/host";
import { BrowserSessionIdSchema } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { BaselineViewerHost } from "./baseline-viewer-host.js";

const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000800");

/** The viewer's socket, joined in memory to the fixture's end of it. */
class ViewerSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  #handle: ((data: string) => void) | undefined;
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  open(host: BaselineViewerHost): void {
    this.readyState = 1;
    this.#emit("open", {});
    // The viewer answers the snapshot at once, before `connect` returns.
    const early: string[] = [];
    this.#handle = (data) => early.push(data);
    const handle = host.connect(
      {
        get readyState() {
          return 1;
        },
        send: (data) =>
          this.#emit("message", {
            data:
              typeof data === "string"
                ? data
                : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
          }),
      },
      `/v1/browser-sessions/${sessionId}/connect?editing=2`,
    );
    this.#handle = handle;
    for (const data of early) handle(data);
  }

  send(data: unknown): void {
    if (typeof data !== "string") throw new Error("A viewer sends text.");
    this.#handle?.(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}

it("brings the runtime's pictures to a targeted viewer, as the Host does", async () => {
  const page = new FakePage();
  const claims = validClaims({
    sessionId,
    identity: { kind: "fresh" },
    editingVersion: 2,
    clipboard: false,
    viewport: { width: 900, height: 600 },
  });
  const runtime = new BrowserRuntime({
    launcher: new FakeLauncher(new FakeLaunchedBrowser(new FakeContext([page]))),
    runtimeId: claims.runtimeId,
    sessionFilesRoot: testSessionFilesRoot(),
    ticketVerifier: new FakeTicketVerifier(claims),
  });
  const failures: unknown[] = [];
  const relayed: BrowserFrame[] = [];
  let attachment: BrowserAttachment | undefined;
  const host = new BaselineViewerHost(
    (message) => attachment!.handle(message),
    (error) => failures.push(error),
  );
  attachment = await runtime.attach("baseline", {
    sendServer: async (message) => host.runtimeMessage(message),
    sendFrame: async (frame) => {
      relayed.push(frame);
      host.runtimeFrame(frame);
    },
  });
  const surfaceId = host.tabStream.meta!.activeId!;
  const socket = new ViewerSocket();
  const store = new BrowserWatchStore(
    () => socket,
    "control",
    undefined,
    () => 60_000,
  );
  const release = store.retain(sessionId, surfaceId);
  let picture = 0;
  const paint = async () => {
    page.cdpSession.emit("Page.screencastFrame", {
      data: jpeg(900, 600).toString("base64"),
      metadata: { deviceHeight: 600, deviceWidth: 900 },
      sessionId: ++picture,
    });
    for (let turn = 0; turn < 10; turn++) await flushMicrotasks();
  };
  try {
    socket.open(host);
    await vi.waitFor(() =>
      expect(page.cdpSession.sent.map(({ method }) => method)).toContain("Page.startScreencast"),
    );
    expect(store.get(sessionId, surfaceId)).toMatchObject({ admitted: true, error: null });

    await paint();
    expect(relayed).toHaveLength(1);
    const first = store.get(sessionId, surfaceId);
    expect(first).toMatchObject({ status: "live", error: null });
    expect(first.frame?.header).toMatchObject({ frameId: relayed[0]!.header.frameId, surfaceId });

    // A second picture waits for the viewer to be done with the first, then follows.
    await paint();
    expect(store.get(sessionId, surfaceId).frame?.header.frameId).toBe(relayed[0]!.header.frameId);
    store.accept(sessionId, surfaceId, first.frame!.header.watchToken!);
    for (let turn = 0; turn < 10; turn++) await flushMicrotasks();
    expect(store.get(sessionId, surfaceId)).toMatchObject({ status: "live", error: null });
    expect(store.get(sessionId, surfaceId).frame?.header.frameId).toBe(
      relayed.at(-1)!.header.frameId,
    );
    expect(failures).toEqual([]);
  } finally {
    release();
    store.dispose();
    await attachment.close();
    await runtime.shutdown();
  }
});
