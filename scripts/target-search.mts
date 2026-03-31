import { Opensteer } from "../packages/opensteer/dist/index.js";

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#160;/g, " ");
}

interface TargetProduct {
  tcin: string;
  title: string;
  price: string | undefined;
  url: string;
  imageUrl: string | undefined;
  rating: number | undefined;
  reviewCount: number | undefined;
}

interface TargetSearchResult {
  keyword: string;
  totalResults: number | undefined;
  products: TargetProduct[];
}

async function searchTarget(keyword: string, count = 24): Promise<TargetSearchResult> {
  const opensteer = new Opensteer({
    workspace: "target",
    rootDir: import.meta.dirname + "/..",
  });

  try {
    const result = await opensteer.request("target.search", {
      query: {
        keyword,
        page: `/s/${encodeURIComponent(keyword)}`,
        count: String(count),
        offset: "0",
        new_search: "true",
      },
    });

    let parsed = result.data;
    if (!parsed && result.response.body) {
      parsed = JSON.parse(Buffer.from(result.response.body.data, "base64").toString("utf8"));
    }

    const search = (parsed as Record<string, unknown>).data as
      | { search: { products: unknown[]; search_response?: { typed_metadata?: { total_results?: number } } } }
      | undefined;

    const products: TargetProduct[] =
      search?.search.products.map((p: Record<string, unknown>) => {
        const item = p.item as Record<string, unknown> | undefined;
        const enrichment = item?.enrichment as Record<string, unknown> | undefined;
        const desc = item?.product_description as Record<string, unknown> | undefined;
        const price = p.price as Record<string, unknown> | undefined;
        const ratings = p.ratings_and_reviews as Record<string, unknown> | undefined;
        const images = enrichment?.images as Record<string, unknown> | undefined;

        return {
          tcin: String(p.tcin),
          title: decodeHtmlEntities(String(desc?.title ?? enrichment?.buy_url ?? "")),
          price: price?.formatted_current_price as string | undefined,
          url: String(enrichment?.buy_url ?? ""),
          imageUrl: images?.primary_image_url as string | undefined,
          rating: ratings?.statistics?.rating?.average as number | undefined,
          reviewCount: ratings?.statistics?.rating?.count as number | undefined,
        };
      }) ?? [];

    return {
      keyword,
      totalResults: search?.search.search_response?.typed_metadata?.total_results,
      products,
    };
  } finally {
    await opensteer.disconnect();
  }
}

const keyword = process.argv[2] || "airpods";
const count = Number(process.argv[3]) || 10;

console.log(`Searching Target for "${keyword}" (count: ${count})...\n`);

const results = await searchTarget(keyword, count);

console.log(`Results for "${results.keyword}":${results.totalResults ? ` (${results.totalResults} total)` : ""}\n`);

for (const product of results.products) {
  console.log(`  ${product.title}`);
  console.log(`    Price: ${product.price ?? "N/A"}`);
  console.log(`    TCIN: ${product.tcin}`);
  console.log(`    URL: ${product.url}`);
  if (product.rating) {
    console.log(`    Rating: ${product.rating}/5 (${product.reviewCount} reviews)`);
  }
  console.log();
}

console.log(`Total products returned: ${results.products.length}`);
