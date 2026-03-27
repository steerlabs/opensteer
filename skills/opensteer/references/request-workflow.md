# Opensteer Request Workflow

Use this workflow when the deliverable is a custom API, a replayable request plan, or a lower-overhead path than full browser automation.

## Standard Loop

1. Trigger the real browser action that causes the request.
2. Inspect the resulting traffic and isolate the relevant records.
3. Prove the request with `rawRequest()` or `opensteer request raw`.
4. Promote the winning record into a request plan.
5. Replay the plan from code.
6. Add recipes if the plan needs deterministic auth or setup work.

This workflow should carry equal weight with DOM automation. Use it whenever the browser page is only the launcher for the real target request.

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

6. Add a recipe if replay needs deterministic setup.

```ts
await opensteer.runRecipe({
  key: "products.auth",
});
```

## CLI Equivalents

```bash
opensteer network query --name demo --tag products-load --include-bodies --limit 20
opensteer request raw --name demo https://example.com/api/products --transport context-http
opensteer plan infer --name demo --record-id rec_123 --key products.search --version v1
opensteer request execute --name demo products.search --query q=laptop
```

## Transport Probing

Test each discovered API with multiple transports to determine portability:

```ts
// direct-http: works without any browser?
const direct = await opensteer.rawRequest({
  transport: "direct-http",
  url: discoveredUrl,
  method: "GET",
});

// context-http: works with browser cookies/session?
const context = await opensteer.rawRequest({
  transport: "context-http",
  url: discoveredUrl,
  method: "GET",
});
```

If `direct-http` returns 200, the API is portable — no browser needed for future calls. If only `context-http` works, the API depends on browser session state.

## Auth Token Acquisition

When you discover an auth endpoint (e.g., OAuth token), acquire a token and use it to probe for data APIs that may be behind auth:

```ts
const tokenResp = await opensteer.rawRequest({
  transport: "direct-http",
  url: "https://example.com/api/oauth/token?scope=guest",
  method: "POST",
});

// Use parsed JSON when available; otherwise decode response.body.
let parsed = tokenResp.data;
if (parsed === undefined) {
  const body = tokenResp.response.body;
  if (!body) {
    throw new Error("Token response had no body");
  }
  parsed = JSON.parse(Buffer.from(body.data, "base64").toString("utf8"));
}

const token = String((parsed as { access_token: unknown }).access_token);

// Re-probe with auth
const authed = await opensteer.rawRequest({
  transport: "direct-http",
  url: "https://example.com/api/products",
  method: "GET",
  headers: [{ name: "Authorization", value: `Bearer ${token}` }],
});
```

## Input Formats

`rawRequest` expects specific shapes:

- `headers`: array of `[{ name, value }]`, not `{ key: value }`.
- `body`: one of `{ json: { ... } }`, `{ text: "..." }`, or `{ base64: "..." }`. Not raw strings.

## Practical Guidance

Mandatory steps — do NOT skip these:

- MUST use `goto({ url, networkTag })` to tag navigation. `networkTag` is NOT supported on `open()`.
- MUST query by tag first (`queryNetwork({ tag })`), then query all traffic to catch async requests.
- MUST probe every discovered first-party API with transport tests. Do NOT just log URLs.
- MUST call `saveNetwork({ tag })` before closing the session.

Common mistakes:

- Do NOT pass headers as `{key: value}`. MUST use `[{name, value}]` arrays.
- Do NOT pass body as a raw string. MUST wrap in `{json: {...}}`, `{text: "..."}`, or `{base64: "..."}`.
- Do NOT skip auth probing. If you find an OAuth endpoint, get a token and re-probe with it.
- Do NOT treat "no data API found" as failure. It is a valid reverse-engineering conclusion that justifies DOM fallback.

Additional guidance:

- Capture the browser action first if authentication, cookies, or minted tokens may matter.
- Prefer `direct-http` only after proving the request no longer depends on live browser state.
- `inferRequestPlan()` throws if the key+version already exists. Catch the error or bump the version.
- Use recipes when the request plan needs deterministic auth refresh or setup work.
- Stay in the DOM workflow only when the rendered page itself is the deliverable. Move here when the request is the durable artifact.
