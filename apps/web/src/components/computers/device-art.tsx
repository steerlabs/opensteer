import type { ComputerGlyph } from "@opensteer/client/computers";
import type { ReactNode } from "react";
import type { IconName } from "../icon.js";

/** What a place looks like: a computer's own shape, Opensteer Cloud, or a server. */
export type PlaceArt = ComputerGlyph | "cloud";

/** The line icon a computer wears in a list. */
export function computerIcon(glyph: ComputerGlyph): IconName {
  switch (glyph) {
    case "laptop":
      return "laptop";
    case "compact":
      return "compact";
    case "server":
      return "server";
    case "phone":
      return "phone";
    case "desktop":
    case "computer":
      return "desktop";
  }
}

/**
 * A place drawn as the object it is, for the top of a page. The shapes are
 * the ones people own — a MacBook, an iMac, a Mac mini, a rack server, a
 * phone — so the picture answers "which one is this?" before the name is read.
 */
export function DeviceArt({ art }: { readonly art: PlaceArt }) {
  return (
    <span aria-hidden className="device-art">
      <svg viewBox="0 0 96 72">{drawings[art]}</svg>
    </span>
  );
}

const drawings: Readonly<Record<PlaceArt, ReactNode>> = {
  laptop: (
    <>
      <rect className="device-art__body" height="36" rx="3.5" width="56" x="20" y="10" />
      <rect className="device-art__screen" height="28" rx="1.5" width="48" x="24" y="14" />
      <path className="device-art__glint" d="M30 24h20M30 29h28M30 34h13" />
      <path className="device-art__base" d="M10 47h76l-4 7H14Z" />
      <path className="device-art__notch" d="M42 47h12" />
    </>
  ),
  desktop: (
    <>
      <rect className="device-art__body" height="44" rx="4" width="64" x="16" y="6" />
      <rect className="device-art__screen" height="31" rx="1.5" width="56" x="20" y="10" />
      <path className="device-art__glint" d="M26 20h22M26 25h30M26 30h14" />
      <path className="device-art__base" d="M42 50l-2 12h16l-2-12Z" />
      <path className="device-art__foot" d="M34 62.5h28" />
    </>
  ),
  computer: (
    <>
      <rect className="device-art__body" height="40" rx="4" width="64" x="16" y="8" />
      <rect className="device-art__screen" height="30" rx="1.5" width="56" x="20" y="12" />
      <path className="device-art__base" d="M45 48v10h6V48Z" />
      <path className="device-art__foot" d="M36 60h24" />
    </>
  ),
  compact: (
    <>
      <path className="device-art__top" d="M12 36 48 24l36 12-36 12Z" />
      <path className="device-art__side" d="M12 36l36 12v9L12 45Z" />
      <path className="device-art__side device-art__side--shade" d="m48 48 36-12v9L48 57Z" />
      <circle className="device-art__light" cx="19" cy="41.5" r="1.4" />
      <path className="device-art__seam" d="M36 36.5Q48 31 60 36.5" />
    </>
  ),
  server: (
    <>
      <rect className="device-art__body" height="16" rx="3" width="60" x="18" y="12" />
      <rect
        className="device-art__body device-art__body--shade"
        height="16"
        rx="3"
        width="60"
        x="18"
        y="31"
      />
      <rect
        className="device-art__body device-art__body--deep"
        height="12"
        rx="3"
        width="60"
        x="18"
        y="50"
      />
      <circle className="device-art__led" cx="26" cy="20" r="1.6" />
      <circle className="device-art__led" cx="26" cy="39" r="1.6" />
      <circle className="device-art__light" cx="26" cy="56" r="1.6" />
      <path className="device-art__glint" d="M50 20h20M50 39h20M50 56h20" />
    </>
  ),
  phone: (
    <>
      <rect className="device-art__body" height="62" rx="6" width="34" x="31" y="5" />
      <rect className="device-art__screen" height="48" rx="1.5" width="28" x="34" y="12" />
      <path className="device-art__notch" d="M45 8.5h6" />
      <path className="device-art__glint" d="M39 22h12M39 27h18M39 32h8" />
      <path className="device-art__foot" d="M44 63.5h8" />
    </>
  ),
  cloud: (
    <>
      <path
        className="device-art__body"
        d="M28 56h42a13 13 0 0 0 2.5-25.8A19 19 0 0 0 36.5 25.5 15 15 0 0 0 28 56Z"
      />
      <path className="device-art__glint" d="M38 38h12" />
      <path className="device-art__accent" d="M38 44h20" />
    </>
  ),
};
