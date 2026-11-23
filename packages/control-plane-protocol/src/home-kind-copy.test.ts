import { describe, expect, it } from "vitest";
import { homeKindWords, homesChooserTitle, homesListTitle } from "./home-kind-copy.js";

describe("the one table of words for kinds of Home", () => {
  it("names each kind by where it lives", () => {
    expect(homeKindWords("this-mac")).toEqual({ label: "This Mac" });
    expect(homeKindWords("mac")).toEqual({ label: "Mac" });
    expect(homeKindWords("cloud")).toEqual({ label: "Cloud Computer" });
    expect(homeKindWords("server")).toEqual({ label: "Server" });
    expect(homeKindWords("unknown")).toEqual({ label: "" });
  });

  it("titles every list of Homes the same way", () => {
    expect(homesListTitle).toBe("Your Opensteers");
  });

  it("asks for one of that list as a question, not as another list", () => {
    expect(homesChooserTitle).toBe("Choose an Opensteer");
    expect(homesChooserTitle).not.toBe(homesListTitle);
  });
});
