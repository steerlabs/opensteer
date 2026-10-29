import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserWatchStore } from "./browser-watch.js";
import type { WebSocketClient } from "./host-session-client.js";

const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
const surfaceId = "srf_00000000-0000-4000-8000-000000000001";

class TargetSocket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly sent: string[] = [];
  readonly closes: { code: number; reason: string }[] = [];
  readonly #listeners = new Map<string, Set<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.#emit("close", { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.#emit("open", {});
  }

  receive(message: unknown): void {
    this.#emit("message", {
      data: message instanceof ArrayBuffer ? message : JSON.stringify(message),
    });
  }

  drop(code: number): void {
    this.close(code);
  }

  admit() {
    this.receive({
      type: "browser.snapshot",
      sessionId,
      state: "ready",
      access: "full-control",
      targetedStreamingVersion: 1,
      dialog: null,
      surfaces: [{ id: surfaceId, active: true, title: "Page", url: "about:blank" }],
    });
  }
  picture() {
    const header = new TextEncoder().encode(
      JSON.stringify({
        encoding: "jpeg",
        frameId: 1,
        geometryRevision: 1,
        watchToken: "00000000-0000-4000-8000-000000000001",
        surfaceId,
        viewportWidth: 800,
        viewportHeight: 600,
        rasterWidth: 800,
        rasterHeight: 600,
      }),
    );
    const bytes = new Uint8Array(4 + header.length + 4);
    new DataView(bytes.buffer).setUint32(0, header.length);
    bytes.set(header, 4);
    bytes.set([0xff, 0xd8, 0xff, 0xd9], 4 + header.length);
    this.receive(bytes.buffer);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}

describe("BrowserWatchStore", () => {
  it("ignores another surface's events until the Host answers its subscription", () => {
    const sessionId = `bsn_${crypto.randomUUID()}`;
    const socket = new TargetSocket();
    const received: string[] = [];
    const store = new BrowserWatchStore(
      () => socket,
      "control",
      (_sessionId, message) => received.push(message.type),
      () => 60_000,
      () => false,
    );
    const release = store.retain(sessionId, "page-a", { picture: false });
    socket.open();
    socket.receive({
      access: "full-control",
      dialog: null,
      sessionId,
      state: "ready",
      surfaces: [
        { active: false, id: "page-a", title: "Watched", url: "https://example.com/a" },
        { active: true, id: "page-b", title: "Download", url: "https://example.com/b" },
      ],
      targetedStreamingVersion: 1,
      type: "browser.snapshot",
    });
    expect(JSON.parse(socket.sent.at(-1) ?? "null")).toMatchObject({
      type: "stream.subscribe",
      surfaceId: "page-a",
    });

    // Sent by the Host before it took the subscription: the active surface's.
    const otherDialog = {
      id: "00000000-0000-4000-8000-0000000000e1",
      message: "Leave page?",
      surfaceId: "page-b",
      type: "confirm",
    };
    socket.receive({ type: "browser.dialog.changed", dialog: otherDialog });
    socket.receive({
      type: "browser.editing",
      surfaceId: "page-b",
      context: { contextId: crypto.randomUUID(), field: null, caret: null },
    });
    expect(socket.closes).toEqual([]);
    expect(store.get(sessionId, "page-a").error).toBeNull();
    expect(received).toEqual(["browser.snapshot"]);

    socket.receive({ type: "browser.dialog.changed", surfaceId: "page-a", dialog: null });
    expect(received).toEqual(["browser.snapshot", "browser.dialog.changed"]);
    socket.receive({ type: "browser.dialog.changed", surfaceId: "page-b", dialog: otherDialog });
    expect(store.get(sessionId, "page-a").error).toBe(
      "The dialog event does not match the controlled surface.",
    );
    expect(socket.closes).toMatchObject([{ code: 4002 }]);
    release();
  });
});

describe("retained browser pictures", () => {
  let sockets: TargetSocket[];
  let store: BrowserWatchStore;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    store = new BrowserWatchStore(
      () => {
        const socket = new TargetSocket();
        sockets.push(socket);
        return socket;
      },
      "watch",
      undefined,
      () => 100,
    );
  });
  afterEach(() => {
    store.dispose();
    vi.useRealTimers();
  });

  it.each(["hidden", "network"] as const)(
    "keeps its picture through %s until the new socket delivers",
    (reason) => {
      store.retain(sessionId, surfaceId);
      sockets[0]!.open();
      sockets[0]!.admit();
      sockets[0]!.picture();
      expect(store.get(sessionId, surfaceId).error).toBeNull();
      const first = store.get(sessionId, surfaceId).frame;
      expect(first).not.toBeNull();
      if (reason === "hidden") store.suspend(true);
      else store.reconnect();
      expect(store.get(sessionId, surfaceId).frame).toBe(first);
      expect(store.get(sessionId, surfaceId).status).not.toBe("live");
      if (reason === "hidden") store.suspend(false);
      expect(sockets).toHaveLength(2);
      sockets[1]!.open();
      sockets[1]!.admit();
      expect(store.get(sessionId, surfaceId).frame).toBe(first);
      sockets[1]!.picture();
      expect(store.get(sessionId, surfaceId).frame).not.toBe(first);
      expect(store.get(sessionId, surfaceId).status).toBe("live");
    },
  );

  it("clears the retained browser picture when its login ends with 1008", () => {
    store.retain(sessionId, surfaceId);
    sockets[0]!.open();
    sockets[0]!.admit();
    sockets[0]!.picture();
    expect(store.get(sessionId, surfaceId).frame).not.toBeNull();
    sockets[0]!.drop(1008);
    expect(store.get(sessionId, surfaceId).frame).toBeNull();
    vi.advanceTimersByTime(100);
    sockets[1]!.open();
    sockets[1]!.admit();
    expect(store.get(sessionId, surfaceId).frame).toBeNull();
  });
});
