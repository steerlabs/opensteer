# Opensteer Request Workflow

Use this workflow when the deliverable is a custom API, a replayable request plan, or a lower-overhead path than full browser automation.

## Transport Selection

- `direct-http`: the request is replayable without a browser.
- `context-http`: browser session state matters, but the request does not need to execute inside page JavaScript.
- `page-http`: the request must execute inside the live page JavaScript world.
- `session-http`: use a stored request plan that still depends on a live browser session.

When in doubt, start with browser-backed capture first. Opensteer treats browser-backed replay as a first-class path, not a fallback.

## SDK Flow

1. Trigger the request from a real page.

```ts
await opensteer.open("https://example.com/app");
await opensteer.click({
  description: "load products",
  networkTag: "products-load",
});
```

2. Inspect the captured traffic.

```ts
const records = await opensteer.queryNetwork({
  tag: "products-load",
  includeBodies: true,
  limit: 20,
});
```

3. Test the request directly.

```ts
const response = await opensteer.rawRequest({
  transport: "context-http",
  url: "https://example.com/api/products",
  method: "POST",
  body: {
    json: { page: 1 },
  },
});
```

4. Promote a captured record into a request plan.

```ts
await opensteer.inferRequestPlan({
  recordId: records.records[0]!.id,
  key: "products.search",
  version: "v1",
});
```

5. Replay the plan from code.

```ts
const result = await opensteer.request("products.search", {
  query: { q: "laptop" },
});
```

## CLI Equivalents

```bash
opensteer network query --name demo --tag products-load --include-bodies --limit 20
opensteer request raw --name demo https://example.com/api/products --transport context-http
opensteer plan infer --name demo --record-id rec_123 --key products.search --version v1
opensteer request execute --name demo products.search --query q=laptop
```

## Practical Guidance

- Capture the browser action first if authentication, cookies, or minted tokens may matter.
- Save or tag the useful traffic before minimizing or diffing it.
- Prefer `direct-http` only after proving the request no longer depends on live browser state.
- Use recipes when the request plan needs deterministic auth refresh or setup work.
