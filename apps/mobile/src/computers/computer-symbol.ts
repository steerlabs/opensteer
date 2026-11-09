import type { ComputerGlyph } from "@opensteer/client/computers";

/** The system's own picture of each kind of place. */
export type ComputerSymbol =
  "desktopcomputer" | "laptopcomputer" | "macmini" | "server.rack" | "smartphone";

export const computerSymbols: Readonly<Record<ComputerGlyph, ComputerSymbol>> = {
  compact: "macmini",
  computer: "desktopcomputer",
  desktop: "desktopcomputer",
  laptop: "laptopcomputer",
  phone: "smartphone",
  server: "server.rack",
};
