import { browserSiteLabel } from "@opensteer/client/host";

/**
 * A tab's site as every client names it beside a title: its registrable
 * domain, from an address or a bare host; null for a page with none.
 */
export function tabSiteLabel(site: string | null): string | null {
  if (site === null || site === "") return null;
  return browserSiteLabel(/^[a-z][a-z\d+.-]*:/iu.test(site) ? site : `https://${site}`) || null;
}
