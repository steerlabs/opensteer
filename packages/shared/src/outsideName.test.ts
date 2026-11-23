import { expect, it } from "vitest";
import { outsideName } from "./outsideName.js";

it.each([
  ["a forged agent name", "Helper\u202E\nDisconnected", "Helper Disconnected"],
  [
    "a forged channel name",
    "#ops\u202E\nOnly you can message this chat",
    "#ops Only you can message this chat",
  ],
  ["a zero-width joiner", "Work\u200DOps", "WorkOps"],
  ["a tab", "Work\tOps", "Work Ops"],
  ["a soft hyphen", "evil\u00ADgoogle.com", "evilgoogle.com"],
  ["an isolate", "\u2067Alice\u2069", "Alice"],
  ["runs of space and a line separator", "  Alice \u2028  Bob  ", "Alice Bob"],
])("cleans %s", (_what, value, cleaned) => {
  expect(outsideName(value, 160)).toBe(cleaned);
});

it("cuts a long name at its maximum, never inside a character", () => {
  expect(outsideName("x".repeat(5_000), 160)).toHaveLength(160);
  expect(Array.from(outsideName("😀".repeat(200), 160))).toHaveLength(160);
});
