/** A web address as a person reads it, with the site separated from its path. */
export function browserAddressParts(
  url: string,
): { readonly host: string; readonly rest: string } | null {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
    let readable = rest;
    try {
      readable = decodeURI(rest);
    } catch {
      /* Preserve addresses with invalid escapes. */
    }
    return { host: parsed.host.replace(/^www\./i, ""), rest: readable };
  } catch {
    return null;
  }
}
