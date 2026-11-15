import type { ReferenceIconName } from "@opensteer/client/references";
import type { SFSymbolName } from "./symbol.js";

/** How mobile draws each reference icon, in the transcript, the composer and its picker. */
export const referenceSymbols: Readonly<Record<ReferenceIconName, SFSymbolName>> = {
  bubble: "bubble.left",
  activity: "waveform.path.ecg",
  hand: "hand.raised",
  quote: "text.quote",
  clock: "clock",
  desktop: "desktopcomputer",
  paperclip: "paperclip",
  file: "doc",
  image: "photo",
  hash: "number",
  reply: "arrowshape.turn.up.left",
  folder: "folder",
  note: "doc.text",
  people: "person.2",
  link: "link",
};
