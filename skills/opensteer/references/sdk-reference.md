# Opensteer SDK Reference

Use the SDK when the workflow should become reusable TypeScript code in the repository.

## Session Ownership

Owned session:

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "demo",
  rootDir: process.cwd(),
  browser: { headless: true },
});
```

Attached session:

```ts
import { Opensteer } from "opensteer";

const opensteer = Opensteer.attach({
  name: "demo",
  rootDir: process.cwd(),
});
```

Use `close()` for owned sessions. Use `disconnect()` for attached sessions.

## DOM Automation And Extraction

```ts
await opensteer.open("https://example.com");
await opensteer.goto("https://example.com/products");
await opensteer.snapshot("action");
await opensteer.click({ selector: "button.primary", description: "primary button" });
await opensteer.input({
  selector: "input[type=search]",
  description: "search input",
  text: "laptop",
  pressEnter: true,
});
await opensteer.hover({ selector: "[data-filter=price]", description: "price filter" });
await opensteer.scroll({ selector: "body", direction: "down", amount: 600 });
const data = await opensteer.extract({
  description: "page summary",
  schema: {
    title: { selector: "title" },
    url: { source: "current_url" },
  },
});
```

DOM rules:

- Use `snapshot("action")` before counter-based interactions.
- Use `snapshot("extraction")` to inspect the page structure and design the output object.
- Treat snapshots as planning artifacts. `extract()` reads the live DOM/runtime and replays persisted extraction descriptors.
- For DOM actions, bare `description` replays a stored descriptor. On the first run, pair it with `selector` or `element` to persist that description.
- `description` names the persisted extraction descriptor. `schema` defines the actual output shape.
- Keep DOM data collection in `extract()`, not `evaluate()` or raw page DOM parsing, when the result can be expressed as structured fields.

Supported extraction field shapes in the current public SDK:

- `{ element: N }`
- `{ element: N, attribute: "href" }`
- `{ selector: ".price" }`
- `{ selector: "img.hero", attribute: "src" }`
- `{ source: "current_url" }`

For arrays, include one or more representative objects in the schema. Add multiple examples when repeated rows have structural variants.

Do not use `prompt` or semantic placeholder values such as `"string"` in the current public SDK. The current extractor expects explicit schema objects, arrays, and field descriptors.

## Reverse Engineering And Replay

```ts
await opensteer.open("https://example.com/app");
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

await opensteer.rawRequest({
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

await opensteer.request("products.search", {
  query: { q: "laptop" },
});
```

Reverse rules:

- `networkTag` is supported on `goto()`, `click()`, `scroll()`, `input()`, and `hover()`. It is NOT supported on `open()`. MUST use `open(url)` then `goto({ url, networkTag })` to tag initial navigation.
- MUST query by tag first, then query all traffic to catch async requests that fire after page load.
- MUST probe discovered APIs with `rawRequest()` — `direct-http` first, then `context-http`. Do NOT just log API URLs without testing them.
- If you find an auth endpoint, acquire a token and re-probe data endpoints with it.
- MUST call `saveNetwork()` to persist captures before the session closes.
- `inferRequestPlan()` throws if the key+version already exists. Catch the error or bump the version.
- Use recipes when replay needs deterministic auth refresh or setup work.

`rawRequest` input shapes:

- `headers` MUST be an array: `[{ name: "Authorization", value: "Bearer ..." }]`. NOT `{ Authorization: "Bearer ..." }`.
- `body` MUST be one of: `{ json: { ... } }`, `{ text: "..." }`, or `{ base64: "..." }`. NOT a raw string or object.
- `rawRequest()` may populate parsed JSON on `data`. If it does not, decode `response.body.data` with `Buffer.from(..., "base64").toString("utf8")`.

Common errors and fixes:

| Error | Cause | Fix |
|---|---|---|
| `"networkTag is not allowed"` | Used `networkTag` on `open()` | Move to `goto({ url, networkTag })` |
| `"must be array"` on `rawRequest` | Headers passed as `{key: value}` | Use `[{name, value}]` array |
| `"must match exactly one supported shape"` | Body passed as raw string | Wrap in `{json: {...}}` or `{text: "..."}` |
| `"Specify exactly one of element, selector, or description"` | `scroll()` called without a target | Add `selector: "body"` or a `description` |
| `"registry record already exists"` | `inferRequestPlan` called twice with same key+version | Catch the error or use a new version |
| `"no stored extraction descriptor"` | `extract()` called with `description` but no `schema` | Always provide `schema` unless a descriptor was previously stored |

## Common Methods

Session and page control:

- `Opensteer.attach({ name?, rootDir? })`
- `open(url | { url?, name?, browser?, context? })`
- `goto(url | { url, networkTag? })`
- `listPages()`
- `newPage({ url?, openerPageRef? })`
- `activatePage({ pageRef })`
- `closePage({ pageRef })`
- `waitForPage({ openerPageRef?, urlIncludes?, timeoutMs? })`

Interaction and extraction:

- `snapshot("action" | "extraction")`
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
- `saveNetwork({ tag, ...filters })`
- `clearNetwork({ tag? })`

Request capture and replay:

- `rawRequest({ transport?, pageRef?, url, method?, headers?, body?, followRedirects? })`
- `inferRequestPlan({ recordId, key, version, lifecycle? })`
- `writeRequestPlan({ key, version, payload, lifecycle?, tags?, provenance?, freshness? })`
- `getRequestPlan({ key, version? })`
- `listRequestPlans({ key? })`
- `request(key, { path?, query?, headers?, body? })`
- `writeRecipe({ key, version, payload, tags?, provenance? })`
- `getRecipe({ key, version? })`
- `listRecipes({ key? })`
- `runRecipe({ key, version?, input? })`

Instrumentation:

- `captureScripts({ pageRef?, includeInline?, includeExternal?, includeDynamic?, includeWorkers?, urlFilter?, persist? })`
- `addInitScript({ script, args?, pageRef? })`
- `route({ urlPattern, resourceTypes?, times?, handler })`
- `interceptScript({ urlPattern, handler, times? })`

Browser and profile helpers:

- `discoverLocalCdpBrowsers({ timeoutMs? })`
- `inspectCdpEndpoint({ endpoint, headers?, timeoutMs? })`
- `inspectLocalBrowserProfile({ userDataDir? })`
- `unlockLocalBrowserProfile({ userDataDir })`

Lifecycle:

- `disconnect()`
- `close()`

## Rules

- Wrap owned sessions in `try/finally` and call `close()`.
- Use `networkTag` on actions that trigger requests you may inspect later.
- Use `description` when the interaction should be replayable across sessions.
- Use `description` plus `schema` when an extraction should be replayable across sessions.
- Use `element` targets only with a fresh snapshot from the same live session.
- Prefer Opensteer methods over raw Playwright so browser, extraction, and replay semantics stay consistent.
