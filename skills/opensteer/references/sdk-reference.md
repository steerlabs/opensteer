# Opensteer SDK Reference

Use the SDK when the workflow should become reusable TypeScript code in the repository.

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
- The current public SDK does not expose `Opensteer.attach()`, cloud session helpers, or the ABP engine.

## DOM Automation And Extraction

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  workspace: "demo",
  rootDir: process.cwd(),
});

await opensteer.open("https://example.com");
await opensteer.snapshot("action");

await opensteer.click({
  selector: "button.primary",
  description: "primary button",
});

await opensteer.input({
  selector: "input[type=search]",
  description: "search input",
  text: "laptop",
  pressEnter: true,
});

const data = await opensteer.extract({
  description: "page summary",
  schema: {
    title: { selector: "title" },
    url: { source: "current_url" },
  },
});

const replayed = await opensteer.extract({
  description: "page summary",
});
```

DOM rules:

- Use `snapshot("action")` before counter-based interactions.
- Use `snapshot("extraction")` to inspect the page structure and design the output object.
- Treat snapshots as planning artifacts. `extract()` reads current page state and replays persisted extraction descriptors from deterministic, snapshot-backed payloads.
- `selector + description` or `element + description` persists a DOM action descriptor. Bare `description` replays it later.
- `description + schema` writes or updates a persisted extraction descriptor. Bare `description` replays it later.
- Keep DOM data collection in `extract()`, not `evaluate()` or raw page DOM parsing, when the result can be expressed as structured fields.

Supported extraction field shapes in the current public SDK:

- `{ element: N }`
- `{ element: N, attribute: "href" }`
- `{ selector: ".price" }`
- `{ selector: "img.hero", attribute: "src" }`
- `{ source: "current_url" }`

For arrays, include one or more representative objects in the schema. Add multiple examples when repeated rows have structural variants.

Do not use `prompt` or semantic placeholder values such as `"string"` in the current public SDK. The extractor expects explicit schema objects, arrays, and field descriptors.

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

await opensteer.saveNetwork({
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
- Save important captures with `saveNetwork()` before the session closes.
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
- Use `description` when the interaction should be replayable across sessions.
- Use `description` plus `schema` when an extraction should be replayable across sessions.
- Use `element` targets only with a fresh snapshot from the same live session.
- Prefer Opensteer methods over raw Playwright so browser, extraction, and replay semantics stay consistent.
