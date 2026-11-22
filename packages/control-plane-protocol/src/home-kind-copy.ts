import { orgWords } from "./organization-copy.js";

/**
 * The one table of words for what kind of Home a row is, read by the Opensteer website's
 * portal, the desktop and the phone, so a Home is called the same thing everywhere. A Home is
 * described by where it lives and who owns it; the row's title is always the Home's own name.
 *
 * - `this-mac`: the Mac this app runs on hosts it (desktop only).
 * - `mac`: a person's Mac elsewhere.
 * - `cloud`: an Opensteer Cloud Computer.
 * - `server`: a Linux server of the person's own.
 * - `work`: a Cloud Computer an organization owns; it also carries a badge.
 * - `unknown`: not known yet. It says no kind rather than a wrong one.
 */
export type HomeKindWord = "this-mac" | "mac" | "cloud" | "server" | "work" | "unknown";

export const homeKindCopy = {
  "this-mac": "This Mac",
  mac: "Mac",
  cloud: "Cloud Computer",
  server: "Server",
  work: "Cloud Computer",
  unknown: "",
} as const satisfies Record<HomeKindWord, string>;

/** What a list of a person's Homes is titled, on the desktop, the phone and the portal. */
export const homesListTitle = "Your Opensteers";

/**
 * What a screen that asks a person to pick one of their Homes is titled. It is a question, not a
 * second list: the list it asks about is the same one, named `homesListTitle` there too.
 */
export const homesChooserTitle = "Choose an Opensteer";

export function homeKindWords(
  kind: HomeKindWord,
  input: { readonly organization?: string | null } = {},
): { readonly label: string; readonly badge: string | null } {
  return {
    label: homeKindCopy[kind],
    badge:
      kind === "work" && input.organization
        ? orgWords("org.work.badge", { organization: input.organization })
        : null,
  };
}
