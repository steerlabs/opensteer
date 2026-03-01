---
name: opensteer
description: "Browser automation, web scraping, and structured data extraction using Opensteer CLI and SDK. Use when the agent needs to: navigate web pages, interact with elements (click, type, select, hover), extract structured data from pages, take snapshots or screenshots, manage browser tabs and cookies, or generate scraper/automation scripts. Also use when the user asks to create a scraper, automation script, or replay a browsing session as code."
---

# Opensteer Browser Automation

Opensteer provides persistent browser automation via a CLI and TypeScript SDK. It maintains browser sessions across calls and caches resolved element paths for deterministic replay.

## CRITICAL: Always Use Opensteer Methods Over Playwright

Opensteer methods are optimized for scraping — they handle waiting, element resolution, and selector caching automatically. **Never use raw Playwright when an Opensteer method exists.**

| Wrong (raw Playwright)                                                        | Right (Opensteer)                                              |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `page.evaluate(() => [...document.querySelectorAll('.item')].map(...))`       | `opensteer.extract({ description: "product listing" })`        |
| `page.click('.submit')`                                                       | `opensteer.click({ description: "the submit button" })`        |
| `page.fill('#search', 'query')`                                              | `opensteer.input({ description: "search input", text: "q" })`  |

**Why:** `opensteer.extract()` caches structural selectors that work across pages sharing the same template. Raw `querySelectorAll` is brittle, non-replayable, and bypasses the caching system. The only valid use of `opensteer.page.evaluate()` is calling `fetch()` for API-based extraction when a site has internal REST/GraphQL endpoints.

## Default Workflow

**Always use the CLI for exploration first. Only write scripts when the user asks.**

1. **Explore with CLI** — Open pages, snapshot, interact with elements interactively
2. **Cache selectors** — Re-run actions with `--description` flags to cache element paths for replay
3. **Cache extractions** — Run `extract` with `--description` for every page type the scraper will visit
4. **Generate script** — Use cached descriptions in TypeScript (no counters needed)

**Namespace links CLI and SDK.** The `--name` flag on `opensteer open` defines the cache namespace. `new Opensteer({ name: "..." })` in the SDK reads from the same cache. These must match.

## CLI Exploration

```bash
# 1. Set session once per shell
export OPENSTEER_SESSION=my-session

# 2. Open page with namespace
opensteer open https://example.com/products --name "product-scraper"

# 3. Snapshot for interactions or data
opensteer snapshot action       # Interactive elements with counters
opensteer snapshot extraction   # Data-oriented HTML with counters

# 4. Interact using counter numbers from snapshot
opensteer click 3
opensteer input 5 "laptop" --pressEnter

# 5. Cache actions with --description for replay
opensteer click 3 --description "the products link"
opensteer input 5 "laptop" --pressEnter --description "the search input"

# 6. Extract data: snapshot extraction → identify counters → extract with schema
opensteer snapshot extraction
opensteer extract '{"products":[{"name":{"element":11},"price":{"element":12}},{"name":{"element":25},"price":{"element":26}}]}' \
  --description "product listing with name and price"

# 7. Cache extractions for ALL page types the scraper will visit
opensteer click 11 --description "first product link"
opensteer snapshot extraction
opensteer extract '{"title":{"element":3},"price":{"element":7}}' \
  --description "product detail page"

# 8. Always close when done
opensteer close
```

**Key rules:**

- Set `--name` on `open` to define cache namespace
- Specify snapshot mode explicitly: `action` (interactions) or `extraction` (data)
- `snapshot extraction` shows structure; `extract` produces JSON — never parse snapshot HTML manually
- Use `--description` to cache selectors for replay (one character difference = cache miss)
- For arrays, include all items in the schema — Opensteer caches the structural pattern and finds all matches on replay
- `open` does raw `page.goto()`; use `navigate` for subsequent pages (includes stability wait)
- Re-snapshot after navigation or significant page changes

## Writing Scraper Scripts

Read [sdk-reference.md](references/sdk-reference.md) for exact method signatures before writing any script.

### Template

```typescript
import { Opensteer } from "opensteer";

async function run() {
  const opensteer = new Opensteer({
    name: "product-scraper", // MUST match --name from CLI exploration
    storage: { rootDir: process.cwd() },
  });

  await opensteer.launch({ headless: false });

  try {
    await opensteer.goto("https://example.com/products");

    await opensteer.input({
      text: "laptop",
      description: "the search input", // exact match to CLI --description
    });

    // Use extract with description — no schema needed when cache exists
    const data = await opensteer.extract({
      description: "product listing with name and price",
    });

    console.log(JSON.stringify(data, null, 2));
  } finally {
    await opensteer.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

### Script Rules

- No top-level `await` — wrap in `async function run()` + `run().catch(...)`
- Default to `headless: false` (many sites block headless)
- Use cached `description` strings for all interactions and extractions
- Do NOT add wait calls before SDK actions — they handle waiting internally
- Use `opensteer.waitForText("literal text")` or `page.waitForSelector("css")` only for page transitions or confirming SPA content loaded
- Run with: `npx tsx scraper.ts`

## Browser Connection

- **Sandbox (default):** `opensteer open <url>` — fresh Chromium, no user sessions
- **Connect (existing browser):** `opensteer open --connect-url http://localhost:9222` — attach to a running CDP-enabled browser. Verify CDP: `curl -s http://127.0.0.1:9222/json/version`

## Element Targeting (preference order)

1. **Counter** (from snapshot): `click 5` — fast, needs fresh snapshot
2. **Description** (cached): `click --description "the submit button"` — replayable
3. **CSS selector**: `click --selector "#btn"` — explicit but brittle

## Snapshot Modes

```bash
opensteer snapshot action      # Interactable elements (default)
opensteer snapshot extraction  # Flattened HTML for data extraction
opensteer snapshot clickable   # Only clickable elements
opensteer snapshot scrollable  # Only scrollable containers
opensteer snapshot full        # Raw HTML — only for debugging
```

All modes except `full` are intelligently filtered to show only relevant elements with counters.

## Debugging

When a scraper produces wrong or missing data, diagnose in this order:

1. **Timing** — SPA content not rendered. Add `waitForSelector` or `waitForText` before extraction.
2. **Missing cache** — Forgot to cache extraction during CLI exploration for a page type.
3. **Obstacles** — Cookie banners, modals, or login walls blocking the target.
4. **Missing data** — Some pages genuinely lack certain fields. Handle with null checks.

**Do NOT replace `opensteer.extract()` with `page.evaluate()` + `querySelectorAll` when debugging.** The extraction logic is not the problem — fix timing, caching, or obstacles instead.

## Reference

- CLI commands: [cli-reference.md](references/cli-reference.md)
- SDK API: [sdk-reference.md](references/sdk-reference.md)
- Full examples: [examples.md](references/examples.md)
