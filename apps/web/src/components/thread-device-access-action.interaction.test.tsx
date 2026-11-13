// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { useHostSnapshot } from "@opensteer/client/react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { ShellContext } from "./app-shell.js";
import { RequestStack, useRequestDock } from "./input-surface.js";

const laptopId = "rnr_33333333-3333-4333-8333-333333333333";
vi.mock("./computers/here.js", () => ({ useHereId: () => laptopId }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let host: MockHostClient | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.dispose();
  host = null;
  document.body.replaceChildren();
});

it("keeps the missing macOS grant on screen after Turn it on resolves the Request", async () => {
  const client = new MockHostClient({ latencyMs: 0, devices: "seeded" });
  host = client;
  const request = Object.values(client.getSnapshot().requests)
    .flat()
    .find((entry) => entry.payload.kind === "device.access")!;
  const threadId = request.originatingThreadId;
  let accessibility: "denied" | "granted" = "denied";
  const bridge = {
    checkFullDiskAccess: async () => ({ granted: true }),
    computerUsePermissionsGet: async () => ({ accessibility, screenRecording: "granted" }),
  } as unknown as OpensteerDesktopBridge;

  function Dock() {
    const { snapshot } = useHostSnapshot(client, () => false);
    const shell = {
      desktopBridge: bridge,
      hostClient: client,
      reportActionError: () => undefined,
      snapshot,
    } as unknown as ShellContext;
    return (
      <ShellContext.Provider value={shell}>
        <Stack threadId={threadId} />
      </ShellContext.Provider>
    );
  }
  function Stack({ threadId }: { readonly threadId: string }) {
    const { snapshot } = useHostSnapshot(client, () => false);
    const dock = useRequestDock(
      threadId,
      (snapshot.requests[threadId] ?? []).filter((entry) => entry.id === request.id),
    );
    return (
      <RequestStack
        disabled={false}
        items={dock.items}
        onOpen={dock.setOpenId}
        openId={dock.openId}
        threadId={threadId}
      />
    );
  }

  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <Dock />
      </MemoryRouter>,
    ),
  );
  const text = () => node.textContent ?? "";
  const button = (name: string) =>
    [...node.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);
  expect(button("Turn it on")).toBeDefined();
  await act(async () => button("Turn it on")!.click());

  await vi.waitFor(
    () => {
      const pending = Object.values(client.getSnapshot().requests)
        .flat()
        .some((entry) => entry.id === request.id);
      if (pending) throw new Error("The Request was never resolved");
      if (!text().includes("Apps is on for")) throw new Error("The macOS follow-up never showed");
    },
    { timeout: 2_000 },
  );
  expect(button("Turn it on")).toBeUndefined();
  expect(text()).toContain("macOS still has to allow it here.");

  // It turns green when macOS allows it, and stays until the person is done.
  accessibility = "granted";
  await act(async () => window.dispatchEvent(new Event("focus")));
  await vi.waitFor(
    () => {
      if (!text().includes("macOS allows it now.")) throw new Error("The grant never turned green");
    },
    { timeout: 2_000 },
  );
  await act(async () => button("Done")!.click());
  expect(text()).not.toContain("Apps is on for");
});
