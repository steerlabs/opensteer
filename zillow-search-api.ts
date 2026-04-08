/**
 * Zillow Property Search API — reverse-engineered via Opensteer
 *
 * API: PUT https://www.zillow.com/async-create-search-page-state
 * Transport: page-http (requires browser session with PerimeterX cookies)
 * Auth: PerimeterX session (_pxvid, pxcts) + Zillow session (zguid, zgsession, JSESSIONID)
 *
 * Strategy: Set up a route interceptor, navigate to a Zillow search URL, and
 * capture the API response that Zillow's own client code triggers during page load.
 * The API returns full listing data as JSON (typically 500+ results per page).
 *
 * Required browser setup: Clone a real Chrome profile to carry existing cookies
 * past Zillow's PerimeterX bot detection.
 */

import { Opensteer } from "./packages/opensteer/src/index.js";

interface ZillowListing {
  zpid: string;
  address: string;
  price: number;
  formattedPrice: string;
  beds: number;
  baths: number;
  sqft: number;
  homeType: string;
  url: string;
  latitude: number;
  longitude: number;
  statusType: string;
  daysOnZillow: number;
}

interface ZillowSearchResult {
  totalResults: number;
  totalPages: number;
  currentPage: number;
  listings: ZillowListing[];
  regionName: string;
  regionId: number;
}

const KNOWN_REGIONS: Record<string, { slug: string; regionId: number; regionType: number }> = {
  "san francisco": { slug: "san-francisco-ca", regionId: 20330, regionType: 6 },
  "los angeles": { slug: "los-angeles-ca", regionId: 12447, regionType: 6 },
  "new york": { slug: "new-york-ny", regionId: 6181, regionType: 6 },
  seattle: { slug: "seattle-wa", regionId: 16037, regionType: 6 },
  austin: { slug: "austin-tx", regionId: 10221, regionType: 6 },
  denver: { slug: "denver-co", regionId: 11093, regionType: 6 },
  chicago: { slug: "chicago-il", regionId: 17426, regionType: 6 },
  miami: { slug: "miami-fl", regionId: 12700, regionType: 6 },
  portland: { slug: "portland-or", regionId: 13373, regionType: 6 },
  boston: { slug: "boston-ma", regionId: 44269, regionType: 6 },
};

function parseListings(data: Record<string, unknown>): ZillowListing[] {
  const cat1 = data.cat1 as Record<string, unknown> | undefined;
  if (!cat1) return [];

  const searchResults = cat1.searchResults as Record<string, unknown> | undefined;
  if (!searchResults) return [];

  const mapResults = (searchResults.mapResults ?? []) as Record<string, unknown>[];
  const listResults = (searchResults.listResults ?? []) as Record<string, unknown>[];
  const raw = listResults.length > 0 ? listResults : mapResults;

  return raw.map((r) => {
    const hdpData = r.hdpData as Record<string, unknown> | undefined;
    const homeInfo = (hdpData?.homeInfo ?? {}) as Record<string, unknown>;

    return {
      zpid: String(r.zpid ?? homeInfo.zpid ?? ""),
      address: String(r.address ?? r.addressStreet ?? homeInfo.streetAddress ?? ""),
      price: Number(r.unformattedPrice ?? homeInfo.price ?? 0),
      formattedPrice: String(r.price ?? `$${Number(r.unformattedPrice ?? 0).toLocaleString()}`),
      beds: Number(r.beds ?? homeInfo.bedrooms ?? 0),
      baths: Number(r.baths ?? homeInfo.bathrooms ?? 0),
      sqft: Number(r.area ?? homeInfo.livingArea ?? 0),
      homeType: String(homeInfo.homeType ?? r.hdpTypeDimension ?? ""),
      url: String(r.detailUrl ?? ""),
      latitude: Number(r.latLong?.latitude ?? homeInfo.latitude ?? 0),
      longitude: Number(r.latLong?.longitude ?? homeInfo.longitude ?? 0),
      statusType: String(r.statusType ?? homeInfo.homeStatus ?? ""),
      daysOnZillow: Number(homeInfo.daysOnZillow ?? -1),
    };
  });
}

async function searchZillow(query: string, page = 1): Promise<ZillowSearchResult> {
  const key = query.toLowerCase().trim();
  const region = KNOWN_REGIONS[key];
  const slug = region?.slug ?? key.replace(/[, ]+/g, "-").toLowerCase();
  const searchUrl =
    page > 1
      ? `https://www.zillow.com/${slug}/${page}_p/`
      : `https://www.zillow.com/${slug}/`;

  const opensteer = new Opensteer({
    workspace: "zillow-api",
    rootDir: process.cwd(),
    browser: "persistent",
    launch: { headless: false },
  });

  let capturedData: Record<string, unknown> | null = null;

  try {
    await opensteer.open("about:blank");

    await opensteer.route({
      urlPattern: "**/async-create-search-page-state**",
      times: 1,
      handler: async ({ fetchOriginal }) => {
        const response = await fetchOriginal();
        if (response.body) {
          const text = Buffer.from(response.body.bytes).toString("utf8");
          try {
            capturedData = JSON.parse(text);
          } catch {
            // response wasn't JSON
          }
        }
        return { kind: "continue" as const };
      },
    });

    await opensteer.goto(searchUrl);

    // Give a moment for the interceptor to fire
    await new Promise((r) => setTimeout(r, 2000));

    if (!capturedData) {
      throw new Error(
        `No API response captured for ${searchUrl}. ` +
          "Zillow's bot detection may have blocked the request. " +
          "Try cloning a fresh Chrome profile: opensteer browser clone --workspace zillow-api",
      );
    }

    const listings = parseListings(capturedData);
    const totals = capturedData.categoryTotals as Record<string, unknown> | undefined;
    const cat1Totals = (totals?.cat1 ?? {}) as Record<string, unknown>;
    const searchList = ((capturedData.cat1 as Record<string, unknown>)?.searchList ?? {}) as Record<
      string,
      unknown
    >;
    const regionState = (capturedData.regionState ?? {}) as Record<string, unknown>;
    const regionInfo = ((regionState.regionInfo ?? []) as Record<string, unknown>[])[0] ?? {};

    return {
      totalResults: Number(cat1Totals.totalResultCount ?? 0),
      totalPages: Number(searchList.totalPages ?? 1),
      currentPage: page,
      listings,
      regionName: String(regionInfo.displayName ?? query),
      regionId: Number(regionInfo.regionId ?? region?.regionId ?? 0),
    };
  } finally {
    await opensteer.close();
  }
}

async function main() {
  const query = process.argv[2] ?? "san francisco";
  const page = Number(process.argv[3]) || 1;

  console.log(`Searching Zillow for "${query}" (page ${page})...\n`);
  const result = await searchZillow(query, page);

  console.log(
    `${result.regionName} — ${result.totalResults} total listings, ` +
      `page ${result.currentPage}/${result.totalPages}\n`,
  );

  for (const listing of result.listings.slice(0, 20)) {
    console.log(
      `${listing.formattedPrice.padEnd(14)} ${listing.beds}bd ${listing.baths}ba ${String(listing.sqft).padStart(5)}sqft  ${listing.address}`,
    );
  }

  if (result.listings.length > 20) {
    console.log(`\n... and ${result.listings.length - 20} more listings`);
  }

  console.log(`\nTotal on this page: ${result.listings.length}`);
}

main();
