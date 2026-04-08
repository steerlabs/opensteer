/**
 * Target.com Product Search API — reverse-engineered via Opensteer
 *
 * API: GET https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2
 * Transport: direct-http (no browser session required)
 * Auth: none (public API key in query string)
 *
 * Required params: keyword, page, visitor_id, key, channel, platform
 * Variable params: keyword, count, offset, page (path-style: /s/<keyword>)
 * Fixed params: key (9f36aeafbe60771e321a7cc95a78140772ab3e96), channel (WEB), platform (desktop)
 */

import { Opensteer } from "./packages/opensteer/src/index.js";

const TARGET_SEARCH_BASE =
  "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2";

const TARGET_API_KEY = "9f36aeafbe60771e321a7cc95a78140772ab3e96";

interface TargetSearchParams {
  keyword: string;
  count?: number;
  offset?: number;
  storeId?: string;
  zip?: string;
}

interface TargetProduct {
  title: string;
  tcin: string;
  price: { current_retail: number; formatted_current_price: string };
  ratings: { average: number; count: number };
  url: string;
}

function buildSearchUrl(params: TargetSearchParams): string {
  const { keyword, count = 24, offset = 0, storeId = "3233", zip = "92603" } = params;
  const url = new URL(TARGET_SEARCH_BASE);
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("count", String(count));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("page", `/s/${keyword}`);
  url.searchParams.set("platform", "desktop");
  url.searchParams.set("channel", "WEB");
  url.searchParams.set("key", TARGET_API_KEY);
  url.searchParams.set("default_purchasability_filter", "true");
  url.searchParams.set("include_sponsored", "false");
  url.searchParams.set("new_search", "true");
  url.searchParams.set("spellcheck", "true");
  url.searchParams.set("pricing_store_id", storeId);
  url.searchParams.set("store_ids", storeId);
  url.searchParams.set("visitor_id", crypto.randomUUID());
  if (zip) url.searchParams.set("zip", zip);
  return url.toString();
}

function parseProducts(data: any): TargetProduct[] {
  const products = data?.data?.search?.products ?? [];
  return products.map((product: any) => {
    const item = product.item ?? {};
    const price = product.price?.current_retail_min ?? product.price?.current_retail ?? 0;
    const formattedPrice =
      product.price?.formatted_current_price ?? `$${price.toFixed(2)}`;
    const rawTitle: string = item.product_description?.title ?? "Unknown";
    return {
      title: rawTitle.replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim(),
      tcin: product.tcin ?? "",
      price: { current_retail: price, formatted_current_price: formattedPrice },
      ratings: {
        average: product.ratings_and_reviews?.statistics?.rating?.average ?? 0,
        count: product.ratings_and_reviews?.statistics?.rating?.count ?? 0,
      },
      url: `https://www.target.com${item.enrichment?.buy_url ?? ""}`,
    };
  });
}

async function searchTarget(params: TargetSearchParams): Promise<TargetProduct[]> {
  const opensteer = new Opensteer({
    workspace: "target-api",
    rootDir: process.cwd(),
    browser: "persistent",
    launch: { headless: true },
  });

  try {
    await opensteer.open("about:blank");

    const url = buildSearchUrl(params);
    const response = await opensteer.fetch(url, { transport: "direct" });
    const data = await response.json();
    return parseProducts(data);
  } finally {
    await opensteer.close();
  }
}

async function main() {
  const keyword = process.argv[2] ?? "airpods";
  const count = Number(process.argv[3]) || 10;

  console.log(`Searching Target for "${keyword}" (count=${count})...\n`);
  const products = await searchTarget({ keyword, count });

  for (const product of products) {
    console.log(
      `${product.price.formatted_current_price.padEnd(16)} ${product.title}`,
    );
    console.log(
      `${"".padEnd(16)} Rating: ${product.ratings.average}/5 (${product.ratings.count} reviews)  TCIN: ${product.tcin}`,
    );
    console.log();
  }

  console.log(`Total: ${products.length} results`);
}

main();
