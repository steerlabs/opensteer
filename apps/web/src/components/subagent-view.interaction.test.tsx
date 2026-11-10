// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { NodeEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppShell } from "./app-shell.js";
import { SubagentRoute } from "./subagent-view.js";
import { ThreadRoute } from "./thread-view.js";
import { ToastProvider } from "./toast.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A phone viewing the parent must not keep receiving a subagent's own events:
// the view holds one watch while it is open and gives it up when it closes.
it("holds one node watch while a subagent is open and releases it on leaving", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    Object.assign(new EventTarget(), {
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
    }),
  );
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  const snapshot = client.getSnapshot();
  const thread = snapshot.threads.find(({ title }) => title === "Subagents everywhere")!;
  const nodes = snapshot.transcripts[thread.id]!.filter(
    (entry): entry is NodeEntry => entry.kind === "node",
  );
  const [first, second] = ["Research the reference", "Trace the client"].map((title) =>
    nodes.find((node) => node.title === title)!,
  );
  const released: string[] = [];
  const watchNode = client.watchNode.bind(client);
  const watches = vi.spyOn(client, "watchNode").mockImplementation((threadId, nodeId) => {
    const watch = watchNode(threadId, nodeId);
    return {
      ...watch,
      release: () => {
        released.push(nodeId);
        watch.release();
      },
    };
  });
  let navigate: NavigateFunction = () => undefined;
  function Navigator() {
    navigate = useNavigate();
    return null;
  }
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.push(root);
  const path = (nodeId: string) => `/threads/${thread.id}/subagents/${nodeId}`;
  await act(async () =>
    root.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path(first!.nodeId)]}>
          <Navigator />
          <Routes>
            <Route element={<AppShell hostClient={client} loadError={null} />}>
              <Route path="threads/:threadId" element={<ThreadRoute />} />
              <Route path="threads/:threadId/subagents/:nodeId" element={<SubagentRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
  await vi.waitFor(() => expect(node.querySelector(".subagent-view__steps")).not.toBeNull(), {
    timeout: 5_000,
  });
  expect(node.querySelector("h1")?.textContent).toBe("Research the reference");
  expect(node.querySelector('[role="note"]')?.textContent).toContain("Runs on its own");
  const live = () => watches.mock.calls.length - released.length;
  expect(live()).toBe(1);

  await act(async () => navigate(path(second!.nodeId)));
  expect(released).toContain(first!.nodeId);
  expect(watches.mock.calls.at(-1)?.[1]).toBe(second!.nodeId);
  expect(live()).toBe(1);

  await act(async () => navigate(`/threads/${thread.id}`));
  expect(released).toContain(second!.nodeId);
  expect(live()).toBe(0);
});
