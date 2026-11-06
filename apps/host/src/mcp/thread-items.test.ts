import { expect, it } from "vitest";
import { boundedThreadItems, itemText } from "./thread-items.js";

it("keeps the newest item past the byte bound, so paging always advances", () => {
  const large = "\u0001".repeat(50_000);
  expect(boundedThreadItems([large, "older"])).toEqual([large]);
});

it("pages text by code point without splitting a surrogate pair", () => {
  expect(itemText("a😀b", 2)).toEqual({ text: "a😀", textTruncated: true, nextTextOffset: 2 });
  expect(itemText("a😀b", 2, 2)).toEqual({ text: "b", textTruncated: false, nextTextOffset: null });
});
