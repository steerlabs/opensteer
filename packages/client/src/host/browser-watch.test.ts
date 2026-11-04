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
      access: "read-write",
      targetedStreamingVersion: 1,
      dialog: null,
      surfaces: [{ id: surfaceId, active: true, title: "Page", url: "about:blank" }],
    });
  }
  garbled() {
    this.#emit("message", { data: "{ not a frame" });
  }
  picture(sequence = 1, target = surfaceId) {
    const header = new TextEncoder().encode(
      JSON.stringify({
        encoding: "jpeg",
        frameId: sequence,
        geometryRevision: 1,
        watchToken: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
        surfaceId: target,
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
  describe("raster demand", () => {
    const flush = async () => {
      for (let turn = 0; turn < 3; turn++) await Promise.resolve();
    };
    const sent = (socket: TargetSocket) =>
      socket.sent.map((message) => JSON.parse(message) as Record<string, unknown>);
    const demands = (socket: TargetSocket) =>
      sent(socket)
        .filter((message) => message.type === "stream.demand")
        .map((message) => message.density);
    const create = (sockets: TargetSocket[], supported = true) =>
      new BrowserWatchStore(
        () => {
          const socket = new TargetSocket();
          sockets.push(socket);
          return socket;
        },
        "control",
        undefined,
        () => 0,
        () => false,
        undefined,
        () => false,
        () => supported,
      );

    it("asks one target for its panes' maximum without resubscribing or touching input", async () => {
      const sockets: TargetSocket[] = [];
      const store = create(sockets);
      const first = store.rasterDemand(sessionId, surfaceId);
      const releaseFirst = store.retain(sessionId, surfaceId, { rasterDemand: true });
      const releaseSecond = store.retain(sessionId, surfaceId, { rasterDemand: true });
      const socket = sockets[0]!;
      socket.open();
      await flush();
      expect(demands(socket)).toEqual([]);
      socket.admit();
      const second = store.rasterDemand(sessionId, surfaceId);
      await flush();
      // Unmeasured panes ask for the densest raster.
      expect(demands(socket)).toEqual([2]);
      first.update(1);
      second.update(0.75);
      first.update(1.25);
      await flush();
      expect(demands(socket)).toEqual([2, 1.25]);
      first.release();
      first.release();
      first.update(2);
      await flush();
      expect(demands(socket)).toEqual([2, 1.25, 0.75]);
      // A remount inside one turn sends nothing.
      second.release();
      const remounted = store.rasterDemand(sessionId, surfaceId);
      remounted.update(0.75);
      await flush();
      expect(demands(socket)).toEqual([2, 1.25, 0.75]);
      expect(sent(socket).filter((message) => message.type === "stream.subscribe")).toHaveLength(1);
      expect(
        sent(socket).filter(
          (message) => message.type === "stream.demand" && "inputSequence" in message,
        ),
      ).toEqual([]);
      expect(socket.sent.some((message) => message.includes("input.cancel"))).toBe(false);
      expect(socket.closes).toEqual([]);
      remounted.release();
      releaseSecond();
      releaseFirst();
      store.dispose();
    });

    it("keeps the densest raster while any picture holder does not state demand", async () => {
      const sockets: TargetSocket[] = [];
      const store = create(sockets);
      const release = store.retain(sessionId, surfaceId, { rasterDemand: true });
      const lease = store.rasterDemand(sessionId, surfaceId);
      lease.update(1);
      const socket = sockets[0]!;
      socket.open();
      socket.admit();
      await flush();
      expect(demands(socket)).toEqual([1]);
      const silent = store.retain(sessionId, surfaceId);
      const following = store.retain(sessionId, surfaceId, { picture: false });
      await flush();
      expect(demands(socket)).toEqual([1, 2]);
      silent();
      await flush();
      expect(demands(socket)).toEqual([1, 2, 1]);
      release();
      lease.release();
      await flush();
      // Following without pictures asks for no raster at all.
      expect(demands(socket)).toEqual([1, 2, 1]);
      following();
      store.dispose();
    });

    it("never sends demand to a Host that does not advertise it", async () => {
      const sockets: TargetSocket[] = [];
      const store = create(sockets, false);
      const release = store.retain(sessionId, surfaceId, { rasterDemand: true });
      const lease = store.rasterDemand(sessionId, surfaceId);
      sockets[0]!.open();
      sockets[0]!.admit();
      lease.update(0.75);
      await flush();
      expect(demands(sockets[0]!)).toEqual([]);
      lease.release();
      release();
      store.dispose();
    });

    it("restates demand on each authorized socket and forgets released leases", async () => {
      const sockets: TargetSocket[] = [];
      const store = create(sockets);
      const release = store.retain(sessionId, surfaceId, { rasterDemand: true });
      const lease = store.rasterDemand(sessionId, surfaceId);
      lease.update(1.5);
      sockets[0]!.open();
      sockets[0]!.admit();
      await flush();
      expect(demands(sockets[0]!)).toEqual([1.5]);
      store.reconnect();
      const replacement = sockets[1]!;
      replacement.open();
      await flush();
      expect(demands(replacement)).toEqual([]);
      replacement.admit();
      await flush();
      expect(demands(replacement)).toEqual([1.5]);
      lease.release();
      release();
      await flush();
      expect(replacement.closes).toMatchObject([{ code: 1000 }]);
      // Nothing of the released lease remains for the next holder.
      const again = store.retain(sessionId, surfaceId, { rasterDemand: true });
      sockets[2]!.open();
      sockets[2]!.admit();
      await flush();
      expect(demands(sockets[2]!)).toEqual([2]);
      again();
      store.dispose();
    });
  });

  it.each([false, true])(
    "negotiates pipelining only when the Host supports it (%s)",
    (supported) => {
      const socket = new TargetSocket();
      const store = new BrowserWatchStore(
        () => socket,
        "watch",
        undefined,
        () => 100,
        () => false,
        undefined,
        () => supported,
      );
      const release = store.retain(sessionId, surfaceId, { frameWindow: true });
      socket.open();
      socket.admit();
      expect(JSON.parse(socket.sent.at(-1)!)).toEqual({
        type: "stream.subscribe",
        surfaceId,
        ...(supported ? { frameWindow: 1 } : {}),
      });
      release();
      store.dispose();
    },
  );

  it("requires every picture holder to support pipelining and settles receipts only on presentation or retirement", () => {
    const socket = new TargetSocket();
    const store = new BrowserWatchStore(
      () => socket,
      "control",
      undefined,
      () => 100,
      () => false,
      undefined,
      () => true,
    );
    const release = store.retain(sessionId, surfaceId, { frameWindow: true });
    socket.open();
    socket.admit();
    socket.picture(1);
    store.claim(sessionId, surfaceId, "00000000-0000-4000-8000-000000000001");
    socket.picture(2);
    const acknowledgements = () =>
      socket.sent
        .map((message) => JSON.parse(message))
        .filter((message) => message.type === "stream.ack");
    // The presenter can still be decoding picture 1 while picture 2 waits.
    // Replacing the store's newest frame is not a presentation or a discard.
    expect(acknowledgements()).toEqual([]);
    store.accept(sessionId, surfaceId, "00000000-0000-4000-8000-000000000001");
    expect(acknowledgements().map((message) => message.token)).toEqual([
      "00000000-0000-4000-8000-000000000001",
    ]);
    const legacy = store.retain(sessionId, surfaceId);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "stream.subscribe", surfaceId });
    expect(acknowledgements()).toHaveLength(2);
    legacy();
    expect(JSON.parse(socket.sent.at(-1)!)).toMatchObject({ frameWindow: 1 });
    socket.picture(3);
    store.accept(sessionId, surfaceId, "00000000-0000-4000-8000-000000000002");
    store.accept(sessionId, surfaceId, "00000000-0000-4000-8000-000000000003");
    socket.picture(4);
    store.claim(sessionId, surfaceId, "00000000-0000-4000-8000-000000000004");
    socket.picture(5);
    store.claim(sessionId, surfaceId, "00000000-0000-4000-8000-000000000005");
    expect(acknowledgements()).toHaveLength(3);
    socket.receive({ type: "browser.stream.state", surfaceId, state: "capacity" });
    expect(socket.closes).toEqual([]);
    expect(store.get(sessionId, surfaceId).frame?.header.frameId).toBe(5);
    store.accept(sessionId, surfaceId, "00000000-0000-4000-8000-000000000004");
    socket.picture(6);
    socket.picture(7);
    expect(acknowledgements()).toHaveLength(6);
    release();
    expect(acknowledgements().map((message) => message.token)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map(
        (sequence) => `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      ),
    );
    store.dispose();
  });

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
      access: "read-write",
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

describe("frames a target cannot read", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function target() {
    const sockets: TargetSocket[] = [];
    const delays: Array<readonly [number, number]> = [];
    const store = new BrowserWatchStore(
      () => {
        const socket = new TargetSocket();
        sockets.push(socket);
        return socket;
      },
      "watch",
      undefined,
      (attempt, unreadableFrames) => {
        delays.push([attempt, unreadableFrames]);
        return 10 * 2 ** Math.max(attempt, unreadableFrames - 1);
      },
    );
    return { delays, release: store.retain(sessionId, surfaceId), sockets, store };
  }
  const unreadable = { type: "browser.surfaces.changed", surfaces: "unreadable" };
  const state = (f: ReturnType<typeof target>) => f.store.get(sessionId, surfaceId);
  /** Fails three times right after a snapshot, which leaves a 40ms wait running. */
  function failThrice(f: ReturnType<typeof target>) {
    for (const delay of [10, 20]) {
      const socket = f.sockets.at(-1)!;
      socket.open();
      socket.admit();
      socket.garbled();
      vi.advanceTimersByTime(delay);
    }
    const socket = f.sockets.at(-1)!;
    socket.open();
    socket.admit();
    socket.garbled();
  }

  it.each([
    ["unreadable JSON", (socket: TargetSocket) => socket.garbled()],
    ["a message its schema refuses", (socket: TargetSocket) => socket.receive(unreadable)],
  ])("reconnects after %s, keeping the last picture and taking no input", (_name, lose) => {
    const f = target();
    const socket = f.sockets[0]!;
    socket.open();
    socket.admit();
    socket.picture(1);
    const { frame } = state(f);
    expect(frame).not.toBeNull();
    lose(socket);
    expect(socket.closes).toMatchObject([{ code: 4002 }]);
    expect(state(f)).toMatchObject({ error: null, status: "unavailable" });
    expect(state(f).frame).toBe(frame);
    vi.advanceTimersByTime(9);
    expect(f.sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(f.sockets).toHaveLength(2);
    expect(state(f).status).toBe("connecting");
    f.release();
  });

  it.each([
    ["a picture", (socket: TargetSocket) => socket.picture(1)],
    [
      "a message",
      (socket: TargetSocket) =>
        socket.receive({
          type: "browser.surfaces.changed",
          surfaces: [{ id: surfaceId, active: true, title: "Page", url: "about:blank" }],
        }),
    ],
  ])("keeps counting failures across snapshots until %s is read past one", (_name, read) => {
    const f = target();
    failThrice(f);
    expect(f.delays.at(-1)).toEqual([0, 3]);
    vi.advanceTimersByTime(40);
    const socket = f.sockets.at(-1)!;
    socket.open();
    socket.admit();
    read(socket);
    socket.garbled();
    expect(f.delays.at(-1)).toEqual([0, 1]);
    f.release();
  });

  it("acknowledges to a new socket only the frames that socket sent", () => {
    const f = target();
    const token = (sequence: number) =>
      `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    const first = f.sockets[0]!;
    first.open();
    first.admit();
    for (let sequence = 1; sequence <= 8; sequence += 1) {
      first.picture(sequence);
      f.store.claim(sessionId, surfaceId, token(sequence));
    }
    first.garbled();
    vi.advanceTimersByTime(10);
    const next = f.sockets[1]!;
    next.open();
    next.admit();
    next.picture(9);
    expect(next.closes).toEqual([]);
    expect(state(f)).toMatchObject({ error: null, status: "live" });
    f.store.accept(sessionId, surfaceId, token(9));
    const acknowledged = next.sent
      .map((sent) => JSON.parse(sent) as { type: string; token?: string })
      .filter(({ type }) => type === "stream.ack")
      .map((message) => message.token);
    expect(acknowledged).toEqual([token(9)]);
    f.release();
  });

  it("keeps its retry time through network changes and another holder, and a fresh view tries at once", () => {
    const f = target();
    failThrice(f);
    vi.advanceTimersByTime(10);
    f.store.reconnect();
    f.store.reconnect();
    const second = f.store.retain(sessionId, surfaceId);
    expect(f.sockets).toHaveLength(3);
    vi.advanceTimersByTime(29);
    expect(f.sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(f.sockets).toHaveLength(4);
    second();
    f.release();
    const fresh = f.store.retain(sessionId, surfaceId);
    expect(f.sockets).toHaveLength(5);
    fresh();
  });

  it("does not restart an attempt in flight", () => {
    const f = target();
    failThrice(f);
    vi.advanceTimersByTime(40);
    expect(f.sockets).toHaveLength(4);
    f.store.reconnect();
    expect(f.sockets).toHaveLength(4);
    f.release();
  });

  it.each([
    [
      "a Host that refuses target control",
      (socket: TargetSocket) => {
        socket.admit();
        socket.receive({
          type: "browser.error",
          error: {
            code: "bad_message",
            message: "Update the Host.",
            reason: "browser-target-control-unsupported",
            retryable: false,
          },
        });
      },
    ],
    [
      "a Host without targeted streaming",
      (socket: TargetSocket) =>
        socket.receive({
          type: "browser.snapshot",
          sessionId,
          state: "ready",
          access: "read-write",
          dialog: null,
          surfaces: [{ id: surfaceId, active: true, title: "Page", url: "about:blank" }],
        }),
    ],
    [
      "a picture of another target",
      (socket: TargetSocket) => {
        socket.admit();
        socket.picture(1, "srf_00000000-0000-4000-8000-000000000002");
      },
    ],
    [
      "the Host closing with a protocol violation",
      (socket: TargetSocket) => {
        socket.admit();
        socket.drop(4002);
      },
    ],
    [
      "access ending",
      (socket: TargetSocket) => {
        socket.admit();
        socket.drop(4003);
      },
    ],
  ])("still stops for good on %s", (_name, stop) => {
    const f = target();
    const socket = f.sockets[0]!;
    socket.open();
    stop(socket);
    expect(state(f).error).not.toBeNull();
    vi.advanceTimersByTime(600_000);
    f.store.reconnect();
    expect(f.sockets).toHaveLength(1);
    f.release();
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

it("keeps a retained target's frame through eligibility gaps, releases transport and credit, and clears on access loss", () => {
  const sockets: TargetSocket[] = [];
  const store = new BrowserWatchStore(
    () => {
      const socket = new TargetSocket();
      sockets.push(socket);
      return socket;
    },
    "watch",
    undefined,
    () => 100,
  );
  const release = store.retain(sessionId, surfaceId);
  try {
    const first = sockets[0]!;
    first.open();
    first.admit();
    first.picture();
    const frame = store.get(sessionId, surfaceId).frame;
    expect(frame).not.toBeNull();
    store.reconcile(() => false);
    expect(first.readyState).toBe(3);
    expect(store.get(sessionId, surfaceId)).toMatchObject({ frame, status: "unavailable" });
    store.reconcile(() => true);
    expect(sockets).toHaveLength(2);
    const restored = sockets[1]!;
    restored.open();
    restored.admit();
    expect(store.get(sessionId, surfaceId).frame).toBe(frame);
    restored.drop(4003);
    expect(store.get(sessionId, surfaceId).frame).toBeNull();
  } finally {
    release();
    store.dispose();
  }
});

it.each([false, true])(
  "clears catalog-revoked frames and inactive presenter fences before socket close (released %s)",
  (released) => {
    const socket = new TargetSocket();
    const store = new BrowserWatchStore(
      () => socket,
      "watch",
      undefined,
      () => 100,
    );
    const changed = vi.fn();
    const unsubscribe = store.subscribe(sessionId, surfaceId, changed);
    const release = store.retain(sessionId, surfaceId);
    try {
      socket.open();
      socket.admit();
      socket.picture();
      const before = store.invalidationKey(sessionId, surfaceId);
      if (released) release();
      else store.reconcile(() => false);
      changed.mockClear();
      store.reconcile(
        () => false,
        () => false,
      );
      expect(store.get(sessionId, surfaceId).frame).toBeNull();
      expect(store.invalidationKey(sessionId, surfaceId)).not.toBe(before);
      expect(changed).toHaveBeenCalled();
    } finally {
      release();
      unsubscribe();
      store.dispose();
    }
  },
);
