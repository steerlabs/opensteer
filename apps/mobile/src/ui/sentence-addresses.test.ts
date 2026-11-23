import { named, plainSentence as madeWords, sentence } from "@opensteer/client/host";
import { describe, expect, it } from "vitest";
import { sentenceOf } from "./sentence-addresses.js";
import { plainSentence } from "./sentence-parts.js";

describe("a sentence made where it was said", () => {
  it("draws each address as one, and a name as words however it reads", () => {
    const made = sentence`Sharing ${"github.com"} is stopped in ${named("evil.example")}`;
    const parts = sentenceOf(made);
    expect(parts).toEqual([
      "Sharing ",
      { address: "github.com" },
      " is stopped in ",
      "evil.example",
    ]);
    expect(plainSentence(parts)).toBe(madeWords(made));
  });
});
