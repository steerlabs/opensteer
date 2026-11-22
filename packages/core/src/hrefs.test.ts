import { describe, expect, it } from "vitest";
import { createId } from "./ids.js";
import { classifyHref } from "./hrefs.js";

describe("classifyHref", () => {
  it("routes personal and absolute file destinations before external URLs", () => {
    expect(classifyHref("opensteer:" + createId("run")).kind).toBe("reference");
    expect(classifyHref("/Users/person/Downloads/tiger-in-snow.jpg")).toEqual({
      kind: "file",
      file: { path: "/Users/person/Downloads/tiger-in-snow.jpg" },
    });
    expect(classifyHref("/settings/devices").kind).toBe("file");
  });

  it.each([
    "https://example.test/guide",
    "http://example.test/mirror",
    "HTTPS://Example.test/upper",
    "mailto:help@example.test",
  ])("keeps document navigation: %s", (href) => {
    expect(classifyHref(href)).toEqual({
      kind: href.startsWith("mailto") ? "mail" : "web",
      url: new URL(href).href,
    });
  });

  it.each([
    "docs/storage-contract.md",
    "./out/report.pdf",
    "../outside.txt",
    "#contract",
    "?tab=files",
    "//cdn.example.test/guide",
    "",
    "file:///Users/person/notes.md",
    "javascript:alert(1)",
    "data:text/html,hello",
    "blob:https://example.test/0b5e6612",
    "app://opensteer/settings",
    "com.opensteer.mobile:/deployments/another",
    "tel:123456",
    "ftp://example.test/file",
    "https://reader:secret@example.test/private",
    "https://reader@example.test/private",
    "opensteer:future_id",
    "https://example.test/\nprivate",
    "\\\\server\\file",
    "%2f%2fserver/file",
    "~/file",
  ])("keeps unsafe or unsupported destinations inert: %s", (href) => {
    expect(classifyHref(href)).toEqual({ kind: "none" });
  });
});
