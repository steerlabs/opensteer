import { describe, expect, it } from "vitest";
import { titleFirst } from "./requests.js";

describe("a command Request's title (X3)", () => {
  it("keeps the Home's sentence whole and cuts only what follows", () => {
    const sentence = "Rename an AI engine account";
    const title = titleFirst(sentence, ` · Asked by the agent “${"n".repeat(400)}”`);
    expect(title.startsWith(sentence)).toBe(true);
    expect(title).toHaveLength(240);
    expect(title.endsWith("…")).toBe(true);
    expect(titleFirst(sentence, " · short")).toBe(`${sentence} · short`);
  });
});
