import { describe, expect, it } from "vitest";
import { matchSearch, rankSearch, searchQuery, searchText, type SearchMatch } from "./search.js";

/** One item's fields, the first its name, each with its weight. */
function match(
  query: string,
  ...fields: ReadonlyArray<readonly [string | null, number, "inside"?]>
) {
  return matchSearch(
    fields.map(([text, weight, inside]) => ({
      text: searchText(text ?? ""),
      weight,
      inside: inside === "inside",
    })),
    searchQuery(query),
  );
}

/** The parts of `text` a match lights. */
function lit(text: string, found: SearchMatch | null): string[] {
  return (found?.ranges ?? []).map(({ start, end }) => text.slice(start, end));
}

describe("search matching", () => {
  it("ignores case and accents, and lights the source text where it matched", () => {
    expect(lit("Café Lisboa", match("CAFE", ["Café Lisboa", 1]))).toEqual(["Café"]);
    expect(lit("cafe lisboa", match("café", ["cafe lisboa", 1]))).toEqual(["cafe"]);
    // Written with separate accents, a word still reads whole, and lights with its accent.
    const accent = String.fromCodePoint(0x301);
    const decomposed = `Cafe${accent}s Lisboa`;
    expect(lit(decomposed, match("cafes", [decomposed, 1]))).toEqual([`Cafe${accent}s`]);
    expect(lit(decomposed, match("café", [decomposed, 1]))).toEqual([`Cafe${accent}`]);
    expect(lit(decomposed, match("lisboa", [decomposed, 1]))).toEqual(["Lisboa"]);
  });

  it("lights the source across characters that fold to more or fewer units", () => {
    expect(lit("🚀 Launch plan", match("launch", ["🚀 Launch plan", 1]))).toEqual(["Launch"]);
    expect(lit("ﬁnance review", match("fin", ["ﬁnance review", 1]))).toEqual(["ﬁn"]);
    expect(lit("𝐀pple notes", match("apple", ["𝐀pple notes", 1]))).toEqual(["𝐀pple"]);
    expect(lit("İstanbul trip", match("istanbul", ["İstanbul trip", 1]))).toEqual(["İstanbul"]);
    expect(lit("Ｑ４ plan", match("q4", ["Ｑ４ plan", 1]))).toEqual(["Ｑ４"]);
    expect(lit("Straße Berlin", match("berlin", ["Straße Berlin", 1]))).toEqual(["Berlin"]);
  });

  it("keeps the marks that change a word outside Latin, Greek and Cyrillic", () => {
    expect(match("が", ["がっこう", 1])).not.toBeNull();
    expect(match("か", ["がっこう", 1])).toBeNull();
    expect(match("한국", ["한국 여행", 1])).not.toBeNull();
  });

  it("finds words by their start: after punctuation, at camelCase and digits, and in CJK text", () => {
    expect(
      lit("Pull requests · steerlabs", match("req", ["Pull requests · steerlabs", 1])),
    ).toEqual(["req"]);
    expect(lit("openSteer notes", match("steer", ["openSteer notes", 1]))).toEqual(["Steer"]);
    expect(lit("Q4 revenue model", match("4", ["Q4 revenue model", 1]))).toEqual(["4"]);
    expect(lit("東京タワー 予約", match("タワー", ["東京タワー 予約", 1]))).toEqual(["タワー"]);
  });

  it("finds three or more letters inside a word, never one or two, where the field allows it", () => {
    expect(match("del", ["Revenue model", 1, "inside"])).not.toBeNull();
    expect(match("de", ["Revenue model", 1, "inside"])).toBeNull();
    expect(match("o", ["Revenue model", 1, "inside"])).toBeNull();
    // At a word start a single letter is enough.
    expect(match("m", ["Revenue model", 1, "inside"])).not.toBeNull();
    // A field that does not allow it finds words by their start alone.
    expect(match("del", ["Revenue model", 1])).toBeNull();
    expect(match("mod", ["Revenue model", 1])).not.toBeNull();
  });

  it("needs every word, in any order, each in any field", () => {
    expect(match("nopa resy", ["Nopa – Resy", 1])).not.toBeNull();
    expect(match("resy nopa", ["Nopa – Resy", 1])).not.toBeNull();
    expect(match("nopa gmail", ["Nopa – Resy", 1])).toBeNull();
    expect(
      match("pull work", ["Pull requests", 1], ["github.com", 0.8], ["Work", 0.5]),
    ).not.toBeNull();
  });

  it("reads typed punctuation as part of the word", () => {
    expect(match("notion.so", ["Q4 plan", 1], ["notion.so", 0.8])).not.toBeNull();
    expect(match("e-mail", ["Write the e-mail", 1])).not.toBeNull();
    expect(match("notion.com", ["Q4 plan", 1], ["notion.so", 0.8])).toBeNull();
  });

  it("matches nothing for an empty query or fields with no text", () => {
    expect(searchQuery("   ")).toEqual([]);
    expect(match("", ["Anything", 1])).toBeNull();
    expect(match("work", [null, 1], ["", 0.5])).toBeNull();
  });

  it("explains a match the name does not show with the field that holds it", () => {
    const found = match("github", ["Pull requests", 1], ["github.com", 0.8], ["Work", 0.5]);
    expect(found?.ranges).toEqual([]);
    expect(found?.hint).toEqual({ field: 1, ranges: [{ start: 0, end: 6 }] });
    // Lit in the name, it needs no other field to explain it.
    expect(match("pull", ["Pull requests", 1], ["github.com", 0.8])?.hint).toBeNull();
    // Split between them, each lights where it is.
    const split = match("pull work", ["Pull requests", 1], ["github.com", 0.8], ["Work", 0.5]);
    expect(lit("Pull requests", split)).toEqual(["Pull"]);
    expect(split?.hint).toEqual({ field: 2, ranges: [{ start: 0, end: 4 }] });
  });

  it("merges the ranges of words that overlap or touch", () => {
    expect(match("launch lau", ["Launch brief", 1])?.ranges).toEqual([{ start: 0, end: 6 }]);
    expect(lit("Book a table", match("table book", ["Book a table", 1]))).toEqual([
      "Book",
      "table",
    ]);
  });
});

describe("search ranking", () => {
  const items = [
    {
      id: "context-mid",
      fields: [
        ["Weekly sync", 1],
        ["Homework", 0.5, "inside"],
      ],
    },
    { id: "title-mid", fields: [["Homework plan", 1, "inside"]] },
    {
      id: "context-start",
      fields: [
        ["Weekly sync", 1],
        ["Work", 0.5],
      ],
    },
    { id: "title-word", fields: [["Draft work notes", 1]] },
    { id: "title-prefix", fields: [["Work notes", 1]] },
    { id: "title-exact", fields: [["Work", 1]] },
    { id: "none", fields: [["Lunch", 1]] },
  ] as const;

  it("puts the whole name first, then its start, a word in it, then other fields, then inside words", () => {
    const ranked = rankSearch(items, (item) => match("work", ...item.fields));
    expect(ranked.map(({ item }) => item.id)).toEqual([
      "title-exact",
      "title-prefix",
      "title-word",
      "context-start",
      "title-mid",
      "context-mid",
    ]);
  });

  it("keeps the given order between equal matches", () => {
    const tabs = ["Nopa – Resy", "Nopa – OpenTable", "Nopa menu"];
    const ranked = rankSearch(tabs, (title) => match("nopa", [title, 1]));
    expect(ranked.map(({ item }) => item)).toEqual([
      "Nopa – Resy",
      "Nopa – OpenTable",
      "Nopa menu",
    ]);
  });
});
