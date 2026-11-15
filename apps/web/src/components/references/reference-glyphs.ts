import { classifyHref, type ReferenceKind, type TeamPageTarget } from "@opensteer/core";
import type { IconName } from "../icon.js";

/** What each kind of thing a chip names looks like, in the transcript and the composer alike. */
export const referenceGlyphs: Readonly<Record<ReferenceKind, IconName>> = {
  task: "message",
  run: "activity",
  request: "hand",
  message: "corner-down-right",
  automation: "clock",
  computer: "desktop",
  attachment: "paperclip",
};

export const teamPageGlyphs: Readonly<Record<TeamPageTarget["kind"], IconName>> = {
  invite: "users",
  channel: "hash",
  message: "corner-down-right",
  thread: "reply",
  "knowledge-topic": "folder",
  "knowledge-note": "file",
};

export function fileGlyph(path: string): IconName {
  return /\.(?:avif|gif|heic|jpe?g|png|svg|webp)$/iu.test(path) ? "image" : "file";
}

export function hrefGlyph(href: string): IconName {
  const target = classifyHref(href);
  switch (target.kind) {
    case "reference":
      return referenceGlyphs[target.reference.kind];
    case "team-page":
      return teamPageGlyphs[target.page.target.kind];
    case "file":
      return fileGlyph(target.file.path);
    default:
      return "link";
  }
}
