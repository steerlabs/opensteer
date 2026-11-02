import { afterEach, expect, it, vi } from "vitest";
import { FakeCdpSession } from "../test-support/fakes.js";
import { PageCursorHints, normalizeElectronCursor } from "./cursor-hints.js";

afterEach(() => vi.useRealTimers());
const point = {
  consumerToken: "00000000-0000-4000-8000-000000000001",
  cursorSequence: 1,
  documentId: "doc",
  geometryRevision: 2,
  captureRevision: 3,
  x: 10,
  y: 20,
};
function setup() {
  const cdp = new FakeCdpSession();
  cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
  cdp.responses.set("Page.createIsolatedWorld", { executionContextId: 7 });
  cdp.responses.set("Runtime.evaluate", { result: { value: "pointer" } });
  const publish = vi.fn();
  const hints = new PageCursorHints(cdp, publish);
  return { cdp, publish, hints };
}
it("coalesces private point queries and discards stale replies without blocking input", async () => {
  vi.useFakeTimers();
  const { cdp, publish, hints } = setup();
  const response = Promise.withResolvers<unknown>();
  cdp.responses.set("Runtime.evaluate", () => response.promise);
  hints.point(point);
  await vi.advanceTimersByTimeAsync(0);
  expect(cdp.sent.find((c) => c.method === "Runtime.evaluate")?.parameters).toMatchObject({
    contextId: 7,
    returnByValue: true,
  });
  hints.point({ ...point, cursorSequence: 2, x: 30 });
  hints.point({ ...point, cursorSequence: 3, x: 40 });
  response.resolve({ result: { value: "text" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).not.toHaveBeenCalled();
  cdp.responses.set("Runtime.evaluate", { result: { value: "grab" } });
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "grab", cursorSequence: 3 }),
  );
  expect(cdp.sent.filter((c) => c.method === "Runtime.evaluate")).toHaveLength(2);
  hints.close();
});
it("invalidates navigation, takeover and closed observations, and refuses unknown CSS", async () => {
  vi.useFakeTimers();
  const { cdp, publish, hints } = setup();
  hints.point(point);
  cdp.emit("Page.frameNavigated", { frame: { id: "main" } });
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cursor: "default" }));
  hints.point(point);
  cdp.responses.set("Runtime.evaluate", { result: { value: "url(secret), pointer" } });
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "default" }));
  cdp.emit("Page.navigatedWithinDocument", { frameId: "main", url: "https://fixture/#section" });
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "default" }));
  hints.point(point);
  hints.close();
  publish.mockClear();
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).not.toHaveBeenCalled();
});
it("normalizes Electron names without exporting custom cursor data", () => {
  expect(normalizeElectronCursor("pointer")).toBe("default");
  expect(normalizeElectronCursor("hand")).toBe("pointer");
  expect(normalizeElectronCursor("ibeam")).toBe("text");
  expect(normalizeElectronCursor("eastwest-resize")).toBe("ew-resize");
  expect(normalizeElectronCursor("not-allowed")).toBe("not-allowed");
  expect(normalizeElectronCursor("custom")).toBe("default");
  expect(normalizeElectronCursor("constructor")).toBe("default");
  expect(normalizeElectronCursor("toString")).toBe("default");
});

it("refuses a refresh for a point that has not reached the engine", async () => {
  vi.useFakeTimers();
  const { hints, publish } = setup();
  hints.point(point);
  hints.refresh(point.consumerToken, 3, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursorSequence: 1 }));
  hints.refresh(point.consumerToken, 4, 1);
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursorSequence: 4 }));
  hints.close();
});

it("uses native events only while controller input has unambiguous ownership", async () => {
  vi.useFakeTimers();
  const { cdp, publish } = setup();
  const listeners = new Set<
    (cursor: import("@opensteer/protocol/browser").BrowserCursor | null) => void
  >();
  const hints = new PageCursorHints(cdp, publish, {
    read: () => "pointer",
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
  const settled = hints.point(point, true);
  for (const listener of listeners) listener("pointer");
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).not.toHaveBeenCalled();
  settled();
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "pointer" }));
  expect(cdp.sent.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(0);
  for (const listener of listeners) listener(null);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "default" }));
  publish.mockClear();
  for (const listener of listeners) listener("text");
  hints.refresh(point.consumerToken, 2, 1);
  await vi.advanceTimersByTimeAsync(100);
  expect(publish).not.toHaveBeenCalled();
  hints.close();
  expect(listeners.size).toBe(0);
});

it("resolves common auto cursors conservatively and never exports CSS URLs", async () => {
  const { cursorQuerySource } = await import("./cursor-hints.js");
  let css = { cursor: "auto", userSelect: "auto" };
  let kind = "link";
  const element = {
    tagName: "SPAN",
    isContentEditable: false,
    closest: (selector: string) =>
      kind === "link" && selector === "a[href], area[href]" ? {} : null,
  };
  const document = {
    elementFromPoint: () => element,
    caretRangeFromPoint: () => ({ startContainer: { nodeType: 3, length: 10 }, startOffset: 2 }),
    createRange: () => ({
      setStart: () => {},
      setEnd: () => {},
      getClientRects: () => [{ left: 8, right: 12, top: 18, bottom: 22 }],
    }),
  };
  const query = new Function(
    "document",
    "getComputedStyle",
    `return ${cursorQuerySource(10, 20)}`,
  ) as (document: object, style: () => object) => string;
  expect(query(document, () => css)).toBe("pointer");
  kind = "text";
  expect(query(document, () => css)).toBe("text");
  for (const cursor of ["grab", "grabbing", "ew-resize", "not-allowed"]) {
    css = { ...css, cursor };
    expect(query(document, () => css)).toBe(cursor);
  }
  css = { ...css, cursor: "url(https://private.test/token), pointer" };
  expect(query(document, () => css)).toBe("default");
  css = { cursor: "auto", userSelect: "none" };
  expect(query(document, () => css)).toBe("default");
  element.tagName = "IFRAME";
  css = { ...css, cursor: "pointer" };
  expect(query(document, () => css)).toBe("default");
});

it("expires a stalled query without accumulating concurrent renderer work", async () => {
  vi.useFakeTimers();
  const { hints, cdp, publish } = setup();
  const response = Promise.withResolvers<unknown>();
  cdp.responses.set("Runtime.evaluate", () => response.promise);
  hints.point(point);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(500);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "default" }));
  hints.point({ ...point, cursorSequence: 2 });
  hints.refresh(point.consumerToken, 3, 2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(cdp.sent.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(1);
  hints.close();
  response.resolve({ result: { value: "pointer" } });
  publish.mockClear();
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).not.toHaveBeenCalled();
});

it("keeps stationary refreshes valid across slow queries and waits for queued scrolling", async () => {
  vi.useFakeTimers();
  const { hints, cdp, publish } = setup();
  const response = Promise.withResolvers<unknown>();
  cdp.responses.set("Runtime.evaluate", () => response.promise);
  hints.point(point);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(300);
  hints.refresh(point.consumerToken, 1, 1);
  response.resolve({ result: { value: "pointer" } });
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "pointer" }));
  const resume = hints.pause();
  publish.mockClear();
  cdp.responses.set("Runtime.evaluate", { result: { value: "text" } });
  hints.refresh(point.consumerToken, 2, 1);
  await vi.advanceTimersByTimeAsync(300);
  expect(publish).not.toHaveBeenCalled();
  resume();
  hints.refresh(point.consumerToken, 2, 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(publish).toHaveBeenLastCalledWith(
    expect.objectContaining({ cursor: "text", cursorSequence: 2 }),
  );
  hints.close();
});
