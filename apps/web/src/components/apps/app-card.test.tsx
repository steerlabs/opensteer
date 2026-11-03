// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createId, type OpensteerApp } from "@opensteer/core";
import type { AppEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppCard } from "./app-card.js";
import { TranscriptHostClientContext } from "../attachments/message-attachments.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.spyOn(HTMLIFrameElement.prototype, "contentWindow", "get").mockReturnValue({
    postMessage: vi.fn(),
  } as unknown as Window);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const appId = "app_11111111-1111-4111-8111-111111111111";
const appUrl = `https://host.test/v1/apps/${appId}/dark/${"a".repeat(43)}/`;
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
      <TranscriptHostClientContext value={client}>
        {Array.from({ length: count }, (_, index) => (
          <AppCard key={index} entry={entry} />
        ))}
      </TranscriptHostClientContext>,
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
  expect(frame.hasAttribute("loading")).toBe(false);
  expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(frame.style.height).toBe("280px");
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: { type: "opensteer-app:ready" },
      }),
    ),
  );
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
it("reloads already-rendered cards on republish and expands the same app instance", async () => {
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
    url: appUrl,
  }));
  const container = await mount(client, 2);
  expect(read).toHaveBeenCalledTimes(2);
  const original = container.querySelector("iframe");
  latest = 2;
  snapshot = { ...snapshot, appVersions: { [appId]: 2 } };
  await act(async () => {
    for (const listener of listeners) listener();
  });
  expect([...container.querySelectorAll("iframe")].map((frame) => frame.src)).toEqual([
    appUrl,
    appUrl,
  ]);
  expect(container.querySelector(".app-card__header")?.textContent).toContain("Budget 2");
  expect(container.querySelector("iframe")).not.toBe(original);
  const frame = container.querySelector("iframe")!;
  const toggle = container.querySelector("button") as HTMLButtonElement;
  toggle.focus();
  await act(() => toggle.click());
  expect(read).toHaveBeenCalledTimes(4);
  expect(container.querySelector('[role="dialog"] iframe')).toBe(frame);
  expect(document.activeElement).toBe(toggle);
  await act(() => toggle.click());
  expect(container.querySelector("iframe")).toBe(frame);
  await act(() => toggle.click());
  await act(() =>
    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(toggle);
  await act(() => toggle.click());
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: { type: "opensteer-app:escape" },
      }),
    ),
  );
  expect(container.querySelector('[role="dialog"]')).toBeNull();
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
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    await act(async () => {
      document.documentElement.style.colorScheme = "light";
    });
    expect(post).toHaveBeenCalledWith({ type: "opensteer-app:theme", theme: "light" }, "*");
    expect(container.querySelector("iframe")).toBe(frame);
    expect(read).toHaveBeenCalledExactlyOnceWith(appId, "dark", expect.any(AbortSignal));
  } finally {
    await act(async () => {
      document.documentElement.style.colorScheme = previous;
    });
  }
});

it("retries a document that loaded without its bootstrap, ignoring forged ready messages", async () => {
  const client = new MockHostClient();
  const read = vi
    .spyOn(client, "viewApp")
    .mockResolvedValueOnce({ app: metadata, url: "https://host.test/app?expired" })
    .mockResolvedValue({ app: metadata, url: "https://host.test/app?fresh" });
  const container = await mount(client);
  const expired = container.querySelector("iframe")!;
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "null",
        data: { type: "opensteer-app:ready" },
      }),
    ),
  );
  await act(() => expired.dispatchEvent(new Event("load")));
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await act(async () =>
    (container.querySelector('[role="alert"] button') as HTMLButtonElement).click(),
  );
  const fresh = container.querySelector("iframe")!;
  expect(fresh.src).toBe("https://host.test/app?fresh");
  await act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        source: fresh.contentWindow,
        origin: "null",
        data: { type: "opensteer-app:ready" },
      }),
    ),
  );
  await act(() => fresh.dispatchEvent(new Event("load")));
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});
