import { address, named, said } from "@opensteer/client/host";
import { describe, expect, it } from "vitest";
import { sentenceOf } from "./sentence-addresses.js";
import { plainSentence } from "./sentence-parts.js";

describe("a sentence made where it was said", () => {
  it("draws each address as one, and a name as words however it reads", () => {
    const made = said`Sharing ${address("github.com")} is stopped in ${named("evil.example")}`;
    const parts = sentenceOf(made.parts);
    expect(parts).toEqual([
      "Sharing ",
      { address: "github.com" },
      " is stopped in ",
      "evil.example",
    ]);
    expect(plainSentence(parts)).toBe(made.text);
  });
});
