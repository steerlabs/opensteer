// @vitest-environment happy-dom
import { withBrowserTabStore } from "@opensteer/client/test-support";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createId, PlaceEnteredEventViewSchema } from "@opensteer/core";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { RunPlaceStore } from "@opensteer/client/host";
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
const surfaceId = "srf_00000000-0000-4000-8000-000000000001";
const entry = (sequence = "1", session = sessionId, surface = surfaceId) =>
  PlaceEnteredEventViewSchema.parse({
    type: "place.entered",
    eventId: createId("event"),
    environmentId: createId("environment"),
    sequence,
    runId,
    threadId,
    workspaceId: createId("workspace"),
    createdAt: "2026-11-02T13:00:00.000Z",
    data: {
      place: { kind: "browser", sessionId: session, surfaceId: surface },
      title: `Page ${sequence}`,
      site: "https://example.com",
    },
  });
it("keeps the card and its watch lease across independent inventories, Request waits and reconnect, then switches on the next entry", async () => {
  const store = new RunPlaceStore();
  store.accept(entry());
  let snapshot = {
    connection: "connected",
    session: "authenticated",
    machines: [],
    browserSessions: [],
    workspaceTabs: [],
    runQueue: [{ id: runId, threadId, status: "running" }],
  } as unknown as HostSnapshot;
  snapshot = withBrowserTabStore(snapshot);
  const listeners = new Set<() => void>();
  const release = vi.fn(),
    retain = vi.fn(() => release);
  const watchState = { status: "unavailable", frame: null, error: null };
  const client = {
    get browserTabs() {
      return snapshot.browserTabs!;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    runPlace: store.get,
    subscribeRunPlace: store.subscribe,
    retainBrowserWatch: retain,
    browserWatchFrames: { subscribe: () => () => {} },
    placeActivity: () => [],
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
  expect(retain).toHaveBeenCalledTimes(1);
  for (const patch of [
    { browserSessions: [{ id: sessionId, state: "starting" }] },
    { workspaceTabs: [{ tabs: [{ id: surfaceId, sessionId: "different-session" }] }] },
    { browserSessions: [] },
    { runQueue: [{ id: runId, threadId, status: "waiting" }] },
    { connection: "connecting" },
    { connection: "connected", workspaceTabs: [] },
  ]) {
    await act(async () => {
      snapshot = withBrowserTabStore({ ...snapshot, ...patch } as HostSnapshot);
      listeners.forEach((listener) => listener());
    });
    expect(node.querySelector(".viewfinder")).toBe(card);
    expect(node.querySelector("canvas")).toBe(canvas);
    expect(release).not.toHaveBeenCalled();
  }
  const replacement = "bsn_00000000-0000-4000-8000-000000000002";
  await act(async () => {
    snapshot = {
      ...snapshot,
      browserSessions: [
        { id: replacement, state: "ready", tabCatalog: { tabs: [{ id: surfaceId }] } },
      ],
    } as unknown as HostSnapshot;
    snapshot = withBrowserTabStore(snapshot);
    listeners.forEach((listener) => listener());
  });
  expect(store.get(runId)!.data.place).toMatchObject({ sessionId });
  expect(node.querySelector(".viewfinder")).toBe(card);
  expect(node.querySelector("canvas")).not.toBe(canvas);
  expect(retain).toHaveBeenLastCalledWith(
    "bsn_00000000-0000-4000-8000-000000000002",
    surfaceId,
    expect.anything(),
  );
  await act(async () =>
    store.accept(entry("3", sessionId, "srf_00000000-0000-4000-8000-000000000002")),
  );
  expect(node.querySelector(".viewfinder")).toBe(card);
  expect(card!.getAttribute("aria-label")).toContain("Page 3");
  expect(node.querySelector("canvas")).not.toBe(canvas);
  await act(async () =>
    store.accept(
      PlaceEnteredEventViewSchema.parse({
        ...entry("4"),
        data: {
          place: { kind: "app", machineId: createId("runner"), appKey: "com.apple.notes" },
          title: "Notes",
          site: null,
        },
      }),
    ),
  );
  expect(node.querySelector(".viewfinder--native")).toBe(card);
  expect(card!.getAttribute("aria-label")).toContain("Notes");
  // No session to show yet: the frame names the kind of place, never an empty box.
  expect(node.querySelector(".viewfinder__native")).toBeNull();
  expect(node.querySelector(".viewfinder__frame > .viewfinder__glyph")).not.toBeNull();
  await act(async () => store.end(runId));
  expect(node.querySelector(".viewfinder")).toBeNull();
});
