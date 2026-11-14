import { expect, it, vi } from "vitest";
import { FakeCdpSession } from "@opensteer/browser-runtime-core/test-support";
import { loadPage } from "./page-load.test-support.js";

it("waits for document loading after its URL commits before sending a reload", async () => {
  vi.useFakeTimers();
  const cdp = new FakeCdpSession();
  const cancellation = new AbortController();
  let active = false;
  cdp.responses.set("Page.navigate", () => {
    cdp.emit("Page.frameNavigated", { frame: { id: "page", url: "https://fixture.test/#42" } });
    return { frameId: "page", loaderId: "first-document" };
  });
  cdp.responses.set("Page.reload", () => {
    if (!active) throw new Error("Not attached to an active page");
    cdp.emit("Page.loadEventFired", {});
    return {};
  });
  let finished = false;
  let failure: unknown;
  const reloading = loadPage(
    cdp,
    "Page.navigate",
    { url: "https://fixture.test/#42" },
    cancellation.signal,
  )
    .then(() => loadPage(cdp, "Page.reload", {}, cancellation.signal))
    .then(() => {
      finished = true;
    })
    .catch((error: unknown) => {
      failure = error;
    });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(
      cdp.sent.map(({ method }) => method),
      "A committed URL is not page-load readiness",
    ).toEqual(["Page.navigate"]);
    expect(finished).toBe(false);
    active = true;
    cdp.emit("Page.loadEventFired", {});
    await vi.advanceTimersByTimeAsync(0);
    expect(failure).toBeUndefined();
    expect(finished, "The loaded document never permitted its reload").toBe(true);
    expect(cdp.sent.map(({ method }) => method)).toEqual(["Page.navigate", "Page.reload"]);
    expect([...cdp.listeners.values()].flatMap((listeners) => [...listeners])).toEqual([]);
  } finally {
    cancellation.abort();
    await reloading;
    vi.useRealTimers();
  }
});

it("names a missing load acknowledgement and bounds even an unanswered CDP command", async () => {
  vi.useFakeTimers();
  const cdp = new FakeCdpSession();
  const command = Promise.withResolvers<void>();
  cdp.responses.set("Page.reload", () => command.promise);
  let failure: unknown;
  const loading = loadPage(cdp, "Page.reload", {}, new AbortController().signal).catch(
    (error: unknown) => {
      failure = error;
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(failure).toMatchObject({
      message: "Chromium Page.reload never finished loading within 5,000 ms.",
    });
    expect([...cdp.listeners.values()].flatMap((listeners) => [...listeners])).toEqual([]);
  } finally {
    command.resolve();
    await loading;
    vi.useRealTimers();
  }
});
