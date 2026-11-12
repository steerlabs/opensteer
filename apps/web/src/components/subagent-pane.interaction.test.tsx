// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate, type NavigateFunction } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import type { NodeEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppShell } from "./app-shell.js";
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

// A device viewing the parent must not keep receiving a subagent's own events:
// the pane holds one watch while it is open and gives it up when it closes,
// and the conversation under it stays where the reader left it.
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
  const path = (nodeId: string) => `/tasks/${thread.id}?subagent=${nodeId}`;
  await act(async () =>
    root.render(
      <ToastProvider>
        <MemoryRouter initialEntries={[path(first!.nodeId)]}>
          <Navigator />
          <Routes>
            <Route element={<AppShell hostClient={client} loadError={null} />}>
              <Route path="threads/:threadId" element={<ThreadRoute />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    ),
  );
  await vi.waitFor(
    () =>
      expect(
        node.querySelector('.subagent-pane [aria-label="Steps"] .turn__content'),
      ).not.toBeNull(),
    { timeout: 5_000 },
  );
  expect(node.querySelector(".subagent-pane__title")?.textContent).toBe("Research the reference");
  expect(node.querySelector('.subagent-pane [role="note"]')?.textContent).toContain(
    "You can watch it, not message it.",
  );
  // Pushed over the conversation, which stays mounted with its scroll position.
  expect(node.querySelector(".thread--pushed .transcript-scroll")).not.toBeNull();
  const live = () => watches.mock.calls.length - released.length;
  expect(live()).toBe(1);

  await act(async () => navigate(path(second!.nodeId)));
  expect(released).toContain(first!.nodeId);
  expect(watches.mock.calls.at(-1)?.[1]).toBe(second!.nodeId);
  expect(live()).toBe(1);

  await act(async () => navigate(`/tasks/${thread.id}`));
  expect(released).toContain(second!.nodeId);
  expect(live()).toBe(0);
  expect(node.querySelector(".subagent-pane")).toBeNull();
});
