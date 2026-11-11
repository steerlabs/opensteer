// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostClient,
  NodeDetailSnapshot,
  NodeDetailSubscription,
} from "@opensteer/client/host";
import { useNodeWatch } from "./node-watch.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

const base: NodeDetailSnapshot = {
  entries: [],
  error: null,
  hasMore: false,
  loadingOlder: false,
  node: null,
  nodeId: "node_a",
  status: "loading",
  threadId: "thread_a",
};

/** A Host client whose node watches the test moves by hand. */
function host() {
  const watches: {
    set: (snapshot: NodeDetailSnapshot) => void;
    release: ReturnType<typeof vi.fn>;
  }[] = [];
  const client = {
    watchNode: () => {
      let current = base;
      const listeners = new Set<() => void>();
      const release = vi.fn(() => {
        current = { ...current, entries: [], status: "closed" };
        for (const listener of listeners) listener();
      });
      watches.push({
        release,
        set: (snapshot) => {
          current = snapshot;
          for (const listener of listeners) listener();
        },
      });
      return {
        getSnapshot: () => current,
        loadOlder: async () => undefined,
        release,
        retry: () => undefined,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      } satisfies NodeDetailSubscription;
    },
  } as unknown as HostClient;
  return { client, watches };
}

function mount(client: HostClient) {
  let shown: NodeDetailSnapshot | null = null;
  function Probe(props: { readonly active: boolean }): ReactNode {
    shown = useNodeWatch(client, "thread_a", "node_a", props.active).snapshot;
    return null;
  }
  const root = createRoot(document.createElement("div"));
  roots.push(root);
  return {
    shown: () => shown,
    show: (active: boolean) => act(() => root.render(<Probe active={active} />)),
  };
}

// Failure: a phone keeps receiving a subagent's steps after it looked away,
// or its steps empty out under the reader the moment the watch is released.
describe("a subagent's watch", () => {
  it("is held only while active, and keeps the last steps drawn through a new watch", () => {
    const { client, watches } = host();
    const view = mount(client);
    view.show(false);
    expect(watches).toHaveLength(0);
    view.show(true);
    expect(watches).toHaveLength(1);
    const ready: NodeDetailSnapshot = { ...base, hasMore: true, status: "ready" };
    act(() => watches[0]!.set(ready));
    expect(view.shown()).toBe(ready);
    view.show(false);
    expect(watches[0]!.release).toHaveBeenCalledOnce();
    expect(view.shown()).toBe(ready);
    view.show(true);
    expect(watches).toHaveLength(2);
    expect(view.shown()).toBe(ready);
    const next: NodeDetailSnapshot = { ...ready, hasMore: false };
    act(() => watches[1]!.set(next));
    expect(view.shown()).toBe(next);
  });
});
