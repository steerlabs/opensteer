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

## Core Browser Flow

```ts
await opensteer.open("https://example.com");
await opensteer.goto("https://example.com/products");
await opensteer.snapshot("action");
await opensteer.click({ description: "primary button" });
await opensteer.input({ description: "search input", text: "laptop", pressEnter: true });
await opensteer.hover({ description: "price filter" });
await opensteer.scroll({ direction: "down", amount: 600 });
const data = await opensteer.extract({
  description: "page summary",
  schema: {
    title: { selector: "title" },
    url: { source: "current_url" },
  },
});
```

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
- Use `element` targets only with a fresh snapshot from the same live session.
- Prefer Opensteer methods over raw Playwright so browser, extraction, and replay semantics stay consistent.
