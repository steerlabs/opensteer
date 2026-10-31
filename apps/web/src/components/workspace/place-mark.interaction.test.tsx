// @vitest-environment happy-dom

import { act } from "react";
import { readFileSync } from "node:fs";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostClient, HostConnectionState } from "@opensteer/client/host";
import { PlaceMark } from "./place-mark.js";
import { ProfileAvatar } from "./identity.js";

vi.mock("../computer-apps/computer-use-section.js", () => ({ AppMark: () => null }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Failure inventory: rejected/null reads, disconnected reads, reconnect with
// the same reference, cross-client cache reuse, stale completion, and cleanup.
const blue = "data:image/png;base64,Ymx1ZQ==";
const green = "data:image/png;base64,Z3JlZW4=";
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(32);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function host(read = vi.fn<HostClient["readBrowserTabIcon"]>(async () => blue)) {
  let connection: HostConnectionState = "connected";
  const listeners = new Set<() => void>();
  const client = {
    readBrowserTabIcon: read,
    getSnapshot: () => ({ connection }),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as HostClient;
  const connect = async (next: HostConnectionState) => {
    await act(async () => {
      connection = next;
      for (const listener of listeners) listener();
    });
  };
  return { client, connect, listeners, read };
}

async function mount(client: HostClient, ref: string | null = "same-ref", copies = 1) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const render = async (nextClient = client, nextRef = ref) => {
    await act(async () =>
      root?.render(
        <>
          {Array.from({ length: copies }, (_, index) => (
            <PlaceMark
              key={index}
              hostClient={nextClient}
              icon={{ kind: "site", sessionId: "same-session", ref: nextRef }}
            />
          ))}
        </>,
      ),
    );
  };
  await render();
  return { container, render };
}

it("keeps the mark neutral before an icon reference exists and while its read is pending", async () => {
  let finish!: (src: string) => void;
  const read = vi.fn<HostClient["readBrowserTabIcon"]>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const owner = host(read);
  const { container, render } = await mount(owner.client, null);
  expect(container.textContent).toBe("");
  expect(container.querySelector(".site-mark > svg")).not.toBeNull();
  expect(read).not.toHaveBeenCalled();
  await render(owner.client, "new-ref");
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("");
  let finishDecode!: () => void;
  vi.spyOn(HTMLImageElement.prototype, "decode").mockReturnValue(
    new Promise<void>((resolve) => {
      finishDecode = resolve;
    }),
  );
  await act(async () => finish(blue));
  const image = container.querySelector("img")!;
  Object.defineProperty(image, "naturalWidth", { value: 32 });
  expect(image.getAttribute("src")).toBe(blue);
  expect(image.classList.contains("is-ready")).toBe(false);
  await act(async () => image.dispatchEvent(new Event("load")));
  await act(async () => finishDecode());
  expect(image.classList.contains("is-ready")).toBe(true);
  await act(async () => image.dispatchEvent(new Event("error")));
  expect(container.querySelector("img")).toBeNull();
  expect(container.querySelector(".site-mark > svg")).not.toBeNull();
  expect(container.textContent).toBe("");
  await render(owner.client, null);
  expect(container.textContent).toBe("");
});

it.each(["error", "null"])(
  "recovers a mounted icon after a transient %s with the same reference",
  async (failure) => {
    const read = vi.fn<HostClient["readBrowserTabIcon"]>();
    if (failure === "error") read.mockRejectedValueOnce(new Error("Disconnected"));
    else read.mockResolvedValueOnce(null);
    read.mockResolvedValue(blue);
    const owner = host(read);
    const { container } = await mount(owner.client);
    expect(container.querySelector("img")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(container.querySelector("img")?.getAttribute("src")).toBe(blue);
    expect(read).toHaveBeenCalledTimes(2);
  },
);

it("shares successful/in-flight reads within a client and isolates different clients", async () => {
  const first = host();
  const second = host(vi.fn(async () => green));
  const { container, render } = await mount(first.client, "same-ref", 2);
  expect(first.read).toHaveBeenCalledTimes(1);
  expect([...container.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
    blue,
    blue,
  ]);
  await render(second.client);
  expect(second.read).toHaveBeenCalledTimes(1);
  expect([...container.querySelectorAll("img")].map((image) => image.getAttribute("src"))).toEqual([
    green,
    green,
  ]);
});

it("bounds failed retries and retries the same reference after reconnect", async () => {
  const read = vi.fn<HostClient["readBrowserTabIcon"]>(async () => null);
  const owner = host(read);
  const { container } = await mount(owner.client);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(read).toHaveBeenCalledTimes(3);
  expect(container.textContent).toBe("");
  await owner.connect("offline");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(read).toHaveBeenCalledTimes(3);
  read.mockResolvedValue(blue);
  await owner.connect("connected");
  expect(read).toHaveBeenCalledTimes(4);
  expect(container.querySelector("img")?.getAttribute("src")).toBe(blue);
});

it("waits for connection and discards an older reference's late completion", async () => {
  let resolveOld: (value: string) => void = () => {
    throw new Error("Missing old read.");
  };
  const oldRead = new Promise<string>((resolve) => {
    resolveOld = resolve;
  });
  const read = vi
    .fn<HostClient["readBrowserTabIcon"]>()
    .mockReturnValueOnce(oldRead)
    .mockResolvedValue(green);
  const owner = host(read);
  await owner.connect("offline");
  const { container, render } = await mount(owner.client, "old-ref");
  expect(read).not.toHaveBeenCalled();
  await owner.connect("connected");
  expect(read).toHaveBeenCalledTimes(1);
  await render(owner.client, "new-ref");
  expect(container.querySelector("img")?.getAttribute("src")).toBe(green);
  await act(async () => resolveOld(blue));
  expect(container.querySelector("img")?.getAttribute("src")).toBe(green);
});

it("cancels pending retries and subscriptions on unmount", async () => {
  const read = vi.fn<HostClient["readBrowserTabIcon"]>(async () => null);
  const owner = host(read);
  await mount(owner.client);
  expect(read).toHaveBeenCalledTimes(1);
  act(() => root?.unmount());
  root = null;
  expect(owner.listeners.size).toBe(0);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(read).toHaveBeenCalledTimes(1);
});

it("fits profile badges to their icon without a dark circular outline", async () => {
  const style = document.createElement("style");
  style.textContent = readFileSync("apps/web/src/styles/workspace.css", "utf8");
  document.body.append(style);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <span className="pbadge">
        <ProfileAvatar identity={{ kind: "guest", name: "Guest" }} size={14} />
      </span>,
    ),
  );
  const badge = container.querySelector(".pbadge")!;
  expect(getComputedStyle(badge).display).toBe("grid");
  expect(getComputedStyle(badge).boxShadow).toBe("none");
});
