# Opensteer SDK Reference

Use the SDK when the workflow should become reusable TypeScript code in the repository.

## Sections

- [Construction](#construction)
- [DOM Automation And Extraction](#dom-automation-and-extraction)
- [Browser Admin](#browser-admin)
- [Request Capture, Plans, And Recipes](#request-capture-plans-and-recipes)
- [Common Methods](#common-methods)
- [Rules](#rules)

## Construction

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "github-sync",
  rootDir: process.cwd(),
  browser: "persistent",
  launch: {
    headless: false,
  },
  context: {
    locale: "en-US",
  },
});
```

- `workspace` creates a repo-local persistent root under `.opensteer/workspaces/<id>`.
- Omitting `workspace` creates a temporary root.
- `browser` can be `persistent`, `temporary`, or `{ mode: "attach", endpoint?, freshTab? }`.
- `opensteer.browser.status()`, `clone()`, `reset()`, and `delete()` manage the persistent workspace browser.
- `close()` shuts the current session and, for persistent workspaces, closes the live browser process.
- `disconnect()` detaches local runtime handles and leaves the workspace/browser files intact.
- Persisted network history is SQLite-backed and initializes on first `queryNetwork()`, `tagNetwork()`, or `clearNetwork()` use.
- Generic workspace and browser helpers do not require SQLite capability unless they touch saved-network persistence.
- The current public SDK does not expose `Opensteer.attach()`, cloud session helpers, or the ABP engine.

## DOM Automation And Extraction

Opensteer uses a two-phase workflow: **explore** with the CLI, then **replay** with the SDK.

### Phase 1 — Exploration (one-time, via CLI or setup script)

Run `opensteer snapshot action --workspace demo` from the CLI first. Read the `html` field in the JSON output — it is a clean filtered DOM with `c="N"` attributes. Use those counter numbers as the `element` parameter below. The SDK also exposes `snapshot()`, but this guide keeps discovery in the CLI so the DOM HTML is easy to inspect from the terminal.

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
});

await opensteer.open("https://example.com");

// element numbers come from c="N" values in the snapshot html field
await opensteer.click({
  element: 3,
  description: "primary button", // caches the element path
});

await opensteer.input({
  element: 7,
  description: "search input", // caches the element path
  text: "laptop",
  pressEnter: true,
});

await opensteer.extract({
  description: "page summary",
  schema: {
    title: { selector: "title" },
    url: { source: "current_url" },
  },
});

await opensteer.close();
```

### Phase 2 — Deterministic replay (the actual reusable script)

Use `description` alone for everything — resolves from cached descriptors:

```ts
const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
});

await opensteer.open("https://example.com");

await opensteer.click({ description: "primary button" });
await opensteer.input({ description: "search input", text: "laptop", pressEnter: true });
const data = await opensteer.extract({ description: "page summary" });

await opensteer.close();
```

DOM rules:

- Deterministic scripts use `description` for all interactions and extractions — no snapshots, no selectors.
- `element + description` persists a DOM action descriptor. Bare `description` replays it later.
- `description + schema` writes or updates a persisted extraction descriptor. Bare `description` replays it later.
- Use `element` targets only during the exploration phase with a fresh snapshot from the CLI.
- Keep DOM data collection in `extract()`, not `evaluate()` or raw page DOM parsing, when the result can be expressed as structured fields.
- CSS selectors exist as a low-level escape hatch but are not recommended for reusable scripts.

Supported extraction field shapes:

- `{ element: N }` — requires a prior CLI snapshot; use during exploration only
- `{ element: N, attribute: "href" }`
- `{ selector: ".price" }`
- `{ selector: "img.hero", attribute: "src" }`
- `{ source: "current_url" }`

For arrays, provide 1-2 representative objects. The extractor auto-generalizes from these templates to find ALL matching rows on the page:

```ts
const results = await opensteer.extract({
  description: "search results",
  schema: {
    items: [
      { name: { element: 13 }, price: { element: 14 } },
      { name: { element: 22 }, price: { element: 23 } },
    ],
  },
});
// results.items contains ALL matching rows on the page, not just the 2 templates
```

Do not use `prompt` or semantic placeholder values such as `"string"` in the current public SDK. The extractor expects explicit schema objects, arrays, and field descriptors.

### What extract() Returns

`extract()` returns a plain JSON object matching your schema shape:

```ts
// Flat schema:
{ title: "Search Results", url: "https://..." }

// Array schema (auto-generalized from 1-2 templates):
{
  items: [
    { name: "Apple AirPods Max", price: "$549.99" },
    { name: "Apple AirPods Pro", price: "$249.99" },
    { name: "Apple AirPods 4", price: "$129.99" },
    // ... ALL matching rows
  ]
}
```

Use `extract()` for structured data. Do NOT use `evaluate()` or raw DOM parsing when `extract()` can express the result.

## Browser Admin

```ts
const status = await opensteer.browser.status();

if (!status.live) {
  await opensteer.browser.clone({
    sourceUserDataDir: "/Users/me/Library/Application Support/Google/Chrome",
    sourceProfileDirectory: "Default",
  });
}
```

- `browser.clone()` is only for persistent workspace browsers.
- Clone before `open()` when the workflow needs local authenticated browser state.
- `browser.reset()` clears cloned browser state but keeps the workspace.
- `browser.delete()` removes workspace browser files.

## Request Capture, Plans, And Recipes

```ts
await opensteer.open();
await opensteer.goto({
  url: "https://example.com/app",
  networkTag: "page-load",
});

await opensteer.click({
  selector: "button.load-products",
  description: "load products",
  networkTag: "products-load",
});

const records = await opensteer.queryNetwork({
  tag: "products-load",
  includeBodies: true,
  limit: 20,
});

const response = await opensteer.rawRequest({
  transport: "context-http",
  url: "https://example.com/api/products",
  method: "POST",
  body: {
    json: { page: 1 },
  },
});

await opensteer.inferRequestPlan({
  recordId: records.records[0]!.id,
  key: "products.search",
  version: "v1",
});

await opensteer.inferRequestPlan({
  recordId: records.records[0]!.id,
  key: "products.search.portable",
  version: "v1",
  transport: "direct-http",
});

await opensteer.tagNetwork({
  tag: "products-load",
});

await opensteer.request("products.search", {
  query: { q: "laptop" },
});
```

Rules:

- `networkTag` is supported on `goto()`, `click()`, `scroll()`, `input()`, and `hover()`. It is NOT supported on `open()`. Use `open()` then `goto({ url, networkTag })` to tag initial navigation.
- Query by tag first, then query all traffic to catch async requests that fire after page load.
- Probe discovered APIs with `rawRequest()` using `direct-http` first, then `context-http`.
- Persistence is automatic; use `tagNetwork()` when you want to label a saved slice of history.
- Use recipes when replay needs deterministic setup work. Use auth recipes when the setup is specifically auth-related. They live in separate registries.

`rawRequest` input shapes:

- `headers` MUST be an array: `[{ name: "Authorization", value: "Bearer ..." }]`. NOT `{ Authorization: "Bearer ..." }`.
- `body` MUST be one of: `{ json: { ... } }`, `{ text: "..." }`, or `{ base64: "..." }`. NOT a raw string or object.
- `rawRequest()` may populate parsed JSON on `data`. If it does not, decode `response.body.data` with `Buffer.from(..., "base64").toString("utf8")`.

Common errors and fixes:

| Error                                                        | Cause                                                 | Fix                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------- |
| `"networkTag is not allowed"`                                | Used `networkTag` on `open()`                         | Move to `goto({ url, networkTag })`                               |
| `"must be array"` on `rawRequest`                            | Headers passed as `{key: value}`                      | Use `[{name, value}]` array                                       |
| `"must match exactly one supported shape"`                   | Body passed as raw string                             | Wrap in `{json: {...}}` or `{text: "..."}`                        |
| `"Specify exactly one of element, selector, or description"` | `scroll()` called without a target                    | Add `selector: "body"` or a `description`                         |
| `"registry record already exists"`                           | `inferRequestPlan` called twice with same key+version | Catch the error or use a new version                              |
| `"no stored extraction descriptor"`                          | `extract()` called with `description` but no `schema` | Always provide `schema` unless a descriptor was previously stored |

## Common Methods

Session and page control:

- `new Opensteer({ workspace?, rootDir?, browser?, launch?, context? })`
- `open(url | { url?, workspace?, browser?, launch?, context? })`
- `goto(url | { url, networkTag? })`
- `listPages()`
- `newPage({ url?, openerPageRef? })`
- `activatePage({ pageRef })`
- `closePage({ pageRef })`
- `waitForPage({ openerPageRef?, urlIncludes?, timeoutMs? })`

Interaction and extraction:

- `click({ element | selector | description, networkTag? })`
- `hover({ element | selector | description, networkTag? })`
- `input({ element | selector | description, text, pressEnter?, networkTag? })`
- `scroll({ element | selector | description, direction, amount, networkTag? })`
- `extract({ description, schema? })`

Inspection and evaluation:

- `evaluate(script | { script, pageRef?, args? })`
- `evaluateJson({ script, pageRef?, args? })`
- `waitForNetwork({ ...filters, pageRef?, includeBodies?, timeoutMs? })`
- `waitForResponse({ ...filters, pageRef?, includeBodies?, timeoutMs? })`
- `queryNetwork({ ...filters, includeBodies?, limit? })`
- `tagNetwork({ tag, ...filters })`
- `clearNetwork({ tag? })`

Request capture and replay:

- `rawRequest({ transport?, pageRef?, url, method?, headers?, body?, followRedirects? })`
- `inferRequestPlan({ recordId, key, version, transport? })`
- `writeRequestPlan({ key, version, payload, tags?, provenance?, freshness? })`
- `getRequestPlan({ key, version? })`
- `listRequestPlans({ key? })`
- `request(key, { path?, query?, headers?, body? })`
- `writeRecipe({ key, version, payload, tags?, provenance? })`
- `getRecipe({ key, version? })`
- `listRecipes({ key? })`
- `runRecipe({ key, version?, input? })`
- `writeAuthRecipe({ key, version, payload, tags?, provenance? })`
- `getAuthRecipe({ key, version? })`
- `listAuthRecipes({ key? })`
- `runAuthRecipe({ key, version?, input? })`

Browser helpers:

- `discoverLocalCdpBrowsers({ timeoutMs? })`
- `inspectCdpEndpoint({ endpoint, headers?, timeoutMs? })`
- `browser.status()`
- `browser.clone({ sourceUserDataDir, sourceProfileDirectory? })`
- `browser.reset()`
- `browser.delete()`

Lifecycle:

- `close()`
- `disconnect()`

## Rules

- Wrap long-running browser ownership in `try/finally` and call `close()`.
- Use `networkTag` on actions that trigger requests you may inspect later.
- Use `description` for all interactions and extractions in deterministic scripts.
- Use `description` plus `schema` to persist an extraction descriptor. Bare `description` replays it.
- Use `element` targets only during CLI exploration with a fresh snapshot. Deterministic scripts use `description`.
- The SDK does expose `snapshot()`, but this workflow keeps element discovery in the CLI with `snapshot action`.
- Prefer Opensteer methods over raw Playwright so browser, extraction, and replay semantics stay consistent.
