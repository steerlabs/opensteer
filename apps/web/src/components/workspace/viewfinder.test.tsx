// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createId, TabIdSchema, PlaceEnteredEventViewSchema } from "@opensteer/core";
import type { TabViewer } from "@opensteer/protocol";
import {
  rememberBrowserLastPicture,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { RunPlaceStore } from "@opensteer/client/host";
import { tabFixture, tabStoreFixture } from "@opensteer/client/test-support";
import { LivePlace } from "./viewfinder.js";
import { useRunPlacePicture } from "@opensteer/client/react";
import { RunPlacePictureScope } from "./run-place-picture.js";

function Picture({ client }: { readonly client: HostClient }) {
  const picture = useRunPlacePicture(client, threadId, runId, true, false);
  return (
    <RunPlacePictureScope
      decoding={null}
      enabled
      hostClient={client}
      picture={picture}
      threadId={threadId}
    >
      <LivePlace hostClient={client} threadId={threadId} runId={runId} />
    </RunPlacePictureScope>
  );
}

vi.mock("./workspace-context.js", () => ({
  useWorkspace: () => ({
    selection: { kind: "talk" },
    work: false,
    phone: false,
    dock: { open: true },
    highlight: { set() {} },
    nav: { showPlace() {} },
  }),
}));
vi.mock("./agent-cursors.js", () => ({ AgentCursors: () => null }));
vi.mock("../browser/browser-presenter.js", () => ({
  attachBrowserCanvas: () => () => {},
  drawnBrowserFrame: () => null,
  browserPicturePresentedEvent: "test-picture",
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});
const threadId = createId("thread"),
  runId = createId("run");
const sessionId = "bsn_00000000-0000-4000-8000-000000000001";
const tabs = [
  tabFixture({ tabId: TabIdSchema.parse("page-1") }),
  tabFixture({ tabId: TabIdSchema.parse("page-2") }),
  tabFixture({ tabId: TabIdSchema.parse("window-1"), kind: "window" }),
];
const entry = (sequence: string, tabId: string, site: string | null = "https://example.com") =>
  PlaceEnteredEventViewSchema.parse({
    type: "place.entered",
    eventId: createId("event"),
    environmentId: createId("environment"),
    sequence,
    runId,
    threadId,
    createdAt: "2026-11-02T13:00:00.000Z",
    data: { tabId, title: `Page ${sequence}`, site },
  });
it("keeps the card and its watch lease through Request waits, reconnects and republished tabs, then switches on the next entry", async () => {
  const store = new RunPlaceStore();
  store.accept(entry("1", "page-1"));
  let snapshot = {
    connection: "connected",
    session: "authenticated",
    user: { id: "person" },
    machines: [],
    browserProfiles: [],
    runQueue: [{ id: runId, threadId, status: "running" }],
    tabs: tabStoreFixture(tabs),
  } as unknown as HostSnapshot;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const viewers = new Map<string, TabViewer>();
  // Watching a Run's page first binds this device's view of it.
  const activateTab = vi.fn(async (tabId: string) => {
    const viewer = { kind: "page", sessionId, surfaceId: tabId } as TabViewer;
    viewers.set(tabId, viewer);
    notify();
    return viewer;
  });
  const release = vi.fn(),
    retain = vi.fn(() => release);
  const watchState = { status: "unavailable", frame: null, error: null };
  const noActivity: never[] = [];
  const client = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    activateTab,
    tabViewer: (tabId: string) => viewers.get(tabId) ?? null,
    runPlace: store.get,
    subscribeRunPlace: store.subscribe,
    browserWatchFrames: { get: () => null, subscribe: () => () => {} },
    browserFrames: { get: () => null, subscribe: () => () => {} },
    browserWatchState: () => watchState,
    subscribeBrowserWatch: () => () => {},
    retainBrowserWatch: retain,
    // The real store answers the same list until it changes.
    placeActivity: () => noActivity,
    subscribePlaceActivity: () => () => {},
  } as unknown as HostClient;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(<Picture client={client} />));
  const card = node.querySelector(".viewfinder");
  const canvas = node.querySelector("canvas");
  expect(card).not.toBeNull();
  expect(activateTab).toHaveBeenCalledExactlyOnceWith("page-1");
  expect(retain).toHaveBeenLastCalledWith(sessionId, "page-1", expect.anything());
  const leases = retain.mock.calls.length;
  for (const patch of [
    { runQueue: [{ id: runId, threadId, status: "waiting" }] },
    { connection: "connecting" },
    { connection: "connected", tabs: tabStoreFixture(tabs) },
  ]) {
    await act(async () => {
      snapshot = { ...snapshot, ...patch } as HostSnapshot;
      notify();
    });
    expect(node.querySelector(".viewfinder")).toBe(card);
    expect(node.querySelector("canvas")).toBe(canvas);
  }
  expect(retain).toHaveBeenCalledTimes(leases);

  await act(async () => store.accept(entry("3", "page-2")));
  expect(node.querySelector(".viewfinder")).toBe(card);
  expect(card!.getAttribute("aria-label")).toContain("Page 3");
  expect(node.querySelector("canvas")).not.toBe(canvas);
  expect(retain).toHaveBeenLastCalledWith(sessionId, "page-2", expect.anything());

  await act(async () => store.accept(entry("4", "window-1", null)));
  expect(node.querySelector(".viewfinder--native")).toBe(card);
  expect(card!.getAttribute("aria-label")).toContain("Page 4");
  // No session to show yet: the frame names the kind of place, never an empty box.
  expect(node.querySelector(".place-canvas--hidden")).not.toBeNull();
  expect(node.querySelector(".viewfinder__frame > .viewfinder__glyph")).not.toBeNull();
  await act(async () => store.end(runId));
  expect(node.querySelector(".viewfinder")).toBeNull();
});

it("restores a tab's picture that only the opened page kept", async () => {
  const store = new RunPlaceStore();
  store.accept(entry("1", "page-1"));
  const snapshot = {
    connection: "connected",
    session: "authenticated",
    user: { id: "person" },
    machines: [],
    tabs: tabStoreFixture(tabs),
    runQueue: [{ id: runId, threadId, status: "running" }],
  } as unknown as HostSnapshot;
  const frames = () => ({ get: () => null, subscribe: () => () => {}, invalidationKey: () => 1 });
  const noActivity: never[] = [];
  const client = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    tabViewer: (tabId: string) => ({ kind: "page", sessionId, surfaceId: tabId }),
    runPlace: store.get,
    subscribeRunPlace: store.subscribe,
    browserWatchFrames: frames(),
    browserFrames: frames(),
    browserWatchState: () => ({ status: "connecting", frame: null, error: null }),
    subscribeBrowserWatch: () => () => {},
    retainBrowserWatch: () => () => {},
    placeActivity: () => noActivity,
    subscribePlaceActivity: () => () => {},
  } as unknown as HostClient;
  const surfaceId = TabIdSchema.parse("page-1");
  rememberBrowserLastPicture(client.browserFrames, sessionId, surfaceId, {
    data: new Uint8Array([1, 2, 3]),
    header: { surfaceId, encoding: "jpeg", rasterWidth: 1280, rasterHeight: 800 },
  } as unknown as Parameters<typeof rememberBrowserLastPicture>[3]);
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root!.render(<Picture client={client} />));
  expect(node.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/u);
});
