import { describe, expect, it } from "vitest";
import {
  addressParts,
  outsideText,
  plainSentence,
  sentence,
  sentenceWith,
  siteOrigin,
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

describe("what a field is, never what it looks like", () => {
  it("keeps a name a name, whatever it looks like", () => {
    for (const name of [
      "google.com",
      "alice@evil.example",
      "Work:Ops",
      "Next.js",
      "10:30",
      "...",
    ]) {
      const parts = sentenceWith((slot) => `Direct messages to ${slot("account")} on Slack`, {
        account: { name },
      });
      expect(parts).toEqual(["Direct messages to ", { name }, " on Slack"]);
      // In plain text it stands in quotation marks: where it ends, Opensteer's words begin.
      expect(plainSentence(parts)).toBe(`Direct messages to “${name}” on Slack`);
    }
  });

  it("puts each value in the slot its caller named, by its kind", () => {
    expect(
      sentenceWith((slot) => `${slot("conversation")} on Slack, through ${slot("account")}`, {
        conversation: { name: "#team" },
        account: { address: "tim@example.com" },
      }),
    ).toEqual([{ name: "#team" }, " on Slack, through ", { address: "tim@example.com" }]);
  });

  it("keeps an address a part of its own in a template", () => {
    const parts = sentence`Send the code to ${"tim@example.com"} in a direct message.`;
    expect(parts).toEqual([
      "Send the code to ",
      { address: "tim@example.com" },
      " in a direct message.",
    ]);
    expect(plainSentence(parts)).toBe("Send the code to tim@example.com in a direct message.");
  });
});

describe("a site a person decides about is its origin", () => {
  it.each([
    ["https://google.com@evil.example/", "https://evil.example"],
    ["https://evil.example/\u202Emoc.elgoog", "https://evil.example"],
    ["https://аррӏе.com/login", "https://xn--80ak6aa92e.com"],
    ["https://example.com:8443/p", "https://example.com:8443"],
    ["http://[2001:db8::1]:8080/x", "http://[2001:db8::1]:8080"],
    ["https://claude.ai/api/mcp/auth_callback?state=abc", "https://claude.ai"],
  ])("draws %s as %s", (value, origin) => {
    expect(siteOrigin(value.replace("\\u202E", "\u202E"))).toBe(origin);
  });

  it("has no origin for what is not a URL", () => {
    for (const value of ["evil.example", "Work:Ops", "", "javascript:alert(1)"])
      expect(siteOrigin(value), value).toBeNull();
  });
});

describe("what comes from outside is cleaned before it is drawn", () => {
  it.each([
    ["a right-to-left override", "Alice\u202E evol", "Alice evol"],
    ["an isolate of its own", "\u2067Alice\u2069", "Alice"],
    ["a zero-width space inside a host", "evil\u200Bgoogle.com", "evilgoogle.com"],
    ["a soft hyphen", "evil\u00ADgoogle.com", "evilgoogle.com"],
    ["a zero-width joiner", "Work\u200DOps", "WorkOps"],
  ])("removes %s", (_what, value, cleaned) => {
    expect(outsideText(value)).toBe(cleaned);
    expect(plainSentence([{ name: value }])).toBe(`“${cleaned}”`);
    expect(plainSentence([{ address: value }])).toBe(cleaned);
  });

  it("keeps a name that imitates Opensteer's words visibly a name", () => {
    expect(
      plainSentence(["Messages from ", { name: "Work, who is allowed to use everything" }, "."]),
    ).toBe("Messages from “Work, who is allowed to use everything”.");
  });
});
