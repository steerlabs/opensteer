// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createId, TabIdSchema, PlaceEnteredEventViewSchema } from "@opensteer/core";
import type { TabViewer } from "@opensteer/protocol";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { RunPlaceStore } from "@opensteer/client/host";
import { tabFixture, tabStoreFixture } from "@opensteer/client/test-support";
import { LivePlace } from "./viewfinder.js";

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
vi.mock("../computer-watch.js", () => ({ ComputerWatchView: () => null }));
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
    retainBrowserWatch: retain,
    browserWatchFrames: { subscribe: () => () => {} },
    // The real store answers the same list until it changes.
    placeActivity: () => noActivity,
    subscribePlaceActivity: () => () => {},
    browserWatchState: () => watchState,
    subscribeBrowserWatch: () => () => {},
  } as unknown as HostClient;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(<LivePlace hostClient={client} threadId={threadId} runId={runId} />),
  );
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
    expect(release).not.toHaveBeenCalled();
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
  expect(node.querySelector(".viewfinder__native")).toBeNull();
  expect(node.querySelector(".viewfinder__frame > .viewfinder__glyph")).not.toBeNull();
  await act(async () => store.end(runId));
  expect(node.querySelector(".viewfinder")).toBeNull();
});
