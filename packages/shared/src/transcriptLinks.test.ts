import { describe, expect, it } from "vitest";
import { transcriptLinkUrl } from "./transcriptLinks.js";

describe("transcriptLinkUrl", () => {
  it.each([
    "https://example.test/guide",
    "http://example.test/mirror",
    "mailto:help@example.test",
    "HTTPS://Example.test/upper",
  ])("opens a document: %s", (href) => {
    expect(transcriptLinkUrl(href)?.href).toBe(new URL(href).href);
  });

  it.each([
    // The incident: an agent's absolute path resolved against the app's own
    // origin and replaced the app with a blank page.
    "/Users/person/Downloads/tiger-in-snow.jpg",
    "/settings/devices",
    "docs/portablefs-contract.md",
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
  ])("never opens anything else: %s", (href) => {
    expect(transcriptLinkUrl(href)).toBeNull();
  });
});
