# Request Plan Pipeline

If you haven't decided whether this workflow applies, see the task triage in SKILL.md.

## The Deliverable

The deliverable is a **persisted request plan** that works via `request.execute`. `rawRequest()` is a diagnostic probe — its output is never the final answer. You are not done until `request.execute` returns valid data from a stored plan.

## Critical Rules

1. Action capture is opt-in. `goto()`, `click()`, `input()`, `scroll()`, and `hover()` only persist network records when you pass `captureNetwork`.
2. `queryNetwork()` always reads from the persisted store. There is no `source` parameter. Do NOT pass `source: "saved"` or `source: "live"`.
3. `tagNetwork()` labels already-persisted records. It does NOT save anything. Use it to organize captures for later lookup by tag.
4. `clearNetwork()` permanently removes records with tombstoning. Cleared records cannot be resurrected by late-arriving browser events.
5. `waitForNetwork()` watches for NEW records only. It snapshots existing records and polls for ones that were not present at the start. It does NOT return historical matches.

## Transport Selection

- `direct-http`: the request is replayable without a browser.
- `context-http`: browser session state matters, but the request does not need to execute inside page JavaScript.
- `page-http`: the request must execute inside the live page JavaScript world.
- `session-http`: use a stored request plan that still depends on a live browser session.

When in doubt, start with browser-backed capture first. Opensteer treats browser-backed replay as a first-class path, not a fallback.

## Pipeline Phases

Work through each phase in order. Do NOT skip phases. Each phase has exit criteria — verify them before proceeding.

### Phase 1: Capture

Trigger the real browser action that causes the request. Name the capture.

```bash
opensteer open https://example.com/app --workspace demo
opensteer run page.goto --workspace demo \
  --input-json '{"url":"https://example.com/app","captureNetwork":"page-load"}'
```

For interactions that trigger API calls (search, filter, load-more):

```bash
opensteer run dom.click --workspace demo \
  --input-json '{"target":{"kind":"description","description":"load products"},"captureNetwork":"products-load"}'
```

**EXIT CRITERIA:** You have at least one named capture. If `queryNetwork` returns empty after capture, see Error Recovery.

### Phase 2: Discover

Query captured traffic to isolate the API calls worth replaying. Ignore static assets, analytics, and third-party scripts.

```bash
opensteer run network.query --workspace demo \
  --input-json '{"capture":"products-load","includeBodies":true,"limit":20}'
```

Examine the results. Look for first-party JSON APIs — requests returning `application/json` with data relevant to the task.

If the first query is too broad, filter by hostname, path, or method:

```bash
opensteer run network.query --workspace demo \
  --input-json '{"capture":"products-load","hostname":"api.example.com","method":"GET","includeBodies":true,"limit":10}'
```

**EXIT CRITERIA:** You have identified at least one candidate API URL with its method, recordId, and response shape.

### Phase 3: Probe (Diagnostic Only)

`rawRequest()` is a diagnostic tool. Use it to determine:
1. Which transport works (`direct-http` vs `context-http`)
2. Whether the API returns the expected data shape
3. Whether auth headers are actually required

`rawRequest()` output is NOT the deliverable. Do NOT return rawRequest results to the user as the final answer. Always proceed to Phase 4.

Test portability — try `direct-http` first:

```bash
opensteer run request.raw --workspace demo \
  --input-json '{"transport":"direct-http","url":"https://api.example.com/products","method":"GET"}'
```

If `direct-http` returns 200, the API is portable. If it fails (403/401), try `context-http`:

```bash
opensteer run request.raw --workspace demo \
  --input-json '{"transport":"context-http","url":"https://api.example.com/products","method":"GET"}'
```

**EXIT CRITERIA:** You know which transport works and have a successful response. Note the `recordId` from the probe response — you will use it in Phase 4.

### Phase 4: Infer Plan

Create a request plan from the probed record. Pass the `transport` you proved works.

```bash
opensteer run request-plan.infer --workspace demo \
  --input-json '{"recordId":"<recordId-from-phase-3>","key":"products.search","version":"v1","transport":"direct-http"}'
```

If you proved `direct-http` works, always pass `transport: "direct-http"` so the plan is portable.

If `inferRequestPlan` throws "registry record already exists", bump the version (e.g., `v2`).

**EXIT CRITERIA:** Plan is persisted. You can verify with `request-plan.get`.

### Phase 5: Validate Auth Classification

`inferRequestPlan` records auth metadata by observing headers on the captured request. This is **often wrong**. If the browser sent an `Authorization` header, the plan records `auth.strategy: "bearer-token"` even if the API works without auth.

**MANDATORY VALIDATION:**

1. Read the inferred plan:

```bash
opensteer run request-plan.get --workspace demo \
  --input-json '{"key":"products.search","version":"v1"}'
```

2. Check the `auth` field in `payload`. If `auth` is absent or `undefined`, auth is not detected — skip to Phase 6.

3. If `auth.strategy` is set, test whether the API actually needs it. Run a raw request to the same URL with NO auth headers:

```bash
opensteer run request.raw --workspace demo \
  --input-json '{"transport":"direct-http","url":"<the-api-url>","method":"GET"}'
```

4. If it returns 200 without auth headers, auth is **spurious** — the browser attached a token the API doesn't enforce. Rewrite the plan with corrected auth:

```bash
opensteer run request-plan.write --workspace demo \
  --input-json '{
    "key":"products.search",
    "version":"v1",
    "tags":["products","search"],
    "provenance":{"source":"manual","notes":"Auth removed — API is public, bearer token was incidental."},
    "payload":{
      ...existing payload with auth field removed...
    }
  }'
```

Copy the full existing `payload` from `request-plan.get`, remove or null out the `auth` field, and write it back.

5. If the no-auth probe returns 401/403, auth IS required. Keep the auth classification and proceed. You will create an auth recipe in Phase 8 after testing the plan.

**EXIT CRITERIA:** The plan's `auth` field accurately reflects whether auth is required.

### Phase 6: Annotate Parameters

`inferRequestPlan` dumps all query and body parameters into `defaultQuery`/`defaultBody` without distinguishing variable from fixed.

1. Read the plan with `request-plan.get`.

2. Examine each parameter in `defaultQuery`:
   - **Variable:** values that change per invocation — search terms, page numbers, offsets, dates, user-specific IDs
   - **Fixed:** values constant for this API — site keys, platform identifiers, API versions, channel strings

3. Rewrite the plan with the `parameters` field annotating variable inputs:

```bash
opensteer run request-plan.write --workspace demo \
  --input-json '{
    "key":"products.search",
    "version":"v1",
    "payload":{
      ...existing payload...,
      "parameters":[
        {"name":"keyword","in":"query","required":true,"description":"Search term"},
        {"name":"count","in":"query","defaultValue":"24","description":"Results per page"},
        {"name":"offset","in":"query","defaultValue":"0","description":"Pagination offset"}
      ]
    }
  }'
```

Variable params remain in `defaultQuery` as initial values. The `parameters` field documents which ones a caller should override via `request.execute` input.

**EXIT CRITERIA:** The plan's `parameters` field lists all variable inputs with descriptions.

### Phase 7: Test Plan

Execute the plan through `request.execute`, NOT `rawRequest`:

```bash
opensteer run request.execute --workspace demo \
  --input-json '{"key":"products.search","version":"v1","query":{"keyword":"laptop","count":"10"}}'
```

**GATE:**
- If `request.execute` returns valid data → proceed to Phase 9 (Done).
- If `request.execute` returns 401/403 and Phase 5 confirmed auth is required → proceed to Phase 8 (Auth Recipe).
- If `request.execute` fails with another error → see Error Recovery.

### Phase 8: Auth Recipe (Conditional)

Enter this phase ONLY if Phase 5 confirmed auth is genuinely required AND Phase 7 failed with 401/403.

#### Step 8a: Discover Auth Endpoint

Search captured traffic for OAuth, token, or login endpoints:

```bash
opensteer run network.query --workspace demo \
  --input-json '{"path":"/oauth","includeBodies":true,"limit":10}'
opensteer run network.query --workspace demo \
  --input-json '{"path":"/token","includeBodies":true,"limit":10}'
opensteer run network.query --workspace demo \
  --input-json '{"path":"/auth","includeBodies":true,"limit":10}'
```

Examine responses to find the endpoint that returns an access token.

#### Step 8b: Probe Auth Endpoint

Test the auth endpoint with `request.raw`:

```bash
opensteer run request.raw --workspace demo \
  --input-json '{
    "transport":"direct-http",
    "url":"https://example.com/api/oauth/token",
    "method":"POST",
    "body":{"json":{"grant_type":"client_credentials"}}
  }'
```

Verify it returns a token. Note the response shape (e.g., `{ "access_token": "..." }`).

#### Step 8c: Create Auth Recipe

Write an auth recipe that acquires a fresh token and maps it to request headers:

```bash
opensteer run auth-recipe.write --workspace demo \
  --input-json '{
    "key":"example.auth",
    "version":"v1",
    "payload":{
      "description":"Acquire bearer token for example.com API",
      "steps":[
        {
          "kind":"directRequest",
          "request":{
            "url":"https://example.com/api/oauth/token",
            "transport":"direct-http",
            "method":"POST",
            "body":{"json":{"grant_type":"client_credentials"}}
          },
          "capture":{
            "bodyJsonPointer":{"pointer":"/access_token","saveAs":"token"}
          }
        }
      ],
      "outputs":{
        "headers":{"Authorization":"Bearer {{token}}"}
      }
    }
  }'
```

**Recipe step types you can use:**
- `directRequest` — HTTP request outside the browser (portable, no session needed)
- `sessionRequest` — HTTP request using browser session state (cookies, etc.)
- `request` — generic request step
- `readCookie` — read a browser cookie value, `saveAs` a variable
- `readStorage` — read localStorage/sessionStorage, `saveAs` a variable
- `evaluate` — run JavaScript in the page, `saveAs` a variable
- `waitForNetwork` — wait for a network request matching filters
- `waitForCookie` — wait for a cookie to appear
- `goto` — navigate to a URL (e.g., trigger a login page)
- `solveCaptcha` — solve a CAPTCHA challenge

Each step can have a `capture` field to extract values from the response. The `outputs` field maps captured variables to `headers`, `query`, `params`, or `body` overrides applied to the request plan at execution time.

#### Step 8d: Bind Auth Recipe to Plan

Update the plan to reference the auth recipe:

```bash
opensteer run request-plan.get --workspace demo \
  --input-json '{"key":"products.search","version":"v1"}'
```

Read the current payload, then write it back with the `auth.recipe` binding:

```bash
opensteer run request-plan.write --workspace demo \
  --input-json '{
    "key":"products.search",
    "version":"v1",
    "payload":{
      ...existing payload...,
      "auth":{
        "strategy":"bearer-token",
        "recipe":{"key":"example.auth","version":"v1"},
        "failurePolicy":{"on":"status","status":"401","action":"recover"}
      }
    }
  }'
```

The `failurePolicy` tells the plan to automatically re-run the auth recipe when a 401 is received.

#### Step 8e: Test Authenticated Plan

```bash
opensteer run request.execute --workspace demo \
  --input-json '{"key":"products.search","version":"v1","query":{"keyword":"laptop"}}'
```

The auth recipe fires automatically before the request. If it still fails, inspect the token response shape and fix the recipe.

**EXIT CRITERIA:** `request.execute` returns valid data with the auth recipe attached.

### Phase 9: Done

Close the browser session:

```bash
opensteer close --workspace demo
```

The plan persists in the workspace registry and (if cloud mode) in Convex. Future callers can replay it with `request.execute` without opening a browser.

## Error Recovery

### `request.execute` returns 400 Bad Request

1. Read the plan: `request-plan.get`
2. Compare the plan's `defaultQuery`, `defaultBody`, and `defaultHeaders` against the original captured request from Phase 2
3. Identify the discrepancy — missing required parameter, wrong content-type, malformed body
4. Fix the plan with `request-plan.write`
5. Re-test with `request.execute`
6. If still failing after 2 fix attempts, use `request.raw` to isolate which specific parameter causes the 400 — remove params one at a time

### `request.execute` returns 401/403 Unauthorized

1. Was auth classification validated in Phase 5? If not, go back to Phase 5.
2. If auth is confirmed needed, enter Phase 8 (Auth Recipe).
3. If an auth recipe exists but fails, inspect the token response — the token may have expired, the scope may be wrong, or the grant type may differ.

### `request.execute` returns 404 Not Found

1. The API path may have changed since capture. Re-capture traffic (Phase 1) and re-discover (Phase 2).
2. Check if the URL uses path parameters that were hardcoded during inference. These may need to be templated.

### `request.execute` returns 500 Server Error

This is the API server's problem, not a plan problem. Retry once. If persistent, document and report to the user.

### `inferRequestPlan` throws "registry record already exists"

The key+version combination is already registered. Bump the version string (e.g., `v1` → `v2`).

### `queryNetwork()` returns empty records

- Verify `captureNetwork` was set on the action that triggered the request (not on `open()`).
- Re-trigger the action with `captureNetwork`. Records are auto-persisted on actions that opt in.
- Broaden filters: try removing `tag` and querying by `hostname` or `path` instead.
- Check that the request actually fired — some SPAs lazy-load data or use WebSocket instead of HTTP.

### `rawRequest()` returns non-200

This is diagnostic information. Use it to decide transport and debug, not as a final answer.
- If `direct-http` fails with 403/401: the API requires session state. Try `context-http`.
- If `context-http` fails: the API may require specific cookies or tokens. Check for auth endpoints in captured traffic.
- If the response body is empty: decode `response.body.data` with `Buffer.from(data, "base64").toString("utf8")` — the parsed `data` field may not be populated.

### `waitForNetwork()` times out

- `waitForNetwork()` only matches records that appear AFTER the call starts. If the request already fired, use `queryNetwork()` instead.
- Ensure the triggering action happens AFTER calling `waitForNetwork()`.

## Input Formats

`rawRequest` and recipe steps expect specific shapes:

- `headers`: array of `[{ name, value }]`, not `{ key: value }`. Exception: recipe step `request` fields accept `{ key: value }` objects.
- `body`: one of `{ json: { ... } }`, `{ text: "..." }`, or `{ base64: "..." }`. Not raw strings.
- `request.execute` input includes `key` inside the JSON object. The SDK convenience wrapper `opensteer.request(key, input)` adds that for you.

## Practical Guidance

Mandatory steps:
- MUST use `goto({ url, captureNetwork })` to name navigation capture. `captureNetwork` is NOT supported on `open()`.
- MUST query by capture first, then query all traffic to catch async requests.
- MUST probe every discovered first-party API with transport tests. Do NOT just log URLs.
- The deliverable is a persisted plan. `rawRequest()` output is never the final answer.

Common mistakes:
- Stopping at `rawRequest` output and returning it to the user. Always proceed to `inferRequestPlan` and `request.execute`.
- Trusting inferred auth metadata without validation. Always run Phase 5.
- Passing headers as `{key: value}` to `rawRequest`. MUST use `[{name, value}]` arrays.
- Passing body as a raw string to `rawRequest`. MUST wrap in `{json: {...}}`, `{text: "..."}`, or `{base64: "..."}`.
- Skipping parameter annotation. Variable params should be documented in the plan's `parameters` field.
- Not closing the browser after completing the pipeline. Always run `opensteer close` when done.
