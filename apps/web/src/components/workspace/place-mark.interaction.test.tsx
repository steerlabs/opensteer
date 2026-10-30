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
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = 32;
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
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

async function mount(client: HostClient, ref = "same-ref", copies = 1) {
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
              site="https://example.com"
            />
          ))}
        </>,
      ),
    );
  };
  await render();
  return { container, render };
}

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
