import { Opensteer } from "../packages/opensteer/src/index.js";

interface Product {
  name: string;
  price: string;
  url: string;
  brand?: string;
}

async function main(): Promise<void> {
  const opensteer = new Opensteer({
    name: "target-airpods",
    rootDir: process.cwd(),
    browser: {
      headless: false,
    },
  });

  try {
    // 1. Open Target
    await opensteer.open("https://www.target.com");
    console.log("Opened target.com");

    // 2. Use the cached "target search box" descriptor if available,
    //    otherwise take a snapshot to find the search input and cache it.
    try {
      // Try using cached descriptor first (no snapshot needed)
      await opensteer.input({
        description: "target search box",
        text: "airpods",
        pressEnter: true,
      });
      console.log("Searched for airpods (using cached descriptor)");
    } catch {
      // Fallback: take snapshot, find search input, and cache the descriptor
      console.log("No cached descriptor found, taking snapshot...");
      const homeSnapshot = await opensteer.snapshot("action");
      const searchInput = homeSnapshot.counters.find(
        (c) => c.tagName === "INPUT" && c.attributes.some((a) => a.name === "id" && a.value === "search"),
      );

      if (!searchInput) {
        throw new Error("Could not find search input");
      }

      await opensteer.input({
        element: searchInput.element,
        text: "airpods",
        pressEnter: true,
        description: "target search box",
      });
      console.log("Searched for airpods (fresh snapshot, descriptor cached)");
    }

    // 4. Navigate to the search results URL to ensure the page is fully loaded
    //    and document refs are fresh after the search form submission.
    await delay(2000);
    await opensteer.goto("https://www.target.com/s?searchTerm=airpods");
    await delay(2000);
    const resultsSnapshot = await opensteer.snapshot("action");
    console.log(`Page: ${resultsSnapshot.title}`);
    console.log(`URL: ${resultsSnapshot.url}`);

    // 5. Extract product data from snapshot counters
    const products = extractProductsFromCounters(resultsSnapshot.counters);

    console.log(`\nFound ${products.length} products:\n`);
    for (const product of products) {
      console.log(`  Name:  ${product.name}`);
      console.log(`  Price: ${product.price}`);
      console.log(`  URL:   https://www.target.com${product.url}`);
      if (product.brand) {
        console.log(`  Brand: ${product.brand}`);
      }
      console.log();
    }

    // 6. Also extract using the schema-based extraction for page-level data
    const pageData = await opensteer.extract({
      description: "airpods search page metadata",
      schema: {
        url: { source: "current_url" },
        searchTerm: { selector: "input#search", attribute: "value" },
      },
    });
    console.log("Page metadata:", JSON.stringify(pageData, null, 2));

    // 7. Output full results as JSON
    const output = {
      metadata: pageData,
      products,
      totalFound: products.length,
      scrapedAt: new Date().toISOString(),
    };

    console.log("\n=== Full JSON Output ===");
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await opensteer.close();
    console.log("\nBrowser closed.");
  }
}

function extractProductsFromCounters(
  counters: ReadonlyArray<{
    readonly element: number;
    readonly tagName: string;
    readonly text: string;
    readonly attributes: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }>,
): Product[] {
  const products: Product[] = [];

  // Product title links point to /p/ paths and contain a div with the product name.
  // We iterate counters and build products by finding title links, then looking
  // backward for the nearest price span and forward for the brand link.
  const titleLinks: Array<{
    index: number;
    name: string;
    url: string;
    element: number;
  }> = [];

  for (let i = 0; i < counters.length; i++) {
    const c = counters[i];
    if (c.tagName !== "A") continue;

    const href = c.attributes.find((a) => a.name === "href")?.value;
    if (!href || !href.startsWith("/p/")) continue;

    // Skip review/rating links and scroll-to-review links
    if (href.includes("scroll_to_review_section")) continue;
    if (/^\d(\.\d)? out of \d stars/.test(c.text)) continue;

    // This is a product link - check if it has meaningful text (title link, not image link)
    if (c.text && c.text.length > 3) {
      titleLinks.push({ index: i, name: c.text, url: href, element: c.element });
    }
  }

  // For each title link, search backward for price and forward for brand
  for (const titleLink of titleLinks) {
    let price = "";
    let brand = "";

    // Look backward from the title link for a price span
    for (let i = titleLink.index - 1; i >= Math.max(0, titleLink.index - 30); i--) {
      const c = counters[i];
      if (c.tagName === "SPAN" && /^\$[\d,.]+/.test(c.text)) {
        price = c.text;
        break;
      }
    }

    // Look forward for a brand link (links to /b/ paths)
    for (let i = titleLink.index + 1; i < Math.min(counters.length, titleLink.index + 10); i++) {
      const c = counters[i];
      if (c.tagName === "A") {
        const href = c.attributes.find((a) => a.name === "href")?.value;
        if (href && href.startsWith("/b/") && c.text) {
          brand = c.text;
          break;
        }
      }
    }

    // Normalize URL for deduplication: strip query params to catch carousel dupes
    const baseUrl = titleLink.url.split("?")[0];
    if (!products.some((p) => p.url.split("?")[0] === baseUrl)) {
      products.push({
        name: titleLink.name,
        price,
        url: titleLink.url,
        ...(brand ? { brand } : {}),
      });
    }
  }

  return products;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
