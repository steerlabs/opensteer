import { describe, expect, it } from "vitest";
import { addressParts, addressValue, addressWords } from "./address-words.js";

/*
 * The characters every address, host and URL on the phone is drawn with (`AddressText`). What a
 * text engine does with them, where a line really breaks and that no hyphen is drawn, only a
 * phone shows (the VM walk); this holds what it is handed: a break opportunity at each joint and
 * none anywhere else, and the address itself unchanged.
 */

const joiner = "\u2060";
const opportunity = "\u200B";

/** The value's parts as drawn: split at the break opportunities, joiners taken out. */
function drawnParts(value: string): string[] {
  return addressWords(value)
    .split(opportunity)
    .map((part) => part.replaceAll(joiner, ""));
}

const table: ReadonlyArray<{
  readonly name: string;
  readonly value: string;
  readonly parts: readonly string[];
}> = [
  {
    name: "an email address",
    value: "person@fixture.invalid",
    parts: ["person@", "fixture.", "invalid"],
  },
  {
    name: "an email address with a +",
    value: "person+travel@fixture.invalid",
    parts: ["person+travel@", "fixture.", "invalid"],
  },
  {
    name: "a long host",
    value: "verylongsubdomainwithoutanyjointsatall.region-one.example.com",
    parts: ["verylongsubdomainwithoutanyjointsatall.", "region-one.", "example.", "com"],
  },
  {
    name: "a host with a hyphen of its own",
    value: "studio-mac-mini.tail1234.ts.net",
    parts: ["studio-mac-mini.", "tail1234.", "ts.", "net"],
  },
  {
    name: "an internationalized host",
    value: "bücher.münchen.example",
    parts: ["bücher.", "münchen.", "example"],
  },
  {
    name: "a URL with its scheme",
    value: "https://account.fixture.invalid",
    parts: ["https://", "account.", "fixture.", "invalid"],
  },
  {
    name: "a URL with a long path and a query",
    value: "https://claude.ai/api/mcp/auth_callback?state=abc123&scope=read#top",
    parts: [
      "https://",
      "claude.",
      "ai",
      "/api",
      "/mcp",
      "/auth_callback",
      "?state=",
      "abc123&",
      "scope=",
      "read",
      "#top",
    ],
  },
];

describe("an address as the phone draws it", () => {
  for (const { name, parts, value } of table) {
    it(`breaks ${name} only at its joints`, () => {
      expect(addressParts(value)).toEqual(parts);
      expect(drawnParts(value)).toEqual(parts);
    });

    it(`holds every part of ${name} together, with no hyphen added`, () => {
      const drawn = addressWords(value);
      // Nothing but the joiners and the break opportunities is added: no hyphen, soft or hard.
      expect(addressValue(drawn)).toBe(value);
      expect(drawn).not.toMatch(/[\u00AD\u2010\u2011]/u);
      for (const part of drawn.split(opportunity)) {
        const characters = Array.from(part.replaceAll(joiner, ""));
        // Between every two characters of a part, a word joiner: no break, so no hyphen either.
        expect(part).toBe(
          characters
            .map((character, index) =>
              index > 0 && !/^\p{M}$/u.test(character) ? joiner + character : character,
            )
            .join(""),
        );
      }
    });
  }

  it("never offers a break after an address's own hyphen", () => {
    const drawn = addressWords("studio-mac-mini.tail1234.ts.net");
    expect(drawn).not.toContain(`-${opportunity}`);
    expect(drawn).toContain(`-${joiner}`);
  });

  it("keeps a combining mark with its letter", () => {
    // "ü" written as u and a combining diaeresis: no joiner may come between them.
    const decomposed = "bu\u0308cher.example";
    expect(addressWords(decomposed)).toContain("u\u0308");
    expect(addressValue(addressWords(decomposed))).toBe(decomposed);
  });
});
