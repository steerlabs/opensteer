import { describe, expect, it } from "vitest";
import { fileHref, parseFileHref } from "./fileHref.js";
import { markdownLink } from "./markdownLinks.js";
import { markdownSourceTree } from "./markdownParser.js";

describe("file hrefs", () => {
  it.each([
    ["/tmp/a.ts:42", { path: "/tmp/a.ts", line: 42 }],
    ["/tmp/a.ts:42:3", { path: "/tmp/a.ts", line: 42, column: 3 }],
    ["/tmp/a.ts:42-64", { path: "/tmp/a.ts", line: 42, endLine: 64 }],
    ["/tmp/a.ts#L42", { path: "/tmp/a.ts", line: 42 }],
    ["/tmp/a.ts#L42C3", { path: "/tmp/a.ts", line: 42, column: 3 }],
    ["C:\\work\\a.ts:2", { path: "C:\\work\\a.ts", line: 2 }],
    ["/tmp/a%3A42", { path: "/tmp/a:42" }],
    ["/tmp/a%2520b", { path: "/tmp/a%20b" }],
  ])("splits positions before decoding %s", (href, target) =>
    expect(parseFileHref(href as string)).toEqual(target),
  );

  it.each([
    "relative/file",
    "./file",
    "../file",
    "~/file",
    "file:///tmp/a",
    "//host/file",
    "\\\\host\\file",
    "\\\\?\\C:\\file",
    "/\\server/file",
    "%2F%2Fhost/file",
    "/tmp/%00file",
    "/tmp/%ZZ",
    "/tmp/a:0",
    "/tmp/a:1:0",
    "/tmp/a:9-2",
    "/tmp/a:9999999999999999999",
  ])("rejects %s", (href) => expect(parseFileHref(href)).toBeNull());

  it("round-trips punctuation and percent literals through real Markdown once", () => {
    for (const path of [
      "/tmp/a (b) [c] ?#%20&\\x:42.txt",
      "C:\\work\\a (b)#.ts",
      "/tmp/a\u2003b:42",
    ]) {
      const target = { path, line: 3, endLine: 8 };
      const tree = markdownSourceTree(markdownLink("file [one]", fileHref(target)));
      const paragraph = tree.children[0];
      if (paragraph?.type !== "paragraph" || paragraph.children[0]?.type !== "link")
        throw new Error("Expected a link");
      expect(parseFileHref(paragraph.children[0].url)).toEqual(target);
    }
  });
});
