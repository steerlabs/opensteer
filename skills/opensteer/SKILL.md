---
name: opensteer
description: "Browser automation, scraping, structured extraction, and browser-backed API reverse engineering with the Opensteer CLI and SDK. Use when a task needs to open pages, interact with elements, capture network traffic, write request plans, or turn a browser workflow into reusable code."
---

# Opensteer

Use this skill when a task needs a real browser workflow, structured DOM extraction, or browser-backed request replay.

Choose the reference that matches the job:

- CLI exploration: [references/cli-reference.md](references/cli-reference.md)
- SDK automation: [references/sdk-reference.md](references/sdk-reference.md)
- Request capture and replay: [references/request-workflow.md](references/request-workflow.md)

## Workflow Selection

- Choose the DOM workflow when the deliverable is browser interaction or structured data from the rendered page.
- Choose the reverse workflow when the deliverable is a custom API, request plan, or lower-overhead replay path.
- Many tasks use both: prove the page flow with DOM actions first, then switch to network capture once the important request is clear.

## Shared Rules

- Start with the CLI when you need to explore a site, inspect state, or prove the workflow on a real page.
- Keep `--name` stable for the whole workflow. The same namespace links CLI exploration and SDK replay.
- Re-snapshot after each meaningful page or DOM change before reusing counters.
- Add `--description` when you want selector or extraction persistence and later replay.
- Prefer Opensteer methods over raw Playwright so action, extraction, and replay semantics stay inside the product surface.

## DOM Workflow

```bash
opensteer open https://example.com --name my-workflow
opensteer snapshot action --name my-workflow
opensteer click 3 --name my-workflow --description "primary button"
opensteer snapshot extraction --name my-workflow
opensteer extract --name my-workflow \
  --description "page summary" \
  --schema '{"title":{"selector":"title"},"url":{"source":"current_url"}}'
opensteer close --name my-workflow
```

Use this workflow when the answer must come from the rendered DOM, not from an inferred API.

1. Open the page and keep a stable `--name`.
2. Use `snapshot action` for interactions and counters.
3. Re-run durable actions with `--description` so they replay later without counters.
4. Use `snapshot extraction` to inspect structure and plan the output object.
5. Run `extract` with the exact JSON shape you want and add `--description` if that extraction should be reusable later.

DOM extraction rules:

- `snapshot extraction` is a planning aid. It is not the final data source.
- `extract` reads from the live DOM/runtime and persists deterministic replay paths when you provide `--description`.
- `--description` names the extraction descriptor. It does not define what data to collect.
- Build the exact output object yourself. Each leaf must be explicit: `{ element: N }`, `{ selector: "..." }`, `{ attribute: "..." }`, or `{ source: "current_url" }`.
- Use `element` fields only with a fresh snapshot from the same live session.
- For arrays, include one or more representative objects in the schema. Add multiple representative items when rows differ structurally or when you need to teach distinct variants.
- Do not replace `extract` with custom DOM parsing or `page.evaluate()` when the desired output can be expressed as a structured extraction schema.

## SDK Automation

```ts
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({
  name: "my-workflow",
  rootDir: process.cwd(),
  browser: { headless: true },
});

try {
  await opensteer.open("https://example.com");
  await opensteer.snapshot("action");

  const data = await opensteer.extract({
    description: "page summary",
    schema: {
      title: { selector: "title" },
      url: { source: "current_url" },
    },
  });

  console.log(data);
} finally {
  await opensteer.close();
}
```

SDK rules:

- Wrap owned sessions in `try/finally` and call `close()`.
- Use `Opensteer.attach(...)` plus `disconnect()` when you are attaching to an existing CLI-owned session.
- Keep DOM extraction in `opensteer.extract({ description, schema? })`. Do not rely on raw page DOM parsing for replayable page data.
- Use `networkTag` on actions when you intend to inspect or promote the network traffic they trigger.

## Reverse Workflow

Use this workflow when the real target is the API behind the page. MUST also use it alongside DOM extraction to characterize the site's data architecture before falling back to HTML parsing. Do NOT skip to DOM scraping without first running these steps.

Steps — complete each before moving to the next:

1. **Tag navigation.** Use `open(url)` then `goto({ url, networkTag: "page-load" })`. Tag every interaction (`scroll`, `click`, `input`) with a `networkTag`.
   - `networkTag` is NOT supported on `open()`. If you get `"networkTag is not allowed"`, move the tag to `goto()`.
2. **Query by tag.** Call `queryNetwork({ tag: "page-load", includeBodies: true })`. Then also query all traffic (`queryNetwork({ includeBodies: true })`) to catch async requests that fire after page load.
   - If 0 results for a tag, the tagged action did not trigger network requests. That is a finding, not an error.
3. **Classify traffic.** Separate first-party APIs, auth endpoints, and third-party services. Do this even when you do not find the specific data API you wanted.
4. **Probe transports.** Call `rawRequest()` on each discovered API with `direct-http` first, then `context-http`. This answers: "Does this API work without a browser?"
   - If `rawRequest` fails with `"must be array"`, your headers are in `{key: value}` format — use `[{name, value}]` instead.
   - If `rawRequest` fails with `"must match exactly one supported shape"`, your body is a raw string — wrap it in `{json: {...}}` or `{text: "..."}`.
5. **Acquire auth.** If you find an auth/OAuth endpoint, get a token and re-probe data endpoints with it. Many APIs are behind auth.
   - Response bodies may be wrapped in `{data, encoding}`. If `data` is a base64 string, decode: `JSON.parse(Buffer.from(data, "base64").toString())`.
6. **Infer plans.** Call `inferRequestPlan()` for each useful API record.
   - If it throws `"already exists"`, the key+version was saved in a prior run. Catch the error or bump the version.
7. **Save captures.** Call `saveNetwork({ tag })` to persist tagged traffic for later analysis.
8. **Extract or conclude.** If you found a data API, use it. If not, fall back to DOM extraction — but document that you confirmed no API path exists.

What this workflow is NOT:

- It is NOT just logging API URLs. You MUST actively probe discovered endpoints, not just print them.
- It is NOT optional when the task involves scraping. Run it first; DOM extraction is the fallback.
- It is NOT only for product data APIs. Characterize auth, config, cart, and search APIs too — they are useful artifacts.

Read [references/request-workflow.md](references/request-workflow.md) for input formats, transport probing, and auth token acquisition patterns.
