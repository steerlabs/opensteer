import { expect, it } from "vitest";
import { markdownPreview } from "./markdownPreview.js";

it("turns Markdown into one plain line for a list", () => {
  expect(
    markdownPreview(
      "## Refunds\nNeed **Maya or Dana** first.\n\n- Check the `order`\n- See [the policy](https://x.example/p) *now*.\n```\nlet raw = 1;\n```\n---",
      200,
    ),
  ).toBe(
    "Refunds · Need Maya or Dana first. · Check the order · See the policy now. · let raw = 1;",
  );
  expect(markdownPreview("snake_case_name stays", 200)).toBe("snake_case_name stays");
  expect(markdownPreview("a".repeat(10), 5)).toBe("aaaa…");
  // Emoji take two units each; the preview stays within the limit and keeps whole emoji.
  const emoji = markdownPreview("😀".repeat(101), 200);
  expect(emoji.length).toBeLessThanOrEqual(200);
  expect(emoji).toBe(`${"😀".repeat(99)}…`);
});
