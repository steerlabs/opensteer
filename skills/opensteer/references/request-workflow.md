# Opensteer Request Workflow — API Reverse Engineering

## Overview

The request workflow lets you capture network traffic from browser interactions, identify API endpoints, and build reusable request plans that call those APIs directly — no browser needed for subsequent calls.

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

// Replay the exact request
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

**Experimenting with variations:**

```typescript
// Try different query parameters
const test2 = await opensteer.rawRequest({
  url: "https://api.example.com/v2/search?q=iphone&limit=10",
  method: "GET",
  headers: searchRecord.requestHeaders,
});

// Try with minimal headers
const test3 = await opensteer.rawRequest({
  url: "https://api.example.com/v2/search?q=airpods",
  method: "GET",
  headers: [
    { name: "Accept", value: "application/json" },
  ],
});
```

**Goal:** Find the minimal set of headers and parameters needed for the request to succeed.

---

## Step 4: Promote to Request Plan

Once you've confirmed the request works, promote the captured network record to a reusable request plan.

```typescript
const plan = await opensteer.inferRequestPlan({
  recordId: searchRecord.recordId,   // From the queryNetwork result
  key: "search-api",                 // Key for future reference
  version: "1.0",                    // Version string
  lifecycle: "active",               // "draft" | "active" | "deprecated"
});

console.log("Plan created:", plan.key, plan.version);
```

**What `inferRequestPlan` does:**
- Takes the full request from the network record (URL, method, headers, body)
- Stores it as a reusable template in `.opensteer/registry/request-plans/`
- The plan can be executed later with parameter overrides

### Manual plan creation

If you want full control over the plan, write it manually:

```typescript
const plan = await opensteer.writeRequestPlan({
  key: "search-api",
  version: "1.0",
  lifecycle: "active",
  payload: {
    method: "GET",
    url: "https://api.example.com/v2/search",
    headers: [
      { name: "Accept", value: "application/json" },
      { name: "User-Agent", value: "Mozilla/5.0 ..." },
    ],
  },
});
```

---

## Step 5: Execute the Plan

Once a plan exists, execute it with parameter substitution. No browser session required for this step.

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
  body: { query: "airpods", filters: { brand: "Apple" } },
});

// Access the response
console.log("Status:", result.response.status);
console.log("Data:", result.data);
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

void reverseEngineerSearchAPI().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
```

## Managing Plans

```typescript
// List all plans
const allPlans = await opensteer.listRequestPlans();

// List versions of a specific plan
const versions = await opensteer.listRequestPlans({ key: "store-search" });

// Get a specific plan
const plan = await opensteer.getRequestPlan({ key: "store-search", version: "1.0" });
```

## CLI Equivalents

Every SDK operation has a CLI equivalent:

| SDK | CLI |
|:----|:----|
| `queryNetwork({ tag: "x", includeBodies: true })` | `opensteer network query --tag x --include-bodies` |
| `saveNetwork({ tag: "x" })` | `opensteer network save --tag x` |
| `rawRequest({ url: "..." })` | `opensteer request raw https://...` |
| `inferRequestPlan({ recordId, key, version })` | `opensteer plan infer --record-id ID --key K --version V` |
| `request("key", { query: { q: "x" } })` | `opensteer request key --query q=x` |
