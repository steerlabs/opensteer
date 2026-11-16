import { expect, it } from "vitest";
import { clipboardNeedsPng } from "./clipboard-format.js";

it("keeps clipboard-compatible originals and converts formats Android cannot export", () => {
  for (const type of ["image/png", "image/jpeg", "IMAGE/PNG; charset=binary"])
    expect(clipboardNeedsPng(type, "android")).toBe(false);
  for (const type of ["image/webp", "image/heic", "image/gif", "image/svg+xml", ""])
    expect(clipboardNeedsPng(type, "android")).toBe(true);
});

it("lets iOS decode original formats before attempting conversion", () => {
  for (const type of ["image/png", "image/jpeg", "image/gif", "image/heic", "image/webp"])
    expect(clipboardNeedsPng(type, "ios")).toBe(false);
});
