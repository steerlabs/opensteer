// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createId, type OpensteerApp } from "@opensteer/core";
import type { AppEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppCard } from "./app-card.js";
import { AttachmentReader } from "../attachments/message-attachments.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
beforeEach(() => vi.stubGlobal("IntersectionObserver", undefined));
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const appId = "app_11111111-1111-4111-8111-111111111111";
const entry: AppEntry = {
  appId,
  createdAt: new Date().toISOString(),
  id: "app:event",
  kind: "app",
  runId: createId("run"),
  title: "Budget",
  version: 1,
};
const metadata: OpensteerApp = {
  id: appId,
  workspaceId: createId("workspace"),
  threadId: createId("thread"),
  runId: createId("run"),
  title: "Budget",
  latestVersion: 1,
  createdAt: entry.createdAt,
  updatedAt: entry.createdAt,
};
async function mount(client: MockHostClient, count = 1) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <AttachmentReader value={client}>
        {Array.from({ length: count }, (_, index) => (
          <AppCard key={index} entry={entry} />
        ))}
      </AttachmentReader>,
    ),
  );
  return container;
}
it("uses an opaque sandbox, caps tall inline content, ignores foreign messages, and stays readable without height reports", async () => {
  const client = new MockHostClient();
  vi.spyOn(client, "viewApp").mockResolvedValue({
    app: metadata,
    url: "https://host.test/app?version=1",
  });
  const container = await mount(client);
  const frame = container.querySelector("iframe")!;
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-popups");
  expect(frame.getAttribute("loading")).toBe("lazy");
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.style.height).toBe("280px");
  await act(() => frame.dispatchEvent(new Event("load")));
  expect(container.textContent).not.toContain("Loading app");
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: { type: "opensteer-app:size", height: 30_000 },
      }),
    ),
  );
  expect(frame.style.height).toBe("640px");
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "null",
        data: { type: "opensteer-app:size", height: 160 },
      }),
    ),
  );
  expect(frame.style.height).toBe("640px");
});
it("reloads every already-rendered card on republish and mints a fresh view for full-screen", async () => {
  const client = new MockHostClient();
  let snapshot = client.getSnapshot();
  let latest = 1;
  const listeners = new Set<() => void>();
  vi.spyOn(client, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(client, "getSnapshot").mockImplementation(() => snapshot);
  const read = vi.spyOn(client, "viewApp").mockImplementation(async () => ({
    app: { ...metadata, title: `Budget ${latest}`, latestVersion: latest },
    url: `https://host.test/app?version=${latest}`,
  }));
  const container = await mount(client, 2);
  expect(read).toHaveBeenCalledTimes(2);
  latest = 2;
  snapshot = { ...snapshot, appVersions: { [appId]: 2 } };
  await act(async () => {
    for (const listener of listeners) listener();
  });
  expect([...container.querySelectorAll("iframe")].map((frame) => frame.src)).toEqual([
    "https://host.test/app?version=2",
    "https://host.test/app?version=2",
  ]);
  expect(container.querySelector(".app-card__header")?.textContent).toContain("Budget 2");
  await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
  expect(read).toHaveBeenCalledTimes(5);
  expect(container.querySelector('[role="dialog"] iframe')).not.toBeNull();
});
it("offers retry when a view read fails", async () => {
  const client = new MockHostClient();
  vi.spyOn(client, "viewApp")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({ app: metadata, url: "https://host.test/app" });
  const container = await mount(client);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not load");
  await act(async () =>
    (container.querySelector('[role="alert"] button') as HTMLButtonElement).click(),
  );
  expect(container.querySelector("iframe")).not.toBeNull();
});

it("passes a theme change to the existing frame without reloading the interactive app", async () => {
  const client = new MockHostClient();
  const read = vi
    .spyOn(client, "viewApp")
    .mockResolvedValue({ app: metadata, url: "https://host.test/app" });
  const previous = document.documentElement.style.colorScheme;
  try {
    document.documentElement.style.colorScheme = "dark";
    const container = await mount(client);
    const frame = container.querySelector("iframe")!;
    await act(async () => {
      document.documentElement.style.colorScheme = "light";
    });
    expect(container.querySelector("iframe")).toBe(frame);
    expect(read).toHaveBeenCalledExactlyOnceWith(appId, "dark", expect.any(AbortSignal));
  } finally {
    document.documentElement.style.colorScheme = previous;
  }
});
