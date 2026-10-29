import { randomUUID } from "node:crypto";
import { BrowserSurfaceIdSchema, type BrowserServerMessage } from "@opensteer/protocol";
import { expect, it, vi } from "vitest";
import { LegacyBrowserClipboard } from "./browser-legacy-clipboard.js";

const surfaceId = BrowserSurfaceIdSchema.parse("page-1");
const manifest = (
  operationId: string,
  items: { type: string; size: number }[],
  outcome: "copied" | "cut" | "empty" | "refused" | "too-large" = "copied",
): BrowserServerMessage => ({ type: "clipboard.result", surfaceId, operationId, outcome, items });
const part = (operationId: string, bytes: Buffer, index = 0): BrowserServerMessage => ({
  type: "clipboard.part",
  part: { operationId, index, data: bytes.toString("base64") },
});

it("projects only successful plain text from a complete native operation", () => {
  const token = randomUUID(),
    projection = new LegacyBrowserClipboard(token, 1048576);
  try {
    const operationId = projection.begin(surfaceId, "copied");
    expect(
      projection.read(
        manifest(operationId, [
          { type: "text/html", size: 3 },
          { type: "text/plain", size: 8 },
        ]),
      ),
    ).toBeNull();
    expect(projection.read(part(operationId, Buffer.from("<b>\uFEFFplain")))).toEqual({
      type: "clipboard.data",
      surfaceId,
      consumerToken: token,
      text: "\uFEFFplain",
    });
    expect(projection.read(part(operationId, Buffer.from("<b>plain")))).toBeNull();
    for (const outcome of ["empty", "refused", "too-large"] as const) {
      const id = projection.begin(surfaceId, "copied");
      expect(projection.read(manifest(id, [{ type: "text/plain", size: 1 }], outcome))).toBeNull();
      expect(projection.read(part(id, Buffer.from("x")))).toBeNull();
    }
  } finally {
    projection.close();
  }
});

it("refuses baseline character and encoded-frame overflow, invalid bytes and incomplete operations", () => {
  vi.useFakeTimers();
  const projection = new LegacyBrowserClipboard(randomUUID(), 1048576);
  try {
    for (const bytes of [
      Buffer.alloc(1000001, 120),
      Buffer.from("\n".repeat(600000)),
      Buffer.from([255]),
    ]) {
      const id = projection.begin(surfaceId, "copied");
      projection.read(manifest(id, [{ type: "text/plain", size: bytes.length }]));
      for (let at = 0, index = 0; at < bytes.length; at += 524288, index++)
        expect(projection.read(part(id, bytes.subarray(at, at + 524288), index))).toBeNull();
    }
    const id = projection.begin(surfaceId, "copied");
    projection.read(manifest(id, [{ type: "text/plain", size: 524289 }]));
    expect(projection.read(part(id, Buffer.alloc(524288, 120)))).toBeNull();
    vi.advanceTimersByTime(5001);
    expect(projection.read(part(id, Buffer.from("x"), 1))).toBeNull();
    const invalid = projection.begin(surfaceId, "copied");
    projection.read(manifest(invalid, [{ type: "text/plain", size: 1 }]));
    expect(projection.read(part(invalid, Buffer.from("x"), 1))).toBeNull();
    expect(projection.read(part(invalid, Buffer.from("x")))).toBeNull();
  } finally {
    projection.close();
    vi.useRealTimers();
  }
});

it("a later copy replaces an incomplete copy without mixing their parts", () => {
  const projection = new LegacyBrowserClipboard(randomUUID(), 1048576);
  try {
    const old = projection.begin(surfaceId, "copied"),
      current = projection.begin(surfaceId, "cut");
    projection.read(manifest(old, [{ type: "text/plain", size: 3 }]));
    projection.read(manifest(current, [{ type: "text/plain", size: 3 }], "cut"));
    expect(projection.read(part(old, Buffer.from("old")))).toBeNull();
    expect(projection.read(part(current, Buffer.from("new")))).toMatchObject({ text: "new" });
  } finally {
    projection.close();
  }
});
