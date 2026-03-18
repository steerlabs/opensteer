# Opensteer Request Workflow — API Reverse Engineering

## Overview

The request workflow lets you capture network traffic from browser interactions, identify API endpoints, and build reusable request plans that can be replayed with parameter substitution.

**Two transport modes:**
- **`session-http`** — replays through the live browser session, reusing its cookies, auth context, and storage. Requires an open browser.
- **`direct-http`** — replays through a direct HTTP client without browser context. Can run without a browser. Best for public APIs or when you supply auth yourself.

**Auth recipes** can be attached to request plans to handle auth failures deterministically — when a request fails due to expired tokens or sessions, Opensteer runs the recipe to recover auth and retries automatically.

**5-step process:**
1. **Capture** — perform browser actions with `networkTag` to label traffic
2. **Inspect** — query tagged traffic to find the API call
3. **Experiment** — use `rawRequest()` to test the request independently
4. **Promote** — `inferRequestPlan()` to convert to a reusable template
5. **Execute** — `request(key)` to replay with parameter substitution

---

## Step 1: Capture Network Traffic

Perform the browser action that triggers the API call. Tag it so you can find it later.

```typescript
const opensteer = new Opensteer({
  name: "api-capture",
  rootDir: process.cwd(),
  browser: { headless: false },
});

await opensteer.open("https://store.example.com");

// Perform the action that triggers the API, tagging the network traffic
await opensteer.input({
  selector: "input[name=q]",
  text: "airpods",
  pressEnter: true,
  networkTag: "search",
});
```

**Tips:**
- Use descriptive tag names: `"search"`, `"add-to-cart"`, `"login"`.
- You can tag any action: `click`, `input`, `hover`, `scroll`, `goto`.
- Opensteer captures ALL network requests triggered by the tagged action.

---

## Step 2: Inspect Captured Traffic

Query the tagged traffic to find the API request you want.

```typescript
const records = await opensteer.queryNetwork({
  tag: "search",
  includeBodies: true,
});

// Look through the records
for (const record of records.records) {
  console.log(`${record.method} ${record.url} → ${record.status}`);
}
```

**Filtering to find the right request:**

```typescript
// By resource type (XHR/fetch are usually API calls)
const apiCalls = records.records.filter(
  (r) => r.resourceType === "xhr" || r.resourceType === "fetch"
);

// By hostname
const apiCalls = records.records.filter(
  (r) => r.url.includes("api.example.com")
);

// By method
const postCalls = records.records.filter((r) => r.method === "POST");

// By URL pattern
const searchCall = records.records.find(
  (r) => r.url.includes("/search") || r.url.includes("/api/query")
);
```

**What a record looks like** (with `includeBodies: true`):

```typescript
{
  recordId: "rec_abc123",      // Use this for inferRequestPlan
  url: "https://api.example.com/v2/search?q=airpods",
  method: "GET",
  status: 200,
  resourceType: "xhr",
  requestHeaders: [
    { name: "Authorization", value: "Bearer ..." },
    { name: "Content-Type", value: "application/json" },
  ],
  responseHeaders: [...],
  requestBody: { query: "airpods", limit: 20 },   // Parsed if JSON
  responseBody: { results: [...], total: 42 },     // Parsed if JSON
}
```

---

## Step 3: Experiment with Raw Requests

Test the API call independently using `rawRequest()`. This validates that you have the right URL, headers, and body.

```typescript
const searchRecord = records.records.find(
  (r) => r.url.includes("/search") && r.resourceType === "xhr"
);

// Replay through the browser session (default transport)
const test = await opensteer.rawRequest({
  url: searchRecord.url,
  method: searchRecord.method,
  headers: searchRecord.requestHeaders,
  body: searchRecord.requestBody
    ? { json: searchRecord.requestBody }
    : undefined,
});

console.log("Status:", test.response.status);
console.log("Data:", test.data);
```

**Testing without the browser (direct-http):**

```typescript
// Try the same request through direct HTTP — no browser cookies
const test2 = await opensteer.rawRequest({
  transport: "direct-http",
  url: searchRecord.url,
  method: searchRecord.method,
  headers: searchRecord.requestHeaders,
});
```

If the request succeeds with `direct-http`, the API doesn't depend on browser session state and you can build a `direct-http` plan. If it only works with `session-http`, the API needs browser cookies/auth and the plan should use `session-http`.

**Experimenting with minimal headers:**

```typescript
const test3 = await opensteer.rawRequest({
  url: "https://api.example.com/v2/search?q=airpods",
  method: "GET",
  headers: [
    { name: "Accept", value: "application/json" },
  ],
});
```

**Goal:** Find the minimal set of headers and parameters needed for the request to succeed, and determine which transport to use.

---

## Step 4: Promote to Request Plan

Once you've confirmed the request works, promote the captured network record to a reusable request plan.

```typescript
const plan = await opensteer.inferRequestPlan({
  recordId: searchRecord.recordId,   // From the queryNetwork result
  key: "search-api",                 // Key for future reference
  version: "1.0",                    // Version string
  lifecycle: "active",               // "draft" | "active" | "deprecated" | "retired"
});

console.log("Plan created:", plan.key, plan.version);
```

**What `inferRequestPlan` does:**
- Extracts URL, method, headers, and body from the network record
- Builds a `urlTemplate` with query parameters separated out
- Filters out non-replayable headers (host, content-length, etc.)
- Detects auth strategy from headers (`bearer-token`, `api-key`, `session-cookie`, or `custom`)
- Sets transport to `session-http` (inferred plans always use session transport)
- Stores the plan in `.opensteer/registry/request-plans/`

### Manual plan creation

If you want full control over the plan structure, write it manually:

```typescript
const plan = await opensteer.writeRequestPlan({
  key: "search-api",
  version: "1.0",
  lifecycle: "active",
  payload: {
    transport: { kind: "session-http" },
    endpoint: {
      method: "GET",
      urlTemplate: "https://api.example.com/v2/search",
      defaultHeaders: [
        { name: "Accept", value: "application/json" },
      ],
    },
    parameters: [
      { name: "q", in: "query", required: true, description: "Search query" },
      { name: "limit", in: "query", defaultValue: "20" },
    ],
    response: {
      statusCodes: [200],
      contentType: "application/json",
    },
  },
});
```

**Plan payload structure:**

```typescript
{
  transport: { kind: "session-http" | "direct-http" },
  endpoint: {
    method: string,                                  // HTTP verb
    urlTemplate: string,                             // URL with {placeholders} for path params
    defaultQuery?: Array<{ name, value }>,           // Default query parameters
    defaultHeaders?: Array<{ name, value }>,         // Default headers
  },
  parameters?: Array<{
    name: string,
    in: "path" | "query" | "header",                // Where the parameter goes
    wireName?: string,                               // Wire name if different from name
    required?: boolean,
    defaultValue?: string,
    description?: string,
  }>,
  body?: { ... },                                    // Default request body
  response?: {
    statusCodes?: number[],                          // Expected status codes
    contentType?: string,                            // Expected content type
  },
  auth?: {
    strategy: "session-cookie" | "bearer-token" | "api-key" | "custom",
    recipe?: { key: string, version?: string },      // Linked auth recipe
    failurePolicy?: { ... },                         // How to detect auth failure
  },
}
```

---

## Step 5: Execute the Plan

Once a plan exists, execute it with parameter substitution.

- `session-http` plans require an open browser session.
- `direct-http` plans can run without a browser.

```typescript
// Basic execution
const result = await opensteer.request("search-api");

// With query parameters
const result = await opensteer.request("search-api", {
  query: { q: "airpods", limit: "20" },
});

// With headers
const result = await opensteer.request("search-api", {
  headers: { Authorization: "Bearer new-token" },
});

// With body override
const result = await opensteer.request("search-api", {
  body: { json: { query: "airpods", filters: { brand: "Apple" } } },
});

// Access the response
console.log("Status:", result.response.status);
console.log("Data:", result.data);

// Check if auth recovery happened
if (result.recovery?.attempted) {
  console.log("Auth recovery:", result.recovery.succeeded ? "succeeded" : "failed");
}
```

---

## Auth Recipes

Auth recipes are deterministic recovery scripts that run when a request plan's auth fails. They capture fresh tokens, cookies, or session state and feed them back into the retry.

### Writing an auth recipe

```typescript
const recipe = await opensteer.writeAuthRecipe({
  key: "refresh-session",
  version: "1.0.0",
  payload: {
    description: "Refresh session by hitting the token endpoint",
    steps: [
      {
        kind: "sessionRequest",
        request: {
          url: "https://example.com/auth/refresh",
          method: "POST",
        },
        capture: {
          bodyJsonPointer: { pointer: "/access_token", saveAs: "token" },
        },
      },
    ],
    outputs: {
      headers: { Authorization: "Bearer ${token}" },
    },
  },
});
```

### Auth recipe step types

| Step kind | Purpose |
|:----------|:--------|
| `goto` | Navigate the browser to a URL |
| `reload` | Reload the current page |
| `waitForUrl` | Wait for the URL to contain a substring |
| `waitForNetwork` | Wait for a network request matching criteria |
| `waitForCookie` | Wait for a specific cookie to be set |
| `waitForStorage` | Wait for a localStorage/sessionStorage key |
| `readCookie` | Read a cookie value into a variable |
| `readStorage` | Read a storage value into a variable |
| `sessionRequest` | Make an HTTP request through the browser session |
| `directRequest` | Make a raw HTTP request without browser context |
| `hook` | Call a custom hook |

Steps with `saveAs` capture values into variables. Variables are interpolated in subsequent steps and in `outputs` using `${variableName}` syntax.

### Linking a recipe to a request plan

Attach the recipe and a failure policy when writing the plan:

```typescript
const plan = await opensteer.writeRequestPlan({
  key: "protected-api",
  version: "1.0",
  lifecycle: "active",
  payload: {
    transport: { kind: "session-http" },
    endpoint: {
      method: "GET",
      urlTemplate: "https://api.example.com/data",
      defaultHeaders: [
        { name: "Authorization", value: "Bearer initial-token" },
      ],
    },
    auth: {
      strategy: "bearer-token",
      recipe: { key: "refresh-session", version: "1.0.0" },
      failurePolicy: {
        statusCodes: [401, 403],
      },
    },
  },
});
```

### How auth recovery works

When `opensteer.request("protected-api")` is called:
1. Opensteer executes the request normally
2. Checks the response against the `failurePolicy`
3. If the failure policy matches (e.g., status 401):
   - Runs the linked auth recipe
   - Captures variables (e.g., fresh token)
   - Applies the recipe's `outputs` (override headers/query)
   - Retries the request once with the overrides
4. If the retry still fails, throws an error

### Managing auth recipes

```typescript
const recipes = await opensteer.listAuthRecipes();
const recipe = await opensteer.getAuthRecipe({ key: "refresh-session" });

// Run a recipe manually (useful for testing)
const result = await opensteer.runAuthRecipe({
  key: "refresh-session",
  variables: { csrf: "seed-value" },  // Optional seed variables
});
console.log("Captured variables:", result.variables);
console.log("Overrides:", result.overrides);
```

---

## Saving Network Traffic for Later

If you want to persist network traffic beyond the current session:

```typescript
// Save tagged traffic to persistent SQLite storage
await opensteer.saveNetwork({
  tag: "search",
  hostname: "api.example.com",
});

// Later, query saved traffic
const saved = await opensteer.queryNetwork({
  source: "saved",
  tag: "search",
  includeBodies: true,
});
```

---

## Complete Example: Reverse-Engineering a Search API

```typescript
import { Opensteer } from "opensteer";

async function reverseEngineerSearchAPI(): Promise<void> {
  const opensteer = new Opensteer({
    name: "api-capture",
    rootDir: process.cwd(),
    browser: { headless: false },
  });

  try {
    // Step 1: Open site and perform the action
    await opensteer.open("https://store.example.com");
    await opensteer.input({
      selector: "input[name=q]",
      text: "airpods",
      pressEnter: true,
      networkTag: "search",
    });

    // Step 2: Find the API call
    const records = await opensteer.queryNetwork({
      tag: "search",
      includeBodies: true,
    });

    const apiCall = records.records.find(
      (r) => r.resourceType === "xhr" && r.url.includes("/api/")
    );

    if (!apiCall) {
      throw new Error("No API call found in search traffic");
    }

    console.log(`Found API: ${apiCall.method} ${apiCall.url}`);

    // Step 3: Verify the request works independently
    const test = await opensteer.rawRequest({
      url: apiCall.url,
      method: apiCall.method,
      headers: apiCall.requestHeaders,
    });

    console.log(`Raw request status: ${test.response.status}`);

    // Step 4: Promote to a reusable plan
    const plan = await opensteer.inferRequestPlan({
      recordId: apiCall.recordId,
      key: "store-search",
      version: "1.0",
      lifecycle: "active",
    });

    console.log(`Plan created: ${plan.key} v${plan.version}`);

    // Step 5: Execute with different parameters
    const result = await opensteer.request("store-search", {
      query: { q: "iphone", limit: "5" },
    });

    console.log("Results:", JSON.stringify(result.data, null, 2));
  } finally {
    await opensteer.close();
  }
}

void scrapeProducts().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

---

## Managing Plans

```typescript
// List all plans
const allPlans = await opensteer.listRequestPlans();

// List versions of a specific plan
const versions = await opensteer.listRequestPlans({ key: "store-search" });

// Get a specific plan
const plan = await opensteer.getRequestPlan({ key: "store-search", version: "1.0" });
```

---

## CLI Equivalents

Every SDK operation has a CLI equivalent:

| SDK | CLI |
|:----|:----|
| `queryNetwork({ tag, includeBodies: true })` | `opensteer network query --tag x --include-bodies` |
| `saveNetwork({ tag })` | `opensteer network save --tag x` |
| `rawRequest({ url })` | `opensteer request raw https://...` |
| `rawRequest({ url, transport: "direct-http" })` | `opensteer request raw https://... --transport direct-http` |
| `inferRequestPlan({ recordId, key, version })` | `opensteer plan infer --record-id ID --key K --version V` |
| `writeRequestPlan({ key, version, payload })` | `opensteer plan write --key K --version V --payload JSON` |
| `getRequestPlan({ key })` | `opensteer plan get KEY` |
| `listRequestPlans()` | `opensteer plan list` |
| `request("key", { query })` | `opensteer request KEY --query q=x` |
| `writeAuthRecipe({ key, version, payload })` | `opensteer auth-recipe write --key K --version V --payload JSON` |
| `getAuthRecipe({ key })` | `opensteer auth-recipe get KEY` |
| `listAuthRecipes()` | `opensteer auth-recipe list` |
| `runAuthRecipe({ key })` | `opensteer auth-recipe run KEY` |
