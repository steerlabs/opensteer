---
name: opensteer
description: "Browser automation, web scraping, and structured data extraction using Opensteer CLI and SDK. Use when the agent needs to: navigate web pages, interact with elements (click, type, select, hover), extract structured data from pages, take snapshots or screenshots, manage browser tabs and cookies, or generate scraper/automation scripts. Also use when the user asks to create a scraper, automation script, or replay a browsing session as code."
---

# Opensteer Browser Automation

**Exploring interactively?** Follow Phase 1.
**Writing a scraper script?** Follow Phase 2.

> Never use raw Playwright methods when an Opensteer equivalent exists. Never call `opensteer.navigate()` — the correct method is `opensteer.goto()`.

---

## Phase 1 — CLI Exploration

**Step 1 — Set session and open the page.**

```bash
export OPENSTEER_SESSION=my-session
opensteer open https://example.com --name "my-scraper"
```

The `--name` value is the cache namespace. It must match `name:` in the SDK constructor (Phase 2). Pick a stable name now and do not change it.

**Step 2 — Snapshot and interact using counters.**

Use `snapshot action` for interactions. Use `snapshot extraction` for data. Each element in the output has a counter (`c="N"`). Use that number directly.

```bash
opensteer snapshot action
opensteer click 3
opensteer input 5 "laptop" --pressEnter
```

**Step 3 — Navigate and re-snapshot after every page change.**

```bash
opensteer navigate https://example.com/results
opensteer snapshot action
```

> Use `opensteer open` once at the start only. Use `opensteer navigate` for all subsequent pages — it includes a visual stability wait that `open` does not.

**Step 4 — Cache every action and extraction with `--description`.**

Re-run each action with `--description` added. This writes the resolved selector to the cache so scripts replay without counters.

```bash
opensteer click 3 --description "the products link"
opensteer input 5 "laptop" --pressEnter --description "the search input"
```

For data, the agent must define the extraction object from the snapshot.

- First run `opensteer snapshot extraction` and inspect the counters.
- Decide the exact JSON object the task needs.
- Treat the extraction snapshot as a planning aid only. It is trimmed/filtered, so do not read final values from the snapshot HTML itself.
- Build the full `extract` schema yourself so every leaf field is explicitly bound with `{ element: N }`, `{ element: N, attribute: "..." }`, or `{ source: "current_url" }`.
- Always call `extract` to read the actual field values from the live page/runtime DOM.
- Use `--description` only to cache that extraction for replay. Do not rely on `--description` to tell Opensteer what data to collect.
- For arrays, include at least 2 representative items so Opensteer infers the repeating pattern.
- Do not replace `extract` with custom DOM parsing when the desired output can be expressed as a structured object.

```bash
opensteer snapshot extraction
# Decide the full output object first, then bind every leaf field explicitly
opensteer extract '{"images":[{"imageUrl":{"element":11,"attribute":"src"},"alt":{"element":11,"attribute":"alt"},"caption":{"element":14},"credit":{"element":15}},{"imageUrl":{"element":24,"attribute":"src"},"alt":{"element":24,"attribute":"alt"},"caption":{"element":27},"credit":{"element":28}}]}' \
  --description "article images with captions and credits"
```

Repeat Step 3 → Step 4 for every distinct page type the scraper will visit.

**Step 5 — Close when done.**

```bash
opensteer close
```

---

## Phase 2 — SDK Scraper Script

Use cached `description` strings (exact match to CLI `--description` values) only after Phase 1 has already established the exact extraction schema from `snapshot extraction`. `name` must match `--name` from Phase 1.

```typescript
import { Opensteer } from "opensteer";

async function run() {
  const opensteer = new Opensteer({
    name: "my-scraper",                       // MUST match --name from Phase 1
    storage: { rootDir: process.cwd() },
  });

  await opensteer.launch({ headless: false }); // headless: false — many sites block headless

  try {
    await opensteer.goto("https://example.com");

    await opensteer.input({ description: "the search input", text: "laptop", pressEnter: true });
    await opensteer.click({ description: "the products link" });

    await opensteer.waitForText("Showing results"); // only for page transitions / SPA content

    const data = await opensteer.extract({ description: "product listing" });
    console.log(JSON.stringify(data, null, 2));
  } finally {
    await opensteer.close();
  }
}

run().catch((err) => { console.error(err); process.exit(1); });
```

**Critical method signatures:**

```typescript
await opensteer.goto(url);
await opensteer.goto(url, { timeout: 60000 });

await opensteer.click({ description: "..." });
await opensteer.input({ description: "...", text: "...", pressEnter: true });
await opensteer.hover({ description: "..." });
await opensteer.select({ description: "...", label: "Option A" });
await opensteer.scroll({ direction: "down", amount: 500 });

await opensteer.extract({ description: "..." });                            // replay from cache
await opensteer.extract({ schema: { title: { element: 3 } }, description: "..." }); // explicit first cache
await opensteer.extract({
  description: "article images with captions and credits",
  schema: {
    images: [
      {
        imageUrl: { element: 11, attribute: "src" },
        alt: { element: 11, attribute: "alt" },
        caption: { element: 14 },
        credit: { element: 15 },
      },
      {
        imageUrl: { element: 24, attribute: "src" },
        alt: { element: 24, attribute: "alt" },
        caption: { element: 27 },
        credit: { element: 28 },
      },
    ],
  },
}); // first extraction run: agent defines the full object from the snapshot

await opensteer.waitForText("literal text");
await opensteer.page.waitForSelector("css-selector");                       // SPA content guard

// Do NOT add waits before opensteer actions — they handle waiting internally.
```

Run with: `npx tsx scraper.ts`

---

## Edge Cases

**Connect to an existing browser (CDP):**
```bash
opensteer open --connect-url http://localhost:9222 --name "my-scraper"
# Verify CDP is running: curl -s http://127.0.0.1:9222/json/version
```

**API-based extraction (site has internal REST/GraphQL endpoints):**
Navigate first to acquire session cookies, then call `fetch()` inside `page.evaluate()`. This is the only valid use of `page.evaluate()`.
```typescript
await opensteer.goto("https://example.com");
const data = await opensteer.page.evaluate(async () => {
  const res = await fetch("https://api.example.com/items?limit=100");
  return res.json();
});
```

**Tab management:**
```bash
opensteer tabs
opensteer tab-new https://example.com
opensteer tab-switch 0
opensteer tab-close 1
```

**Debugging failures (diagnose in this order):**
1. SPA content not loaded — add `waitForText` or `page.waitForSelector` before extraction.
2. Missing cache — re-run Phase 1 caching step for the page type that failed.
3. Obstacle blocking target — cookie banner, modal, or login wall. Dismiss it first.

**Full references:** [cli-reference.md](references/cli-reference.md) | [sdk-reference.md](references/sdk-reference.md)
