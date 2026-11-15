import type { ReferenceIconName } from "@opensteer/client/references";
import type { IconName } from "../icon.js";

/** How web draws each reference icon, in the transcript and the composer alike. */
export const referenceGlyphs: Readonly<Record<ReferenceIconName, IconName>> = {
  bubble: "message",
  activity: "activity",
  hand: "hand",
  quote: "quote",
  clock: "clock",
  desktop: "desktop",
  paperclip: "paperclip",
  file: "file",
  image: "image",
  hash: "hash",
  reply: "reply",
  folder: "folder",
  note: "note",
  people: "users",
  link: "link",
};
