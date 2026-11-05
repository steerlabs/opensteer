// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createId, type OpensteerApp } from "@opensteer/core";
import type { AppEntry } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { AppCard } from "./app-card.js";
import { TranscriptHostClientContext } from "../attachments/message-attachments.js";
import { ToastProvider } from "../toast.js";
import type { WorkspaceNavigation } from "../workspace/navigation.js";
import { WorkspaceProvider } from "../workspace/workspace-context.js";
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
async function mount(
  client: MockHostClient,
  count = 1,
  frame: (card: ReactNode) => ReactNode = (card) => card,
) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      frame(
        <TranscriptHostClientContext value={client}>
          {Array.from({ length: count }, (_, index) => (
            <AppCard key={index} entry={entry} />
          ))}
        </TranscriptHostClientContext>,
      ),
    ),
  );
  return container;
}
const tab = {
  appId,
  title: "Budget",
  threadId: metadata.threadId,
  workspaceId: metadata.workspaceId,
  latestVersion: 1,
  openedAt: entry.createdAt,
};
/** A workspace around the card and a Host whose open tabs the test moves. */
function inWorkspace(client: MockHostClient) {
  let snapshot = client.getSnapshot();
  const listeners = new Set<() => void>();
  vi.spyOn(client, "subscribe").mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  vi.spyOn(client, "getSnapshot").mockImplementation(() => snapshot);
  vi.spyOn(client, "viewApp").mockResolvedValue({ app: metadata, url: appUrl });
  const showPlace = vi.fn();
  const nav = { showPlace } as unknown as WorkspaceNavigation;
  return {
    frame: (card: ReactNode) => (
      <ToastProvider>
        <MemoryRouter>
          <WorkspaceProvider attention={0} nav={nav} openDrawer={() => undefined}>
            {card}
          </WorkspaceProvider>
        </MemoryRouter>
      </ToastProvider>
    ),
    setOpen: async (open: boolean) => {
      snapshot = { ...snapshot, appTabs: open ? [tab] : [] };
      await act(async () => {
        for (const listener of listeners) listener();
      });
    },
    showPlace,
  };
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
it("reloads already-rendered cards on republish", async () => {
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
});
it("opens as a tab at once, runs no second copy there, and comes back live when the tab closes", async () => {
  const client = new MockHostClient();
  const { frame, setOpen, showPlace } = inWorkspace(client);
  const opened = Promise.withResolvers<void>();
  const open = vi.spyOn(client, "openAppTab").mockReturnValue(opened.promise);
  const container = await mount(client, 1, frame);
  expect(container.querySelector("iframe")).not.toBeNull();
  await act(async () =>
    container.querySelector<HTMLButtonElement>(".app-card__header button")!.click(),
  );
  expect(open).toHaveBeenCalledExactlyOnceWith(appId);
  expect(showPlace).toHaveBeenCalledExactlyOnceWith({ kind: "opensteer-app", appId });
  await setOpen(true);
  opened.resolve();
  expect(container.querySelector("iframe")).toBeNull();
  expect(container.querySelector(".app-card__title")?.textContent).toBe("Budget");
  showPlace.mockClear();
  await act(async () => container.querySelector<HTMLButtonElement>(".app-card__go")!.click());
  expect(showPlace).toHaveBeenCalledExactlyOnceWith({ kind: "opensteer-app", appId });
  await setOpen(false);
  expect(container.querySelector("iframe")?.src).toBe(appUrl);
});
it("says why an open failed and leaves the running card usable", async () => {
  const client = new MockHostClient();
  const { frame } = inWorkspace(client);
  const open = vi
    .spyOn(client, "openAppTab")
    .mockRejectedValue(new Error("This Host does not know app tabs."));
  const container = await mount(client, 1, frame);
  const running = container.querySelector("iframe");
  const button = container.querySelector<HTMLButtonElement>(".app-card__header button")!;
  await act(async () => button.click());
  expect(document.querySelector(".toast")?.textContent).toContain("does not know app tabs");
  expect(container.querySelector("iframe")).toBe(running);
  expect(button.disabled).toBe(false);
  await act(async () => button.click());
  expect(open).toHaveBeenCalledTimes(2);
});
it("stays inline where there is no stage to open it in", async () => {
  const client = new MockHostClient();
  vi.spyOn(client, "viewApp").mockResolvedValue({ app: metadata, url: appUrl });
  vi.spyOn(client, "getSnapshot").mockReturnValue({ ...client.getSnapshot(), appTabs: [tab] });
  const container = await mount(client);
  expect(container.querySelector("iframe")).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
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
