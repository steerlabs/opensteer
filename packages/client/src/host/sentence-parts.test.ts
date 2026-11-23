import { describe, expect, it } from "vitest";
import {
  addressParts,
  isAddress,
  plainSentence,
  sentence,
  sentenceAround,
  sentenceAroundName,
} from "./sentence-parts.js";

const table: ReadonlyArray<{
  readonly name: string;
  readonly value: string;
  readonly parts: readonly string[];
}> = [
  {
    name: "an email address",
    value: "person@fixture.invalid",
    parts: ["person@", "fixture", ".invalid"],
  },
  {
    name: "an email address with a +",
    value: "person+travel@fixture.invalid",
    parts: ["person+travel@", "fixture", ".invalid"],
  },
  {
    name: "a long host",
    value: "verylongsubdomainwithoutanyjointsatall.region-one.example.com",
    parts: ["verylongsubdomainwithoutanyjointsatall", ".region-one", ".example", ".com"],
  },
  {
    name: "a host with a hyphen of its own",
    value: "studio-mac-mini.tail1234.ts.net",
    parts: ["studio-mac-mini", ".tail1234", ".ts", ".net"],
  },
  { name: "an internationalized host", value: "tim@münchen.de", parts: ["tim@", "münchen", ".de"] },
  { name: "a punycode host", value: "foo.xn--p1ai", parts: ["foo", ".xn--p1ai"] },
  { name: "a host with capitals", value: "Studio.Local", parts: ["Studio", ".Local"] },
  {
    name: "a URL with a long path and a query",
    value: "https://claude.ai/api/mcp/auth_callback?state=abc123&scope=read#top",
    parts: [
      "https://",
      "claude",
      ".ai",
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

describe("an address's joints", () => {
  for (const { name, parts, value } of table)
    it(`breaks ${name} only at its joints, a dot's before the dot`, () => {
      expect(addressParts(value)).toEqual(parts);
      expect(addressParts(value).join("")).toBe(value);
    });

  it("never makes a hyphen a joint, so a registrable domain is never split at it", () => {
    expect(addressParts("evil-google.com")).toEqual(["evil-google", ".com"]);
  });
});

describe("only an address is an address", () => {
  it("knows an origin, a URL, an email address and a host from words", () => {
    for (const value of [
      "https://claude.ai",
      "http://192.168.1.20:3000",
      "person+travel@fixture.invalid",
      "tim@münchen.de",
      "foo.xn--p1ai",
      "Studio.Local",
      "localhost",
    ])
      expect(isAddress(value), value).toBe(true);
    for (const value of ["Workshop", "On-call", "+1 415 555 0100", "Tim", "Messages on Studio Mac"])
      expect(isAddress(value), value).toBe(false);
  });
});

describe("a sentence as parts", () => {
  it("keeps the address a part of its own and reads back exactly as written", () => {
    const parts = sentence`Send the code to ${"tim@example.com"} in a direct message.`;
    expect(parts).toEqual([
      "Send the code to ",
      { address: "tim@example.com" },
      " in a direct message.",
    ]);
    expect(plainSentence(parts)).toBe("Send the code to tim@example.com in a direct message.");
  });

  it("places a value in a template's slot, as an address only when it is one", () => {
    const words = (account: string) => `Direct messages to ${account} on iMessage`;
    expect(sentenceAround(words, "tim@example.com")).toEqual([
      "Direct messages to ",
      { address: "tim@example.com" },
      " on iMessage",
    ]);
    expect(sentenceAround(words, "Workshop")).toEqual(["Direct messages to Workshop on iMessage"]);
  });

  it("keeps a name from outside Opensteer a name part, never words to search, unless it is an address", () => {
    const words = (account: string) => `Direct messages to ${account} on Slack`;
    expect(sentenceAroundName(words, "Workshop")).toEqual([
      "Direct messages to ",
      { name: "Workshop" },
      " on Slack",
    ]);
    expect(sentenceAroundName(words, "acme.slack.com")).toEqual([
      "Direct messages to ",
      { address: "acme.slack.com" },
      " on Slack",
    ]);
    // A name that reads like a host is still a name when the code says it is one.
    const parts = [
      "Uses ",
      { name: "evil-google.com Notes" },
      " to reach ",
      { address: "api.example.com" },
    ];
    expect(plainSentence(parts)).toBe("Uses evil-google.com Notes to reach api.example.com");
  });
});
