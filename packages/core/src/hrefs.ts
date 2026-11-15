import { parseFileHref, isNetworkPath, type FileLinkTarget } from "@opensteer/shared/fileHref";
import { parseReferenceHref, type Reference } from "./references.js";
import { parseTeamPageLink, type TeamPageLink } from "./team-links.js";

export type ClassifiedHref =
  | { readonly kind: "reference"; readonly reference: Reference }
  | { readonly kind: "team-page"; readonly page: TeamPageLink }
  | { readonly kind: "file"; readonly file: FileLinkTarget }
  | { readonly kind: "web"; readonly url: string }
  | { readonly kind: "mail"; readonly url: string }
  | { readonly kind: "none" };

export function classifyHref(href: string): ClassifiedHref {
  if (!href || href !== href.trim() || /\p{Cc}/u.test(href) || isNetworkPath(href))
    return { kind: "none" };
  const reference = parseReferenceHref(href);
  if (reference) return { kind: "reference", reference };
  const page = parseTeamPageLink(href);
  if (page) return { kind: "team-page", page };
  const file = parseFileHref(href);
  if (file) return { kind: "file", file };
  try {
    const url = new URL(href);
    if (url.username || url.password) return { kind: "none" };
    if (/^https?:$/u.test(url.protocol)) return { kind: "web", url: url.href };
    if (url.protocol === "mailto:") return { kind: "mail", url: url.href };
  } catch {
    /* Unsupported destinations stay words. */
  }
  return { kind: "none" };
}
