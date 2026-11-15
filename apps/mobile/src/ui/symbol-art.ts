import type { SFSymbolName } from "./symbol.js";

/**
 * One 24×24 stroke path per name, web's own artwork, for every glyph a
 * reference chip wears. The native composer draws the same paths.
 */
export const symbolArt: Partial<Record<SFSymbolName, string>> = {
  "arrowshape.turn.up.left": "m9 14-5-5 5-5M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20",
  "bubble.left": "M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 21l1.6-4.8A8.5 8.5 0 1 1 21 12Z",
  clock: "M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 7.5V12l3 2",
  desktopcomputer:
    "M5.2 3.8h13.6a2.2 2.2 0 0 1 2.2 2.2v8.2a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 14.2V6a2.2 2.2 0 0 1 2.2-2.2ZM12 16.4v3.6M8.5 20.2h7",
  doc: "M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3ZM13.5 3v5.5H19",
  "doc.text":
    "M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L13.5 3ZM13.5 3v5.5H19M8.5 13h7M8.5 16.5h5",
  folder: "M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.6L9.6 5H5a2 2 0 0 0-2 2.5Z",
  "hand.raised":
    "M7 14.2V8a1.5 1.5 0 0 1 3 0v4M10 11.5V5.5a1.5 1.5 0 0 1 3 0v6M13 11.5V6.5a1.5 1.5 0 0 1 3 0v5M16 11.5V9a1.5 1.5 0 0 1 3 0v5.5a6.5 6.5 0 0 1-6.5 6.5h-1.3a6 6 0 0 1-4.6-2.2l-3-3.8a1.5 1.5 0 0 1 2.2-2L7 14.2",
  link: "M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1",
  number: "M9.5 3.5 7.5 20.5M16.5 3.5l-2 17M4 8.5h16.5M3.5 15.5H20",
  paperclip:
    "m20 11-7.8 7.8a5 5 0 0 1-7-7L13 4a3.4 3.4 0 0 1 4.8 4.8l-7.6 7.6a1.7 1.7 0 0 1-2.4-2.4L15 6.8",
  "person.2":
    "M6 9a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3.6 18.6c.7-2.9 2.9-4.3 5.4-4.3s4.7 1.4 5.4 4.3M13.9 9.6a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0-4.8 0M15.6 14.3c2.2 0 3.8 1.1 4.7 3.5",
  photo:
    "M6 4.5h12a2.5 2.5 0 0 1 2.5 2.5v10a2.5 2.5 0 0 1-2.5 2.5H6A2.5 2.5 0 0 1 3.5 17V7A2.5 2.5 0 0 1 6 4.5ZM7.4 10a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0M4 17l5-4.5 4 3.5 3-2.5 4 3.5",
  "text.quote": "M17 6H3M21 12H8M21 18H8M3 12v6",
  "waveform.path.ecg": "M22 12h-4l-3 8L9 4l-3 8H2",
};
