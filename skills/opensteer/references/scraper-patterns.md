# Opensteer Scraper Patterns

## Script Structure

Every scraper script follows this skeleton:

```typescript
import { Opensteer } from "opensteer";

async function main(): Promise<void> {
  const opensteer = new Opensteer({
    name: "scraper-name",
    rootDir: process.cwd(),
    browser: { headless: true },
  });

  try {
    await opensteer.open("https://target-site.com");

    // ... interactions and extraction ...

  } finally {
    await opensteer.close();
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

**Rules:**
- Always use `try/finally` with `close()` in finally for owned sessions.
- Set `headless: true` for production scrapers.
- Give each scraper a unique `name` to isolate its session and storage.

---

## Pattern 1: Snapshot + Element Counter

Use when you need to discover elements on the page first, then act on them.

```typescript
await opensteer.open("https://example.com");

// Take action snapshot to discover interactive elements
const snapshot = await opensteer.snapshot("action");

// Find a specific element by tag or path hint
const searchInput = snapshot.counters.find(
  (c) => c.tagName === "INPUT" && c.pathHint.includes("search")
);

if (searchInput) {
  await opensteer.input({ element: searchInput.element, text: "query" });
}

// Find and click a button
const submitBtn = snapshot.counters.find(
  (c) => c.tagName === "BUTTON" && c.pathHint.includes("submit")
);

if (submitBtn) {
  await opensteer.click({ element: submitBtn.element });
}
```

**When to use:** Initial exploration, unknown page structure, dynamic element discovery.

**Limitation:** Counter numbers are ephemeral — they change after navigation or DOM mutations. This pattern is mainly useful for one-off exploration, not production scrapers. Prefer `selector` or `description` targeting for reusable scripts.

---

## Pattern 2: CSS Selector Targeting

Use when you know the CSS selectors are stable.

```typescript
await opensteer.open("https://example.com");

await opensteer.input({
  selector: "input[name='q']",
  text: "search query",
  pressEnter: true,
});

await opensteer.click({ selector: "button.search-submit" });
```

**When to use:** Sites with stable, well-structured HTML. Most common pattern for production scrapers.

---

## Pattern 3: Description / Descriptor Replay

Use for scripts that run repeatedly across sessions. Descriptors persist the element resolution path. Requires an API key.

### First run — teach the descriptor:

```typescript
// Snapshot to find the element, then save it as a descriptor
const snap = await opensteer.snapshot("action");
const searchBox = snap.counters.find((c) => c.pathHint.includes("search"));

// Click by counter, but also save as "search box" descriptor
await opensteer.input({
  element: searchBox!.element,
  description: "search box",  // Saves the path as a descriptor
  text: "airpods",
  pressEnter: true,
});
```

### Subsequent runs — replay the descriptor:

```typescript
// No snapshot needed — descriptor is resolved from the registry
await opensteer.input({
  description: "search box",
  text: "airpods",
  pressEnter: true,
});
```

**When to use:** Long-lived scrapers that run on a schedule. The descriptor adapts to minor DOM changes.

---

## Pattern 4: Extraction with Schema

### Simple fields

```typescript
const data = await opensteer.extract({
  description: "product details",
  schema: {
    title: { selector: "h1.product-title" },
    price: { selector: ".price-value" },
    description: { selector: ".product-description" },
    imageUrl: { selector: ".product-image img", attribute: "src" },
    currentUrl: { source: "current_url" },
  },
});
// data = { title: "AirPods Pro", price: "$249", description: "...", imageUrl: "...", currentUrl: "..." }
```

### Array extraction (repeating elements)

```typescript
const data = await opensteer.extract({
  description: "search results",
  schema: {
    results: [{
      name: { selector: ".result-title" },
      price: { selector: ".result-price" },
      url: { selector: ".result-link", attribute: "href" },
      rating: { selector: ".result-rating" },
    }],
  },
});
// data = { results: [{ name: "...", price: "...", url: "...", rating: "..." }, ...] }
```

### Mixed fields and arrays

```typescript
const data = await opensteer.extract({
  description: "category page",
  schema: {
    categoryName: { selector: "h1" },
    totalResults: { selector: ".result-count" },
    products: [{
      name: { selector: ".product-name" },
      price: { selector: ".product-price" },
      inStock: { selector: ".stock-status" },
    }],
  },
});
```

**Schema rules:**
- Each field uses `{ selector: "css" }` for text content.
- Add `attribute: "attrName"` to extract an attribute instead of text.
- Use `{ source: "current_url" }` for the page URL.
- Wrap field definitions in `[{ ... }]` (single-element array) for repeating elements.
- Selectors in schemas are CSS selectors relative to the extraction context — they are NOT the same as element targeting selectors.

---

## Pattern 5: Multi-Page Navigation

```typescript
await opensteer.open("https://example.com");

// Navigate to search
await opensteer.input({ selector: "input[name=q]", text: "laptops", pressEnter: true });

// Extract first page
const page1 = await opensteer.extract({
  description: "search results",
  schema: {
    products: [{
      name: { selector: ".product-name" },
      price: { selector: ".product-price" },
    }],
  },
});

// Navigate to next page
await opensteer.click({ selector: ".pagination .next" });

// Extract second page
const page2 = await opensteer.extract({
  description: "search results",
  schema: {
    products: [{
      name: { selector: ".product-name" },
      price: { selector: ".product-price" },
    }],
  },
});

const allProducts = [...page1.products, ...page2.products];
```

---

## Pattern 6: Network-Tagged Actions

Use `networkTag` to correlate actions with the network requests they trigger.

```typescript
await opensteer.open("https://example.com");

// Tag the search action's network traffic
await opensteer.input({
  selector: "input[name=q]",
  text: "airpods",
  pressEnter: true,
  networkTag: "search",
});

// Query the tagged traffic
const records = await opensteer.queryNetwork({
  tag: "search",
  includeBodies: true,
});

// Find the API call
const apiCall = records.records.find(
  (r) => r.resourceType === "xhr" && r.url.includes("/api/search")
);

console.log("Found API:", apiCall?.url);
console.log("Response:", apiCall?.responseBody);
```

---

## Pattern 7: Waiting Between Actions

When pages need time to load after navigation or form submission:

```typescript
// Option A: Navigate to the expected URL to ensure page load
await opensteer.input({ selector: "input[name=q]", text: "airpods", pressEnter: true });
await opensteer.goto("https://example.com/search?q=airpods");  // Forces navigation + wait

// Option B: Use a simple delay (less reliable, use sparingly)
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await opensteer.click({ selector: ".load-more" });
await delay(2000);
const data = await opensteer.extract({ description: "results" });
```

**Prefer goto-based navigation** when the target URL is predictable. It ensures the page is fully loaded.

---

## Pattern 8: Real Chrome Profile

Launch with a real Chrome user-data-dir to preserve cookies, extensions, and login state. Useful for sites that require authentication or have bot detection.

```typescript
const opensteer = new Opensteer({
  name: "authenticated-scraper",
  rootDir: process.cwd(),
  browser: {
    kind: "profile",
    userDataDir: "/path/to/chrome-profile",
  },
});

try {
  // Opens Chrome with existing cookies/login state
  await opensteer.open("https://authenticated-site.com/dashboard");

  const data = await opensteer.extract({
    description: "dashboard data",
    schema: {
      username: { selector: ".user-name" },
      items: [{
        name: { selector: ".item-name" },
        value: { selector: ".item-value" },
      }],
    },
  });

  console.log(JSON.stringify(data, null, 2));
} finally {
  await opensteer.close();
}
```

**Notes:**
- Opensteer rejects default Chrome/Chromium user-data-dirs. Use a dedicated directory.
- Use `profileDirectory` to select a specific Chrome profile within the user-data-dir (e.g., `"Default"`, `"Profile 1"`).
- If the profile is locked by another Chrome instance, launch will fail with `OpensteerLocalProfileUnavailableError`. Use `inspectLocalBrowserProfile()` and `unlockLocalBrowserProfile()` to diagnose and resolve stale locks.

---

## Pattern 9: CDP Attachment

Attach to an already-running Chrome instance via the DevTools Protocol. The SDK controls a tab but does not own the browser process.

```typescript
const opensteer = new Opensteer({
  name: "cdp-session",
  rootDir: process.cwd(),
  browser: {
    kind: "cdp",
    endpoint: "ws://127.0.0.1:9222/devtools/browser/root",
    freshTab: true,
  },
});

try {
  await opensteer.open("https://example.com");
  // ... interactions ...
} finally {
  await opensteer.close();
}
```

**Endpoint formats:** port number (`9222`), WebSocket URL (`ws://...`), or HTTP URL (`http://127.0.0.1:9222`).

Use `freshTab: true` to open a new tab instead of reusing the active one.

---

## Pattern 10: Attach to an Existing Session

Connect to a session started by the CLI or another process without owning the browser lifecycle.

```typescript
// Some other process already ran: opensteer open https://example.com
const opensteer = Opensteer.attach({
  name: "default",       // Match the CLI session name
  rootDir: process.cwd(),
});

try {
  // Use the existing session — browser is already open
  await opensteer.open("https://example.com/page2");

  const data = await opensteer.extract({
    description: "page data",
    schema: {
      title: { selector: "h1" },
    },
  });

  console.log(JSON.stringify(data, null, 2));
} finally {
  // disconnect() releases the handle WITHOUT closing the browser
  await opensteer.disconnect();
}
```

**Key difference:** `close()` destroys the browser. `disconnect()` just releases the SDK handle. Use `disconnect()` for attached sessions so other processes can continue using the browser.

---

## Complete Example: E-Commerce Scraper

```typescript
import { Opensteer } from "opensteer";

async function scrapeProducts(): Promise<void> {
  const opensteer = new Opensteer({
    name: "ecommerce-scraper",
    rootDir: process.cwd(),
    browser: { headless: true },
  });

  try {
    await opensteer.open("https://store.example.com");

    // Search for products
    await opensteer.input({
      selector: "input[type=search]",
      text: "wireless headphones",
      pressEnter: true,
    });

    // Wait for results page
    await opensteer.goto("https://store.example.com/search?q=wireless+headphones");

    // Extract product data
    const data = await opensteer.extract({
      description: "headphone search results",
      schema: {
        query: { source: "current_url" },
        products: [{
          name: { selector: ".product-card .title" },
          price: { selector: ".product-card .price" },
          rating: { selector: ".product-card .stars" },
          url: { selector: ".product-card a", attribute: "href" },
          image: { selector: ".product-card img", attribute: "src" },
        }],
      },
    });

    // Output results
    console.log(JSON.stringify(data, null, 2));
  } finally {
    await opensteer.close();
  }
}

void scrapeProducts().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```
