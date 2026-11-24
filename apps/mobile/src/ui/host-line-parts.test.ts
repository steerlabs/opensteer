import { describe, expect, it } from "vitest";
import { hostLineParts, planHostLine } from "./host-line-parts.js";

describe("a one-line host's parts", () => {
  it.each([
    ["evil-google.com", "", [], "evil-google.com"],
    ["accounts.google.com.evil.example", "", ["accounts.", "google.", "com."], "evil.example"],
    ["xn--pypal-4ve.com", "", [], "xn--pypal-4ve.com"],
    ["http://192.168.1.20:8080", "http://", [], "192.168.1.20:8080"],
    ["http://evil.example", "http://", [], "evil.example"],
    [
      "shop.averyveryverylongcompanyname.co.uk",
      "",
      ["shop."],
      "averyveryverylongcompanyname.co.uk",
    ],
    [
      "http://accounts.google.com.evil.example:8443",
      "http://",
      ["accounts.", "google.", "com."],
      "evil.example:8443",
    ],
    ["user.github.io", "", [], "user.github.io"],
    ["localhost:3000", "", [], "localhost:3000"],
  ])("keeps the registrable domain of %s whole", (host, scheme, labels, kept) => {
    const parts = hostLineParts(host);
    expect(parts).toEqual({ kept, labels, scheme });
    expect(`${parts.scheme}${parts.labels.join("")}${parts.kept}`).toBe(host);
  });
});

describe("what a one-line host draws in its room", () => {
  // Each character 10 wide, an ellipsis 10.
  const plan = (host: string, room: number, before = "", after = "") => {
    const parts = hostLineParts(host);
    const pieces: Record<string, string> = {
      after,
      before,
      ellipsis: "…",
      kept: parts.kept,
      scheme: parts.scheme,
      ...Object.fromEntries(parts.labels.map((label, index) => [`label:${index}`, label])),
    };
    return planHostLine({ parts, room, width: (piece) => (pieces[piece] ?? "").length * 10 });
  };

  it("draws it all where it fits", () => {
    expect(plan("github.com", 200, "· ", " says")).toEqual({
      after: "whole",
      before: true,
      dropped: 0,
      kind: "line",
    });
  });

  it("gives up the words around it first, entirely, before any of the host", () => {
    // The host fits alone, with room for a stump of what follows it.
    expect(plan("github.com", 140, "Switch to tab · ", " · Loading…")).toEqual({
      after: "stump",
      before: false,
      dropped: 0,
      kind: "line",
    });
    // The host loses a label: nothing around it is drawn.
    expect(plan("accounts.google.com.evil.example", 250, "· ", " · Loading…")).toEqual({
      after: "none",
      before: false,
      dropped: 1,
      kind: "line",
    });
  });

  it("gives up whole labels from the left, never the registrable domain", () => {
    // "…com.evil.example" is 170; "…evil.example", 130.
    expect(plan("accounts.google.com.evil.example", 170)).toMatchObject({ dropped: 2 });
    expect(plan("accounts.google.com.evil.example", 140)).toMatchObject({ dropped: 3 });
    expect(plan("accounts.google.com.evil.example", 110)).toEqual({ kind: "wrap" });
    // A registrable domain, an IP address with its port: never cut, so a second line.
    expect(plan("evil-google.com", 110)).toEqual({ kind: "wrap" });
    expect(plan("http://192.168.1.20:8080", 200)).toEqual({ kind: "wrap" });
    expect(plan("http://evil.example", 30)).toEqual({ kind: "wrap" });
  });
});
