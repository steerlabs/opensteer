import { describe, expect, test } from "vitest";

import {
  createBodyPayload,
  createDevicePixelRatio,
  createDocumentEpoch,
  createDocumentRef,
  createFrameRef,
  createPageRef,
  createPoint,
  createQuad,
  createRect,
  createSessionRef,
  createSize,
  createNodeRef,
  nextDocumentEpoch,
  quadBounds,
  rectContainsPoint,
  rectToQuad,
  filterCookieRecords,
  serializeDocumentEpoch,
  serializeRef,
} from "../../packages/browser-core/src/index.js";

describe("browser-core identity", () => {
  test("normalizes unprefixed refs and keeps canonical refs stable", () => {
    const sessionRef = createSessionRef("session-a");
    const pageRef = createPageRef("page-a");
    const frameRef = createFrameRef("frame-a");
    const documentRef = createDocumentRef("document-a");
    const nodeRef = createNodeRef("node-a");

    expect(serializeRef(sessionRef)).toBe("session:session-a");
    expect(serializeRef(pageRef)).toBe("page:page-a");
    expect(serializeRef(frameRef)).toBe("frame:frame-a");
    expect(serializeRef(documentRef)).toBe("document:document-a");
    expect(serializeRef(nodeRef)).toBe("node:node-a");

    expect(createPageRef("page:already-prefixed")).toBe("page:already-prefixed");
  });

  test("rejects empty refs and mismatched prefixes", () => {
    expect(() => createSessionRef("")).toThrow(/cannot be empty/i);
    expect(() => createPageRef("session:bad")).toThrow(/must either omit a prefix/i);
  });

  test("creates document epochs and advances them monotonically", () => {
    const initial = createDocumentEpoch(0);
    const next = nextDocumentEpoch(initial);

    expect(serializeDocumentEpoch(initial)).toBe(0);
    expect(serializeDocumentEpoch(next)).toBe(1);
    expect(() => createDocumentEpoch(-1)).toThrow(/non-negative integer/i);
    expect(() => createDocumentEpoch(1.25)).toThrow(/non-negative integer/i);
  });
});

describe("browser-core geometry", () => {
  test("builds rects, quads, and bounds in a reversible way", () => {
    const rect = createRect(10, 20, 30, 40);
    const quadFromRect = rectToQuad(rect);
    const explicitQuad = createQuad([
      createPoint(10, 20),
      createPoint(40, 20),
      createPoint(40, 60),
      createPoint(10, 60),
    ]);

    expect(quadFromRect).toEqual(explicitQuad);
    expect(quadBounds(quadFromRect)).toEqual(rect);
  });

  test("checks point containment inclusively on rect edges", () => {
    const rect = createRect(0, 0, 100, 50);

    expect(rectContainsPoint(rect, createPoint(0, 0))).toBe(true);
    expect(rectContainsPoint(rect, createPoint(100, 50))).toBe(true);
    expect(rectContainsPoint(rect, createPoint(101, 50))).toBe(false);
    expect(rectContainsPoint(rect, createPoint(100, 51))).toBe(false);
  });

  test("rejects invalid geometry and invalid scales", () => {
    expect(() => createSize(-1, 10)).toThrow(/greater than or equal to 0/i);
    expect(() => createRect(0, 0, -1, 1)).toThrow(/greater than or equal to 0/i);
    expect(() => createDevicePixelRatio(0)).toThrow(/greater than 0/i);
  });
});

describe("browser-core payloads", () => {
  test("captures raw body bytes and omits optional metadata when absent", () => {
    const payload = createBodyPayload(new Uint8Array([1, 2, 3]));

    expect(Array.from(payload.bytes)).toEqual([1, 2, 3]);
    expect(payload.capturedByteLength).toBe(3);
    expect(payload.truncated).toBe(false);
    expect("mimeType" in payload).toBe(false);
    expect("charset" in payload).toBe(false);
    expect("originalByteLength" in payload).toBe(false);
  });
});

describe("browser-core storage", () => {
  test("applies RFC-style cookie path boundary matching", () => {
    const sessionRef = createSessionRef("session-a");
    const cookies = [
      {
        sessionRef,
        name: "scoped",
        value: "1",
        domain: "example.com",
        path: "/app",
        secure: false,
        httpOnly: false,
        session: true,
      },
    ];

    expect(
      filterCookieRecords(cookies, ["https://example.com/app"]).map((cookie) => cookie.name),
    ).toEqual(["scoped"]);
    expect(
      filterCookieRecords(cookies, ["https://example.com/app/details"]).map(
        (cookie) => cookie.name,
      ),
    ).toEqual(["scoped"]);
    expect(filterCookieRecords(cookies, ["https://example.com/app2"])).toEqual([]);
  });
});
