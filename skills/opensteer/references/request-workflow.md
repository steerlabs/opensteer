# Opensteer Request Workflow

Use this workflow when the deliverable is a custom API, a replayable request plan, or a lower-overhead path than full browser automation.

## Sections

- [Standard Loop](#standard-loop)
- [Transport Selection](#transport-selection)
- [SDK Flow](#sdk-flow)
- [CLI Equivalents](#cli-equivalents)
- [Transport Probing](#transport-probing)
- [Auth Token Acquisition](#auth-token-acquisition)
- [Input Formats](#input-formats)
- [Practical Guidance](#practical-guidance)

## Standard Loop

1. Trigger the real browser action that causes the request inside a stable workspace.
2. Tag the important navigation or interactions with `networkTag`.
3. Inspect the captured traffic and isolate the relevant records.
4. Save useful captures to the workspace if they need to survive later analysis.
5. Probe the request with `rawRequest()` — try `direct-http` first, then `context-http`.
6. Infer a request plan from the probed record — pass `transport` if you proved portability.
7. Add recipes or auth recipes if replay needs deterministic setup.
8. Replay the plan from code — works immediately, no extra steps.

This workflow should carry equal weight with DOM automation. Use it whenever the browser page is only the launcher for the real target request.

## Transport Selection

- `direct-http`: the request is replayable without a browser.
- `context-http`: browser session state matters, but the request does not need to execute inside page JavaScript.
- `page-http`: the request must execute inside the live page JavaScript world.
- `session-http`: use a stored request plan that still depends on a live browser session.

When in doubt, start with browser-backed capture first. Opensteer treats browser-backed replay as a first-class path, not a fallback.

## SDK Flow

1. Start a workspace-backed browser flow and tag navigation.

```ts
await opensteer.open();
await opensteer.goto({
  url: "https://example.com/app",
  networkTag: "page-load",
});

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

3. Probe the request — try `direct-http` first to test portability.

```ts
const response = await opensteer.rawRequest({
  transport: "direct-http",
  url: "https://example.com/api/products",
  method: "POST",
  body: {
    json: { page: 1 },
  },
});
// If direct-http returns 200, the API is portable (no browser needed).
// If it fails, try context-http — the API needs browser session state.
```

4. Infer a request plan — pass `transport` if you proved portability.

```ts
await opensteer.inferRequestPlan({
  recordId: response.recordId,
  key: "products.search",
  version: "v1",
  transport: "direct-http", // use the transport you proved works
});
```

5. Save the captured traffic if you want it in the workspace registry.

```ts
await opensteer.saveNetwork({
  tag: "products-load",
});
```

Saved-network persistence is SQLite-backed and initializes on first use. Generic workspace and browser flows do not require SQLite capability unless they touch saved-network persistence.

6. Replay the plan from code.

```ts
const result = await opensteer.request("products.search", {
  query: { q: "laptop" },
});
```

7. Add a recipe or auth recipe if replay needs deterministic setup.

```ts
await opensteer.runRecipe({
  key: "products.setup",
});

await opensteer.runAuthRecipe({
  key: "products.auth",
});
```

## CLI Equivalents

```bash
opensteer open https://example.com/app --workspace demo
opensteer run page.goto --workspace demo \
  --input-json '{"url":"https://example.com/app","networkTag":"page-load"}'
opensteer click --workspace demo --description "load products"
  # or with networkTag: opensteer run dom.click --workspace demo \
  #   --input-json '{"target":{"kind":"description","description":"load products"},"networkTag":"products-load"}'
opensteer run network.query --workspace demo \
  --input-json '{"source":"saved","tag":"products-load","includeBodies":true,"limit":20}'
opensteer run request.raw --workspace demo \
  --input-json '{"transport":"direct-http","url":"https://example.com/api/products","method":"POST","body":{"json":{"page":1}}}'
opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"rec_123","key":"products.search","version":"v1","transport":"direct-http"}'
opensteer run request.execute --workspace demo \
  --input-json '{"key":"products.search","query":{"q":"laptop"}}'
```

## Transport Probing

Test each discovered API with multiple transports to determine portability:

```ts
const direct = await opensteer.rawRequest({
  transport: "direct-http",
  url: discoveredUrl,
  method: "GET",
});

const context = await opensteer.rawRequest({
  transport: "context-http",
  url: discoveredUrl,
  method: "GET",
});
```

If `direct-http` returns 200, the API is portable and does not need a browser for future calls. If only `context-http` works, the API depends on browser session state.

After proving portability, infer the plan with an explicit transport override:

```ts
await opensteer.inferRequestPlan({
  recordId: records.records[0]!.id,
  key: "products.search.portable",
  version: "v1",
  transport: "direct-http",
});
```

```bash
opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"rec_123","key":"products.search.portable","version":"v1","transport":"direct-http"}'
```

## Auth Token Acquisition

When you discover an auth endpoint, acquire a token and use it to probe for data APIs that may be behind auth:

```ts
const tokenResp = await opensteer.rawRequest({
  transport: "direct-http",
  url: "https://example.com/api/oauth/token?scope=guest",
  method: "POST",
});

let parsed = tokenResp.data;
if (parsed === undefined) {
  const body = tokenResp.response.body;
  if (!body) {
    throw new Error("Token response had no body");
  }
  parsed = JSON.parse(Buffer.from(body.data, "base64").toString("utf8"));
}

const token = String((parsed as { access_token: unknown }).access_token);

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
- `request.execute` semantic input includes `key` inside the JSON object. The SDK convenience wrapper `opensteer.request(key, input)` adds that for you.

## Practical Guidance

Mandatory steps:

- MUST use `goto({ url, networkTag })` to tag navigation. `networkTag` is NOT supported on `open()`. In the CLI, this means `opensteer run page.goto --input-json ...`.
- MUST query by tag first (`queryNetwork({ tag })`), then query all traffic to catch async requests.
- MUST probe every discovered first-party API with transport tests. Do NOT just log URLs.
- MUST call `saveNetwork({ tag })` before closing the session.
- Use `queryNetwork({ source: "saved" })` when you want to read previously persisted captures after the live session is gone.

Common mistakes:

- Do NOT pass headers as `{key: value}`. MUST use `[{name, value}]` arrays.
- Do NOT pass body as a raw string. MUST wrap it in `{json: {...}}`, `{text: "..."}`, or `{base64: "..."}`.
- Do NOT skip auth probing. If you find an OAuth endpoint, get a token and re-probe with it.
- Do NOT treat "no data API found" as failure. It is a valid reverse-engineering conclusion that justifies DOM fallback.
- Do NOT mix up recipes and auth recipes. They are separate registries and can reuse the same key/version independently.

Additional guidance:

- Capture the browser action first if authentication, cookies, or minted tokens may matter.
- Probe with `direct-http` first. If it works, pass `transport: "direct-http"` to `inferRequestPlan` so the plan is portable. If it fails, fall back to `context-http`.
- `inferRequestPlan()` throws if the key+version already exists. Catch the error or bump the version.
- Inferred plans are immediately usable — `request.execute` works right after inference.
- Use recipes when the request plan needs deterministic setup work. Use auth recipes when the setup is specifically auth refresh or login state.
- Stay in the DOM workflow only when the rendered page itself is the deliverable. Move here when the request is the durable artifact.
