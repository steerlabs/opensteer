import { describe, expect, it } from "vitest";
import { pieces } from "./yoga-frames.js";

/*
 * The layout harness reads a text as the phone's line breaker would read the characters drawn:
 * an address's parts break at their zero-width spaces, and a space held by word joiners is no
 * place to break, so words drawn that way could only break inside themselves.
 */

const joiner = "\u2060";
const opportunity = "\u200B";

describe("the harness's line breaker", () => {
  it("breaks words at spaces", () => {
    expect(pieces("Tim Jang").map(({ word }) => word)).toEqual(["Tim", "Jang"]);
  });

  it("breaks an address only at its zero-width spaces, which take no room", () => {
    expect(pieces(`person@${opportunity}fixture.${opportunity}invalid`)).toEqual([
      { gap: 1, word: "person@" },
      { gap: 0, word: "fixture." },
      { gap: 0, word: "invalid" },
    ]);
  });

  it("never breaks at a space a word joiner holds", () => {
    const held = ["T", "i", "m", " ", "J", "a", "n", "g"].join(joiner);
    expect(pieces(held).map(({ word }) => word)).toEqual(["Tim Jang"]);
  });
});
