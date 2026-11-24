import { browserSiteForUrl } from "@opensteer/client/host";

/**
 * A host on one line (`HostLine`), as the parts it may give up and the part it never does. The
 * registrable domain is the one every client names a site by (`browserSiteForUrl`: the public
 * suffix list, private suffixes included), so `evil-google.com` is never shown as `…google.com`,
 * nor `accounts.google.com.evil.example` as anything without `evil.example`.
 */
export interface HostLineParts {
  /** A scheme the host is shown with (one that is not https): a warning, never given up. */
  readonly scheme: string;
  /** The labels left of the registrable domain, each with its dot: given up whole, from the left. */
  readonly labels: readonly string[];
  /**
   * The registrable domain and its port, or the whole host where it has none (an IP address,
   * `localhost`, a name under no public suffix): never cut, and a punycode label never inside.
   */
  readonly kept: string;
}

export function hostLineParts(host: string): HostLineParts {
  const scheme = /^[a-z][a-z\d+.-]*:\/\//iu.exec(host)?.[0] ?? "";
  const rest = host.slice(scheme.length);
  const port = /:\d+$/u.exec(rest)?.[0] ?? "";
  const name = rest.slice(0, rest.length - port.length);
  const site = browserSiteForUrl(`${scheme === "" ? "https://" : scheme}${name}`);
  const registrable = site === null ? null : new URL(site).hostname;
  const lower = name.toLowerCase();
  if (registrable === null || !lower.endsWith(`.${registrable}`))
    return { kept: `${name}${port}`, labels: [], scheme };
  const prefix = name.slice(0, name.length - registrable.length);
  return {
    kept: `${name.slice(prefix.length)}${port}`,
    labels: prefix.split(/(?<=\.)/u).filter((label) => label !== ""),
    scheme,
  };
}

/** What a one-line host draws in the room it has. */
export type HostLinePlan =
  | {
      readonly kind: "line";
      /** Whether the words before the host are drawn. */
      readonly before: boolean;
      /** How many of its leading labels it gives up, behind an ellipsis. */
      readonly dropped: number;
      /** The words after it: whole, cut at their end while the host is whole, or not drawn. */
      readonly after: "whole" | "stump" | "none";
    }
  /** The host does not fit on one line even with every label it may give up gone: it wraps. */
  | { readonly kind: "wrap" };

/**
 * The words around the host go first, entirely: no stump of them while the host has lost
 * anything. Then the host's leading labels, whole, from the left. When even its registrable
 * domain does not fit, the line takes a second line: it is never cut, and never crushed to
 * nothing behind a scheme.
 */
export function planHostLine(input: {
  readonly parts: HostLineParts;
  readonly room: number;
  /** Each piece's width as drawn: "before", "after", "scheme", "ellipsis", "kept", "label:<i>". */
  readonly width: (piece: string) => number;
}): HostLinePlan {
  const { parts, room, width } = input;
  const fits = (needed: number) => needed <= room + 0.5;
  const host = (dropped: number) =>
    width("scheme") +
    (dropped > 0 ? width("ellipsis") : 0) +
    parts.labels
      .slice(dropped)
      .reduce((sum, _label, index) => sum + width(`label:${index + dropped}`), 0) +
    width("kept");
  if (fits(width("before") + host(0) + width("after")))
    return { after: "whole", before: true, dropped: 0, kind: "line" };
  if (fits(host(0)))
    return {
      after: width("after") > 0 && room - host(0) >= 3 * width("ellipsis") ? "stump" : "none",
      before: false,
      dropped: 0,
      kind: "line",
    };
  for (let dropped = 1; dropped <= parts.labels.length; dropped += 1)
    if (fits(host(dropped))) return { after: "none", before: false, dropped, kind: "line" };
  return { kind: "wrap" };
}
