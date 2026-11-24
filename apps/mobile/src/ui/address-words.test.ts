import { describe, expect, it } from "vitest";
import { addressParts, addressValue, addressWords, isAddress } from "./address-words.js";

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
        // Between every two characters a person sees, a word joiner: no break, so no hyphen.
        const seen = [
          ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(
            part.replaceAll(joiner, ""),
          ),
        ].map(({ segment }) => segment);
        expect(part).toBe(seen.join(joiner));
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

describe("only an address is drawn as one", () => {
  it("knows an origin, a URL, an email address and a host from words", () => {
    for (const value of [
      "https://claude.ai",
      "http://192.168.1.20:3000",
      "mailto:person@fixture.invalid",
      "person+travel@fixture.invalid",
      "studio-mac-mini.tail1234.ts.net",
      "192.168.1.20",
      "[::1]:8080",
      "localhost",
      "bücher.münchen.example",
    ])
      expect(isAddress(value), value).toBe(true);
    for (const value of [
      "Tim Jang",
      "an app on this computer",
      "Errand asked for this. AgentPay will hold the access.",
      "Studio",
      "",
    ])
      expect(isAddress(value), value).toBe(false);
  });

  it("refuses to draw words as an address", () => {
    expect(() => addressWords("Tim Jang")).toThrow(/Not an address/u);
    expect(() => addressWords("an app on this computer")).toThrow(/Not an address/u);
  });
});

describe("what a person sees as one character stays one", () => {
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  // The review's values: a skin tone, a flag, a tag sequence, decomposed Hangul, a halfwidth
  // voiced mark, a Devanagari conjunct, an emoji with ZWJ and a keycap.
  const values = [
    "\u{1F44D}\u{1F3FD}.ws",
    "\u{1F1FA}\u{1F1F8}.example",
    "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}.example",
    "\u1112\u1161\u11AB.example",
    "\uFF76\uFF9E.example",
    "\u0939\u093F\u0928\u094D\u0926\u0940.example",
    "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}.example",
    "1\uFE0F\u20E3.example",
  ];
  for (const value of values)
    it(`never puts a joiner inside a cluster of ${JSON.stringify(value)}`, () => {
      const drawn = addressWords(value);
      // Each cluster of the address appears whole in what is drawn: no joiner came inside it.
      // (A joiner is a cluster of its own, so one inside would split the cluster in two.)
      for (const { segment } of segmenter.segment(value))
        expect(drawn, JSON.stringify(segment)).toContain(segment);
      expect(addressValue(drawn)).toBe(value);
    });
});
