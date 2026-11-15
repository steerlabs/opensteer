import {
  BrowserSessionIdSchema,
  BrowserSurfaceIdSchema,
  createId,
  PlaceEnteredEventViewSchema,
  type PlaceEnteredEventView,
} from "@opensteer/core";
import {
  computerAppIdentityKey,
  encodeDisplayViewerFrame,
  placeIdentityKey,
} from "@opensteer/protocol";
import { expect, it } from "vitest";
import { sharedDisplayStreams, type DisplayFrame } from "../integrations/phone-display-stream.js";
import { seedBrowserSession, replaceBrowserTabs } from "../test-support/browser-snapshot.js";
import { BrowserWatchStore } from "./browser-watch.js";
import { reconcileBrowserLastPictures } from "./browser-last-picture.js";
import type { BrowserFrameStore, HostClient, HostSnapshot } from "./client.js";
import type { WebSocketClient } from "./host-session-client.js";
import { RunPlaceStore } from "./run-place.js";
import {
  attachRunPlaceDisplay,
  clearRunPlacePictures,
  reportRunPlacePicture,
  retainRunPlacePicture,
  runPlacePicture,
  subscribeRunPlacePicture,
} from "./run-place-picture.js";

type PlaceRef = PlaceEnteredEventView["data"]["place"];

const sessionId = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000001");
const tabId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000001");
const otherTabId = BrowserSurfaceIdSchema.parse("srf_00000000-0000-4000-8000-000000000002");
const displaySessionId = "cus_00000000-0000-4000-8000-000000000001";
const threadId = createId("thread");
const runId = createId("run");
const machineId = createId("runner");
const browserPlace: PlaceRef = { kind: "browser", sessionId, surfaceId: tabId };

class Socket implements WebSocketClient {
  binaryType: "arraybuffer" | "blob" = "blob";
  readyState = 0;
  readonly sent: Record<string, unknown>[] = [];
  readonly #listeners = new Map<string, Set<(event: never) => void>>();
  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    this.#listeners.set(type, listeners);
    listeners.add(listener);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(code = 1000): void {
    this.readyState = 3;
    this.#emit("close", { code, reason: "" });
  }
  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
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
  browserFrame(surfaceId = tabId): void {
    this.receive({
      type: "browser.snapshot",
      sessionId,
      state: "ready",
      access: "read-write",
      targetedStreamingVersion: 1,
      dialog: null,
      surfaces: [],
    });
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
  displayFrame(sequence: number): void {
    this.receive(
      encodeDisplayViewerFrame(
        {
          generation: 1,
          sequence,
          ptsUs: sequence * 33_333,
          width: 720,
          height: 1280,
          key: true,
          codec: "avc1.42C01F",
        },
        new Uint8Array([0, 0, 0, 1, 0x65]),
      ).slice().buffer,
    );
  }
}

const app = { bundleId: "com.apple.TextEdit", displayName: "TextEdit", teamId: null };

function fixture(phone = true) {
  const sockets: Socket[] = [];
  const displays: Socket[] = [];
  const watch = new BrowserWatchStore(
    () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    "watch",
    undefined,
    () => 100,
  );
  const control = new BrowserWatchStore(
    () => {
      throw Error("Unexpected control lease");
    },
    "control",
    undefined,
    () => 100,
  );
  const frames = (store: BrowserWatchStore): BrowserFrameStore => ({
    get: (session, surface) => store.get(session, surface).frame,
    subscribe: (session, listener, surface) => store.subscribe(session, surface, listener),
    invalidationKey: store.invalidationKey,
  });
  const session = seedBrowserSession(
    { id: sessionId, state: "ready" },
    {
      rows: [{ id: tabId }, { id: otherTabId }],
    },
  );
  const places = new RunPlaceStore();
  const listeners = new Set<() => void>();
  let snapshot = {
    session: "authenticated",
    user: { id: "user" },
    deploymentId: "deployment",
    machines: [
      {
        id: machineId,
        status: "online",
        computerUse: {
          displayStreamSupported: true,
          sessions: [
            {
              sessionId: displaySessionId,
              runId,
              display: phone,
              apps: phone ? [] : [app],
            },
          ],
        },
      },
    ],
    browserTabs: session.browserTabs,
  } as unknown as HostSnapshot;
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    browserTabs: session.browserTabs,
    runPlace: places.get,
    subscribeRunPlace: places.subscribe,
    browserWatchState: watch.get,
    subscribeBrowserWatch: watch.subscribe,
    retainBrowserWatch: watch.retain.bind(watch),
    browserWatchFrames: frames(watch),
    browserFrames: frames(control),
    connectComputerDisplay: () => {
      const socket = new Socket();
      displays.push(socket);
      return socket;
    },
  } as unknown as HostClient;
  const reconcilePictures = () => {
    for (const frames of [client.browserWatchFrames, client.browserFrames])
      reconcileBrowserLastPictures(
        frames,
        (sessionId, tabId) => session.browserTabs.sessionTab(sessionId, tabId)?.documentId,
        (tabId) => {
          const groupId = session.browserTabs.groupForTab(tabId);
          return groupId ? session.browserTabs.group(groupId)?.sessionId : undefined;
        },
      );
  };
  reconcilePictures();
  const stopPictures = session.browserTabs.subscribe(reconcilePictures);
  let sequence = 0;
  function enter(place: PlaceRef, id = runId) {
    const entry = PlaceEnteredEventViewSchema.parse({
      type: "place.entered",
      eventId: createId("event"),
      environmentId: createId("environment"),
      threadId,
      runId: id,
      sequence: String(++sequence),
      createdAt: "2026-11-15T12:00:00Z",
      data: { place, title: "Place", site: null },
    });
    places.accept(entry);
  }
  return {
    client,
    watch,
    places,
    sockets,
    displays,
    enter,
    update(patch: Partial<HostSnapshot>) {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
    dispose() {
      stopPictures();
      clearRunPlacePictures(client);
      sharedDisplayStreams(client).dispose();
      places.dispose();
      watch.dispose();
      control.dispose();
    },
  };
}

it("holds the real browser watch across forms, keeps sleeping pictures and aspect, and clears revoked pictures", () => {
  const f = fixture();
  f.enter(browserPlace);
  const release = retainRunPlacePicture(f.client, threadId, runId, false);
  const read = () => runPlacePicture(f.client, threadId);
  try {
    const socket = f.sockets[0]!;
    socket.open();
    socket.browserFrame();
    const frame = f.watch.get(sessionId, tabId).frame;
    expect(read()).toEqual({
      placeKey: placeIdentityKey(browserPlace),
      usable: true,
      fresh: true,
      aspect: 4 / 3,
    });
    for (const form of ["page", "bar", "row", "page"]) {
      const unmount = subscribeRunPlacePicture(f.client, threadId, () => {});
      unmount();
      expect(f.watch.get(sessionId, tabId).frame, form).toBe(frame);
      expect(socket.readyState).toBe(1);
      expect(f.sockets).toHaveLength(1);
    }
    f.watch.suspend(true);
    expect(read()).toMatchObject({ usable: true, fresh: false });
    const tabs = f.client.browserTabs;
    replaceBrowserTabs(
      tabs,
      sessionId,
      tabs
        .sessionTabs(sessionId)
        .map((tab) => (tab.id === tabId ? { ...tab, state: "suspended", documentId: null } : tab)),
    );
    expect(f.watch.get(sessionId, tabId).frame).toBeNull();
    expect(read()).toMatchObject({ usable: true, fresh: false, aspect: 4 / 3 });
    expect(f.sockets).toHaveLength(1);
    f.watch.reconcile(
      () => false,
      () => false,
    );
    expect(read()).toMatchObject({ usable: false, fresh: false });
    f.watch.reconcile(
      () => true,
      () => true,
    );
    f.watch.suspend(false);
    f.enter({ ...browserPlace, surfaceId: otherTabId });
    expect(read()).toMatchObject({ usable: false, fresh: false, aspect: 4 / 3 });
    const next = f.sockets.at(-1)!;
    next.open();
    next.browserFrame(otherTabId);
    expect(read().usable).toBe(true);
    next.close(4003);
    expect(read()).toMatchObject({ usable: false, fresh: false, aspect: 4 / 3 });
    release();
    const nextRun = createId("run");
    f.enter({ ...browserPlace, surfaceId: otherTabId }, nextRun);
    const end = retainRunPlacePicture(f.client, threadId, nextRun, false);
    expect(read().aspect).toBeNull();
    end();
  } finally {
    release();
    f.dispose();
  }
});

it.each(["phone", "app"] as const)(
  "holds a %s display without leaking credit and fences cleared or revoked reports",
  (kind) => {
    const f = fixture(kind === "phone");
    const place: PlaceRef =
      kind === "phone"
        ? { kind: "phone", machineId, display: "main" }
        : { kind: "app", machineId, appKey: computerAppIdentityKey(app) };
    const key = placeIdentityKey(place);
    f.enter(place);
    const release = retainRunPlacePicture(f.client, threadId, runId, true);
    const read = () => runPlacePicture(f.client, threadId);
    try {
      const socket = f.displays[0]!;
      socket.open();
      socket.receive({
        type: "display.state",
        state: "live",
        generation: 1,
        width: 720,
        height: 1280,
      });
      socket.displayFrame(1);
      expect(socket.sent).toContainEqual({ type: "display.ack", sequence: 1 });
      const first = attachRunPlaceDisplay(f.client, threadId, key)!;
      const second = attachRunPlaceDisplay(f.client, threadId, key)!;
      expect(f.displays).toHaveLength(1);
      const frames: DisplayFrame[] = [];
      first.onFrame((frame) => frames.push(frame));
      second.onFrame((frame) => frames.push(frame));
      socket.displayFrame(2);
      frames[0]!.done();
      expect(socket.sent).not.toContainEqual({ type: "display.ack", sequence: 2 });
      second.release();
      expect(socket.sent).toContainEqual({ type: "display.ack", sequence: 2 });
      reportRunPlacePicture(f.client, threadId, key, { kind: "drawn", width: 720, height: 1280 });
      expect(read()).toEqual({ placeKey: key, usable: true, fresh: true, aspect: 720 / 1280 });
      first.release();
      expect(socket.readyState).toBe(1);
      socket.displayFrame(3);
      expect(socket.sent).toContainEqual({ type: "display.ack", sequence: 3 });
      sharedDisplayStreams(f.client).suspend(true);
      expect(read()).toMatchObject({ usable: true, fresh: false });
      sharedDisplayStreams(f.client).suspend(false);
      const next = f.displays[1]!;
      next.open();
      expect(read()).toMatchObject({ usable: true, fresh: false });
      next.receive({
        type: "display.state",
        state: "live",
        generation: 1,
        width: 720,
        height: 1280,
      });
      next.displayFrame(1);
      expect(read()).toMatchObject({ usable: true, fresh: false });
      reportRunPlacePicture(f.client, threadId, key, { kind: "drawn", width: 720, height: 1280 });
      expect(read()).toMatchObject({ usable: true, fresh: true });
      reportRunPlacePicture(f.client, threadId, key, { kind: "cleared" });
      expect(read()).toMatchObject({ usable: false, fresh: false, aspect: 720 / 1280 });
      reportRunPlacePicture(f.client, threadId, "another-place", {
        kind: "drawn",
        width: 1,
        height: 1,
      });
      expect(read().usable).toBe(false);
      reportRunPlacePicture(f.client, threadId, key, { kind: "drawn", width: 720, height: 1280 });
      next.close(4003);
      reportRunPlacePicture(f.client, threadId, key, { kind: "drawn", width: 720, height: 1280 });
      expect(read().usable).toBe(false);
      f.update({ session: "authentication-required", user: null });
      clearRunPlacePictures(f.client);
      expect(read()).toEqual({ placeKey: null, usable: false, fresh: false, aspect: null });
    } finally {
      release();
      f.dispose();
    }
  },
);

it("keeps the same sleeping tab's picture through a replacement session and fences revocation", () => {
  const f = fixture();
  f.enter(browserPlace);
  const release = retainRunPlacePicture(f.client, threadId, runId, false);
  try {
    f.sockets[0]!.open();
    f.sockets[0]!.browserFrame();
    const tabs = f.client.browserTabs;
    const rows = tabs.sessionTabs(sessionId);
    replaceBrowserTabs(
      tabs,
      sessionId,
      rows.map((tab) => ({ ...tab, state: "suspended", documentId: null })),
    );
    const replacement = BrowserSessionIdSchema.parse("bsn_00000000-0000-4000-8000-000000000002");
    replaceBrowserTabs(
      tabs,
      sessionId,
      rows.map((tab) => ({
        ...tab,
        sessionId: replacement,
        state: "suspended",
        documentId: null,
      })),
    );
    const group = tabs.group(sessionId)!;
    tabs.applyGroups({ op: "begin", generation: "replacement" });
    tabs.applyGroups({ op: "rows", rows: [{ ...group, sessionId: replacement }] });
    tabs.applyGroups({ op: "end", revision: 0, count: 1, meta: {} });
    f.watch.reconcile(
      () => false,
      (session) => session === replacement,
    );
    expect(runPlacePicture(f.client, threadId)).toMatchObject({ usable: true, fresh: false });
    expect(f.sockets).toHaveLength(1);
    f.watch.reconcile(
      () => false,
      () => false,
    );
    expect(runPlacePicture(f.client, threadId)).toMatchObject({ usable: false, fresh: false });
  } finally {
    release();
    f.dispose();
  }
});

it.each(["phone", "app"] as const)("holds no %s display until decoding is available", (kind) => {
  const f = fixture(kind === "phone");
  const place: PlaceRef =
    kind === "phone"
      ? { kind: "phone", machineId, display: "main" }
      : { kind: "app", machineId, appKey: computerAppIdentityKey(app) };
  f.enter(place);
  const incapable = retainRunPlacePicture(f.client, threadId, runId, false);
  let capable = () => {};
  try {
    expect(f.displays).toHaveLength(0);
    expect(attachRunPlaceDisplay(f.client, threadId, placeIdentityKey(place))).toBeNull();
    capable = retainRunPlacePicture(f.client, threadId, runId, true);
    expect(f.displays).toHaveLength(1);
    const socket = f.displays[0]!;
    socket.open();
    capable();
    expect(socket.readyState).toBe(3);
    expect(attachRunPlaceDisplay(f.client, threadId, placeIdentityKey(place))).toBeNull();
  } finally {
    capable();
    incapable();
    f.dispose();
  }
});

it("requests a decodable picture after a delayed decoder attaches, coalescing repeated requests", () => {
  const f = fixture();
  const place: PlaceRef = { kind: "phone", machineId, display: "main" };
  f.enter(place);
  const release = retainRunPlacePicture(f.client, threadId, runId, true);
  try {
    const socket = f.displays[0]!;
    socket.open();
    const display = attachRunPlaceDisplay(f.client, threadId, placeIdentityKey(place))!;
    socket.displayFrame(1);
    const requests = () =>
      socket.sent.filter((message) => message.type === "display.keyframe").length;
    const before = requests();
    const stop = display.onFrame((frame) => frame.done());
    expect(requests()).toBe(before + 1);
    display.requestKeyframe();
    expect(requests()).toBe(before + 1);
    stop();
    display.release();
  } finally {
    release();
    f.dispose();
  }
});
