import { describe, expect, it } from "vitest";
import { readableMarkdown } from "./readable-markdown.js";

describe("Markdown while its renderer is loading", () => {
  it.each([
    ["Before [fix](opensteer:thr_1234", "Before "],
    ["Before [file](/Users/me/Opensteer/private.txt", "Before "],
    ["[result][file]\n\n[file]: /Users/me/Opensteer/private.txt", "result\n\n"],
    ["[fix][task]\n\n[task]: opensteer:thr_1234", "fix\n\n"],
    ["Before [fix](opensteer:thr_1234) after", "Before fix after"],
    ["[site](https://example.com) ![chart](https://example.com/chart.png)", "site chart"],
    ["[outer [inner](https://example.com)](/Users/me/Opensteer/private.txt)", "outer inner"],
  ])("keeps readable words without private destinations: %s", (source, expected) => {
    const result = readableMarkdown(source);
    expect(result).toBe(expected);
    expect(result).not.toMatch(/opensteer:|\/Users\/me\/Opensteer\//iu);
  });
});
