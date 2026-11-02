import { expect, it } from "vitest";
import { BrowserClientMessageSchema, BrowserServerMessageSchema } from "./browser.js";

const hint = {
  type: "browser.cursor",
  surfaceId: "page-1",
  consumerToken: "00000000-0000-4000-8000-000000000001",
  cursorSequence: 3,
  documentId: "doc",
  geometryRevision: 2,
  captureRevision: 4,
  cursor: "pointer",
};
it("admits only bounded cursor enums with controller, point, document and geometry fences", () => {
  expect(BrowserServerMessageSchema.safeParse(hint).success).toBe(true);
  for (const cursor of ["url(https://private.test/secret), pointer", "custom", "", "hand"])
    expect(BrowserServerMessageSchema.safeParse({ ...hint, cursor }).success).toBe(false);
  for (const key of [
    "consumerToken",
    "cursorSequence",
    "documentId",
    "geometryRevision",
    "captureRevision",
  ]) {
    const incomplete: Record<string, unknown> = { ...hint };
    delete incomplete[key];
    expect(BrowserServerMessageSchema.safeParse(incomplete).success).toBe(false);
  }
  expect(BrowserServerMessageSchema.safeParse({ ...hint, image: "private" }).success).toBe(false);
});
it("admits cursor refresh and reset without page mutation or arbitrary CSS", () => {
  expect(
    BrowserClientMessageSchema.safeParse({
      type: "cursor.query",
      surfaceId: "page-1",
      cursorSequence: 3,
      pointSequence: 3,
    }).success,
  ).toBe(true);
  expect(
    BrowserClientMessageSchema.safeParse({ type: "cursor.reset", surfaceId: "page-1" }).success,
  ).toBe(true);
});
