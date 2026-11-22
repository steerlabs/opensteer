import { describe, expect, it } from "vitest";
import { homeKindWords, homesListTitle } from "./home-kind-copy.js";

describe("the one table of words for kinds of Home", () => {
  it("names each kind by where it lives, and only a work Home carries its organization", () => {
    expect(homeKindWords("this-mac")).toEqual({ label: "This Mac", badge: null });
    expect(homeKindWords("mac")).toEqual({ label: "Mac", badge: null });
    expect(homeKindWords("cloud")).toEqual({ label: "Cloud Computer", badge: null });
    expect(homeKindWords("server")).toEqual({ label: "Server", badge: null });
    expect(homeKindWords("work", { organization: "Acme" })).toEqual({
      label: "Cloud Computer",
      badge: "Work · Acme",
    });
    expect(homeKindWords("cloud", { organization: "Acme" }).badge).toBeNull();
    expect(homeKindWords("unknown")).toEqual({ label: "", badge: null });
  });

  it("titles every list of Homes the same way", () => {
    expect(homesListTitle).toBe("Your Opensteers");
  });
});
