# Opensteer SDK Reference

## Installation

```bash
npm install opensteer
# or
pnpm add opensteer
```

## Import

```typescript
import { Opensteer } from "opensteer";
```

## Constructor

```typescript
const opensteer = new Opensteer(options?: OpensteerOptions);
```

### OpensteerOptions

```typescript
interface OpensteerOptions {
  name?: string;          // Session name (default: auto-generated)
  rootDir?: string;       // Project root for .opensteer/ storage (default: cwd)
  engine?: "playwright";  // Browser engine
  browser?: {
    headless?: boolean;       // Run headless (default: false)
    executablePath?: string;  // Custom browser path
    channel?: string;         // Browser channel (chrome, msedge, etc.)
    devtools?: boolean;       // Open devtools
    timeoutMs?: number;       // Session timeout
  };
  context?: {
    viewport?: { width: number; height: number } | null;
    locale?: string;
    timezoneId?: string;
    userAgent?: string;
    ignoreHTTPSErrors?: boolean;
    bypassCSP?: boolean;
    javaScriptEnabled?: boolean;
    colorScheme?: "light" | "dark" | "no-preference";
    reducedMotion?: "reduce" | "no-preference";
  };
  connect?: boolean | { url: string; headers?: Record<string, string> };
  cloud?: boolean | { apiKey: string; baseUrl?: string };
}
```

---

## Methods

### Session

#### `open(url?: string): Promise<OpensteerSessionOpenOutput>`

Opens the browser session. Optionally navigates to a URL.

```typescript
await opensteer.open();
await opensteer.open("https://example.com");
```

#### `close(): Promise<OpensteerSessionCloseOutput>`

Closes the browser session. Always call this in a `finally` block.

```typescript
await opensteer.close();
```

---

### Navigation

#### `goto(input: string | OpensteerGotoOptions): Promise<OpensteerPageGotoOutput>`

Navigates to a URL.

```typescript
await opensteer.goto("https://example.com");
await opensteer.goto({ url: "https://example.com", networkTag: "nav" });
```

---

### Snapshots

#### `snapshot(mode?: "action" | "extraction"): Promise<OpensteerPageSnapshotOutput>`

Captures a page snapshot.

```typescript
const snap = await opensteer.snapshot("action");
// snap.counters — array of interactive elements:
//   { element: number, tagName: string, pathHint: string, ... }

const snap = await opensteer.snapshot("extraction");
// Full DOM structure for extraction
```

**Return shape** (action mode):
```typescript
{
  counters: Array<{
    element: number;      // Counter number for targeting
    tagName: string;      // HTML tag name
    pathHint: string;     // CSS-like path hint (e.g., "#search-input")
  }>;
  html: string;           // Annotated HTML snapshot
}
```

---

### DOM Actions

All actions return `Promise<OpensteerActionResult>`.

#### Target Options

Every action method accepts a target via one of three mutually exclusive fields:

```typescript
interface OpensteerTargetOptions {
  element?: number;       // Counter from snapshot
  selector?: string;      // CSS selector
  description?: string;   // Semantic descriptor key
  networkTag?: string;    // Tag network traffic triggered by this action
}
```

**Rules:**
- Specify exactly one of `element`, `selector`, or `description`.
- When using `element` or `selector`, you may also pass `description` — this saves the resolved element path as a descriptor for future replay.
- `networkTag` is independent and can always be added.

#### `click(input: OpensteerTargetOptions): Promise<OpensteerActionResult>`

```typescript
await opensteer.click({ element: 5 });
await opensteer.click({ selector: "button.submit" });
await opensteer.click({ description: "add to cart button" });
await opensteer.click({ element: 5, description: "add to cart", networkTag: "cart" });
```

#### `hover(input: OpensteerTargetOptions): Promise<OpensteerActionResult>`

```typescript
await opensteer.hover({ element: 3 });
await opensteer.hover({ selector: ".menu-trigger" });
```

#### `input(input: OpensteerInputOptions): Promise<OpensteerActionResult>`

```typescript
interface OpensteerInputOptions extends OpensteerTargetOptions {
  text: string;           // Text to type (required)
  pressEnter?: boolean;   // Press Enter after typing
}
```

```typescript
await opensteer.input({ selector: "input[name=q]", text: "search query" });
await opensteer.input({ description: "search box", text: "airpods", pressEnter: true });
```

#### `scroll(input: OpensteerScrollOptions): Promise<OpensteerActionResult>`

```typescript
interface OpensteerScrollOptions extends OpensteerTargetOptions {
  direction: "up" | "down" | "left" | "right";
  amount: number;         // Scroll amount (positive number)
}
```

```typescript
await opensteer.scroll({ selector: ".results", direction: "down", amount: 3 });
```

---

### Data Extraction

#### `extract(input: OpensteerExtractOptions): Promise<unknown>`

Extracts structured data from the page.

```typescript
interface OpensteerExtractOptions {
  description: string;                   // Extraction descriptor key (required)
  schema?: Record<string, unknown>;      // Extraction schema
}
```

```typescript
// With schema — extracts data matching the schema structure
const data = await opensteer.extract({
  description: "product list",
  schema: {
    title: { selector: "h1" },
    url: { source: "current_url" },
    items: [{
      name: { selector: ".product-name" },
      price: { selector: ".product-price" },
      link: { selector: ".product-link", attribute: "href" },
    }],
  },
});

// Without schema — replays a persisted extraction descriptor
const data = await opensteer.extract({ description: "product list" });
```

**Schema field types:**

| Field definition | Extracts |
|:-----------------|:---------|
| `{ selector: ".class" }` | Text content of the matched element |
| `{ selector: "a", attribute: "href" }` | Attribute value of the matched element |
| `{ source: "current_url" }` | The current page URL |
| `[{ field: { selector: ".item" } }]` | Array of objects from repeating elements |

---

### Network Operations

#### `queryNetwork(input?: OpensteerNetworkQueryOptions): Promise<OpensteerNetworkQueryResult>`

Queries captured network traffic.

```typescript
// All recent traffic
const records = await opensteer.queryNetwork();

// Tagged traffic with bodies
const records = await opensteer.queryNetwork({
  tag: "search",
  includeBodies: true,
});

// Filtered query
const records = await opensteer.queryNetwork({
  hostname: "api.example.com",
  method: "POST",
  resourceType: "xhr",
});
```

**Query options:**
```typescript
interface OpensteerNetworkQueryOptions {
  source?: "journal" | "saved";  // Default: "journal" (in-memory)
  tag?: string;
  includeBodies?: boolean;
  limit?: number;
  recordId?: string;
  requestId?: string;
  actionId?: string;
  url?: string;
  hostname?: string;
  path?: string;
  method?: string;
  status?: string;
  resourceType?: string;
  pageRef?: string;
}
```

**Record shape:**
```typescript
{
  recordId: string;
  url: string;
  method: string;
  status: number;
  resourceType: string;
  requestHeaders: Array<{ name: string; value: string }>;
  responseHeaders: Array<{ name: string; value: string }>;
  requestBody?: unknown;   // Present when includeBodies: true
  responseBody?: unknown;  // Present when includeBodies: true
}
```

#### `saveNetwork(input: OpensteerNetworkSaveOptions): Promise<OpensteerNetworkSaveResult>`

Saves filtered network traffic to persistent storage (SQLite).

```typescript
await opensteer.saveNetwork({ tag: "api-calls", hostname: "api.example.com" });
```

#### `clearNetwork(input?: OpensteerNetworkClearOptions): Promise<OpensteerNetworkClearResult>`

Clears network records.

```typescript
await opensteer.clearNetwork();            // Clear all
await opensteer.clearNetwork({ tag: "old" }); // Clear by tag
```

---

### Request Plans

#### `inferRequestPlan(input: OpensteerInferRequestPlanInput): Promise<RequestPlanRecord>`

Promotes a captured network record to a reusable request plan.

```typescript
const plan = await opensteer.inferRequestPlan({
  recordId: "rec_abc123",   // From queryNetwork result
  key: "search-api",
  version: "1.0",
  lifecycle: "active",      // Optional: "draft" | "active" | "deprecated"
});
```

#### `writeRequestPlan(input: OpensteerWriteRequestPlanInput): Promise<RequestPlanRecord>`

Writes a request plan manually.

```typescript
const plan = await opensteer.writeRequestPlan({
  key: "my-api",
  version: "1.0",
  payload: {
    method: "POST",
    url: "https://api.example.com/search",
    headers: [{ name: "Content-Type", value: "application/json" }],
    body: { json: { query: "{{q}}" } },
  },
});
```

#### `getRequestPlan(input: { key: string; version?: string }): Promise<RequestPlanRecord>`

Retrieves a stored request plan.

```typescript
const plan = await opensteer.getRequestPlan({ key: "search-api" });
const plan = await opensteer.getRequestPlan({ key: "search-api", version: "1.0" });
```

#### `listRequestPlans(input?: { key?: string }): Promise<OpensteerListRequestPlansOutput>`

Lists available request plans.

```typescript
const plans = await opensteer.listRequestPlans();
const plans = await opensteer.listRequestPlans({ key: "search-api" });
```

---

### Request Execution

#### `request(key: string, input?: OpensteerRequestOptions): Promise<OpensteerRequestResult>`

Executes a stored request plan with parameter substitution.

```typescript
const result = await opensteer.request("search-api", {
  query: { q: "airpods" },
  headers: { Authorization: "Bearer token" },
});

// result.response — HTTP response
// result.data — parsed response body (if JSON)
```

**Options:**
```typescript
interface OpensteerRequestOptions {
  version?: string;
  params?: Record<string, string>;   // URL path parameters
  query?: Record<string, string>;    // Query string parameters
  headers?: Record<string, string>;  // Request headers
  body?: unknown;                    // Override request body
  validateResponse?: boolean;        // Validate response (default: true)
}
```

#### `rawRequest(input: OpensteerRawRequestOptions): Promise<OpensteerRawRequestResult>`

Executes a raw HTTP request through the browser's network context.

```typescript
const result = await opensteer.rawRequest({
  url: "https://api.example.com/data",
  method: "POST",
  headers: [{ name: "Content-Type", value: "application/json" }],
  body: { json: { key: "value" } },
  followRedirects: true,
});
```

---

### Computer Use

#### `computerExecute(input: OpensteerComputerExecuteInput): Promise<OpensteerComputerExecuteResult>`

Executes pixel-space actions for vision-model integration.

```typescript
const result = await opensteer.computerExecute({
  action: { type: "click", x: 100, y: 200 },
  networkTag: "click-action",
});
// result.screenshot — post-action screenshot with path and payload
```

---

## Environment Variables

| Variable | Description |
|:---------|:-----------|
| `OPENSTEER_ENGINE` | Default engine: `playwright` or `abp` |
| `OPENSTEER_MODE` | Execution mode: `local`, `connect`, or `cloud` |
| `OPENSTEER_CONNECT_URL` | Remote service URL for connect mode |
| `OPENSTEER_API_KEY` | Cloud API key |
| `OPENSTEER_BASE_URL` | Cloud base URL |

## Storage

Opensteer stores data in `.opensteer/` relative to `rootDir`:

```
.opensteer/
├── artifacts/          # Snapshots, screenshots
├── traces/             # Operation logs
├── registry/
│   ├── descriptors/    # Persisted element descriptors
│   ├── request-plans/  # Stored request plans
│   └── saved-network.sqlite  # Saved network traffic
└── runtime/
    └── sessions/       # Active session metadata
```
