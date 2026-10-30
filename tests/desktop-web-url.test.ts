import { expect, it } from "vitest";
import { DesktopWebUrlSchema } from "../packages/protocol/src/desktop.js";
it("refuses embedded credentials", () => {
  for (const url of [
    "https://a.example:secret@b.example/",
    "https://a@example.com/",
    "https://:secret@example.com/",
  ])
    expect(DesktopWebUrlSchema.safeParse(url).success).toBe(false);
});
it("uses an 8 KiB UTF-8 boundary and permits IDN hosts", () => {
  const prefix = "https://example.com/";
  const boundary = prefix + "é".repeat(4086);
  expect(new TextEncoder().encode(boundary).length).toBe(8192);
  expect(DesktopWebUrlSchema.safeParse(boundary).success).toBe(true);
  expect(DesktopWebUrlSchema.safeParse(boundary + "é").success).toBe(false);
  expect(DesktopWebUrlSchema.safeParse("https://例え.テスト/道").success).toBe(true);
});
