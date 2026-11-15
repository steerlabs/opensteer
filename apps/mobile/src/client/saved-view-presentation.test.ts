import { MemoryPrivateFilesystem } from "@opensteer/client/test-support";
import { SavedViewCache } from "./saved-view-cache.js";
import { createId } from "@opensteer/core";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { MockHostClient } from "@opensteer/client/mock";
import {
  type HostClient,
  type HostSnapshot,
  type SavedHostView,
  type SavedViewScope,
  type SavedViewStore,
  createMemorySavedViews,
} from "@opensteer/client/host";
import { afterEach, expect, it, vi } from "vitest";
import { SavedViewPresentation } from "./saved-view-presentation.js";
function presentation(options: { readonly store: SavedViewStore; readonly now?: () => Date }) {
  return new SavedViewPresentation({
    cache: new SavedViewCache({
      store: options.store,
      files: new MemoryPrivateFilesystem(),
      directory: "/private/denials",
    }),
    ...(options.now ? { now: options.now } : {}),
  });
}
const scope = (): SavedViewScope => ({
  schema: 1,
  epoch: hostApiVersion,
  loginId: globalThis.crypto.randomUUID(),
  hostIdentity: {
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
  },
});
afterEach(() => vi.useRealTimers());
async function fixture() {
  const mock = new MockHostClient({ latencyMs: 0 });
  await mock.load();
  let snapshot: HostSnapshot = {
    ...mock.getSnapshot(),
    savedViewReadiness: { tasksReady: false },
  };
  const listeners = new Set<() => void>();
  const client = new Proxy(mock, {
    get(target, property) {
      if (property === "getSnapshot") return () => snapshot;
      if (property === "subscribe")
        return (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as HostClient;
  const s = scope();
  const saved: SavedHostView = {
    ...s,
    userId: snapshot.user!.id,
    capturedAt: "2026-10-29T00:00:00.000Z",
    tasks: [],
  };
  const publish = (patch: Partial<HostSnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    mock,
    client,
    s,
    saved,
    publish,
    listeners,
    snapshot: () => snapshot,
    dispose: () => mock.dispose(),
  };
}
it("loads in parallel, replaces surfaces independently with fresh-empty and never falls back", async () => {
  const f = await fixture(),
    store = createMemorySavedViews();
  await store.write(f.saved, () => true);
  const controller = presentation({ store });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  await vi.waitFor(() => expect(controller.getSnapshot().tasks.source).toBe("saved"));
  f.publish({
    savedViewReadiness: { tasksReady: true },
    tasks: {
      entries: [],
      window: { byteCount: 2, hasMore: false, itemCount: 0, nextBefore: null, totalItems: 0 },
    },
  });
  expect(controller.getSnapshot().tasks.source).toBe("live");
  f.publish({
    savedViewReadiness: { tasksReady: true },
  });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  controller.dispose();
  f.dispose();
});
it("debounces projection changes for two seconds and distinguishes offline/unavailable labels without claiming health", async () => {
  const f = await fixture(),
    store = createMemorySavedViews();
  await store.write(f.saved, () => true);
  const write = vi.spyOn(store, "write"),
    controller = presentation({ store });
  controller.select(f.s.hostIdentity.deploymentId, f.s, () => true);
  controller.attach(f.client);
  await vi.waitFor(() => expect(controller.getSnapshot().tasks.source).toBe("saved"));
  controller.connection("offline", false);
  expect(controller.getSnapshot().tasks).toMatchObject({ label: "Offline · Saved view" });
  controller.connection("online", true);
  expect(controller.getSnapshot().tasks).toMatchObject({ label: "Unavailable · Saved view" });
  controller.connection("online", false);
  expect(controller.getSnapshot().tasks).toMatchObject({ label: "Updating…" });
  vi.useFakeTimers();
  f.publish({
    savedViewReadiness: { tasksReady: true },
  });
  await vi.advanceTimersByTimeAsync(1_999);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledTimes(1);
  controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
  f.dispose();
});
