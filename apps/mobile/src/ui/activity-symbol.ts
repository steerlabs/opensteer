import type { ActivityIcon } from "@opensteer/client/host";
import type { SFSymbolName } from "./symbol.js";

/** How this app draws each step glyph the shared activity model names. */
export const activitySymbol: Record<ActivityIcon, SFSymbolName> = {
  "alert-circle": "exclamationmark.circle",
  asterisk: "lightbulb",
  browser: "safari",
  "check-circle": "checkmark.circle",
  file: "doc.text",
  folder: "folder",
  globe: "globe",
  laptop: "laptopcomputer",
  list: "list.bullet",
  pencil: "pencil",
  puzzle: "puzzlepiece.extension",
  search: "magnifyingglass",
  share: "arrow.triangle.branch",
  sparkles: "sparkles",
  stop: "stop.circle",
  terminal: "terminal",
};
