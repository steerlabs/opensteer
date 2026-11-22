import { describe, expect, it } from "vitest";
import { sentenceWith } from "./sentence-addresses.js";
import { plainSentence } from "./sentence-parts.js";

describe("a sentence made from data, with the addresses it holds", () => {
  it("draws each address as one, in its place, and reads exactly as written", () => {
    const text =
      "Your GitHub credential can only be sent to api.github.com and uploads.github.com.";
    const parts = sentenceWith(text, ["api.github.com", "uploads.github.com"]);
    expect(parts).toEqual([
      "Your GitHub credential can only be sent to ",
      { address: "api.github.com" },
      " and ",
      { address: "uploads.github.com" },
      ".",
    ]);
    expect(plainSentence(parts)).toBe(text);
  });

  it("leaves an address the words do not hold as words", () => {
    expect(sentenceWith("No sites.", ["api.github.com"])).toEqual(["No sites."]);
  });
});
