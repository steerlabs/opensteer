import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { browserSiteFromUrl } from "./source-state.js";

/**
 * The Host names a sign-in's site with tldts; Opensteer Passwords matches
 * saved items against it with its own Public Suffix List code in Swift. If the
 * two ever disagreed, a site could match items from a neighbouring tenant or
 * none at all, so both sides read the same fixtures.
 *
 * Ways this goes wrong, each caught here:
 * - a tldts upgrade or a refreshed Swift list moves a registrable domain;
 * - case or a trailing dot normalizes differently;
 * - the Host accepts as a site a host the broker treats as a public suffix.
 *
 * IP addresses and `localhost` are a site to the Host but never to the
 * broker, which refuses them; that direction only fails closed.
 */
const SiteFixturesSchema = z.array(
  z.strictObject({ host: z.string().min(1), registrableDomain: z.string().min(1).nullable() }),
);
const fixtures = SiteFixturesSchema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../apps/desktop/native/passwords/Tests/PasswordsCoreTests/Fixtures/site-fixtures.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const ownSites = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})$/u;

describe("password site parity with Opensteer Passwords", () => {
  it.each(fixtures)("$host", ({ host, registrableDomain }) => {
    if (registrableDomain !== null) {
      expect(browserSiteFromUrl(`https://${host}`)).toBe(`https://${registrableDomain}`);
      return;
    }
    let site: string;
    try {
      site = browserSiteFromUrl(`https://${host}`);
    } catch {
      return;
    }
    expect(new URL(site).hostname).toMatch(ownSites);
  });
});
