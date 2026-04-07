# Opensteer Agent Tooling Redesign

This document captures everything discussed in the design review: root cause
analysis of agent failure, CLI output filtering, architecture changes, and the
new SDK replay model.

---

## Table of Contents

1. [Root Cause Analysis](#1-root-cause-analysis)
2. [CLI Discoverability Fixes](#2-cli-discoverability-fixes)
3. [CLI Output Filtering](#3-cli-output-filtering)
4. [Architecture Change: Discovery vs Codification](#4-architecture-change-discovery-vs-codification)
5. [CLI Tools for Discovery](#5-cli-tools-for-discovery)
6. [SDK Replay Model: session.fetch](#6-sdk-replay-model-sessionfetch)
7. [Skill and Documentation Updates](#7-skill-and-documentation-updates)
8. [Edge Cases](#8-edge-cases)

---

## 1. Root Cause Analysis

An AI agent was tasked with reverse-engineering Target.com's search API using
Opensteer. Instead of using Opensteer's network capture and query tools, the
agent abandoned the framework entirely, connected directly to the browser via
raw Playwright scripts, and built a manual Node.js proxy.

### The failure chain

```
Agent reads --help
  → No network operations listed
  → Agent concludes Opensteer is DOM-only
  → Agent runs `browser status`
  → Output leaks WebSocket endpoint (ws://127.0.0.1:...)
  → Agent connects directly via Playwright
  → Agent writes manual network interception scripts
  → Agent builds a Node.js proxy server
  → Opensteer's entire capture/query pipeline was never used
```

### Root causes

**1. Undiscoverable network operations.** `opensteer --help` and `opensteer run
--help` both print the same generic help text. Neither lists network-related
operations (`network query`, `captureNetwork`, `replay`). The agent ran both
and correctly concluded the tool had no network capabilities.

Current help output (`bin.ts:1002-1051`) lists only DOM commands, browser
lifecycle, and a generic `opensteer run <semantic-operation>` without listing
what operations exist.

**2. Leaked WebSocket endpoint.** `opensteer browser status` returns the raw
browser WebSocket URL (`ws://127.0.0.1:56247/devtools/browser/...`). The agent
used this as an escape hatch to connect directly via Playwright, bypassing all
Opensteer abstractions.

**3. Skill documentation relies on external references.** The main `SKILL.md`
says "Load [Request Plan Pipeline](references/request-workflow.md)" for API
tasks. The agent either didn't load this reference or didn't follow the link.
The critical information about `captureNetwork` and `network query` exists only
in the referenced files, not in the main skill.

**4. Verbose, misdirecting snapshot output.** `opensteer snapshot` returned
~20,000 lines of DOM JSON, consuming context and reinforcing the agent's
incorrect belief that Opensteer is a DOM-only tool.

**5. Generic JSON dump for all CLI output.** Every `opensteer run` command
outputs `JSON.stringify(result, null, 2)` (`bin.ts:211`), dumping the full
internal return object. For network operations this includes 25+ fields per
record, base64 body blobs (250K+ characters each), timing data, transfer stats,
and internal refs.

---

## 2. CLI Discoverability Fixes

### 2a. Exhaustive `--help` output

The `--help` output must list every available operation, organized by category.
This is the agent's primary discovery mechanism.

**New `--help`:**

```
Opensteer v2 CLI

Browser lifecycle:
  opensteer open <url> --workspace <id> [--browser persistent|temporary|attach]
  opensteer close --workspace <id>
  opensteer status [--workspace <id>] [--json]
  opensteer browser status --workspace <id>
  opensteer browser clone --workspace <id> --source-user-data-dir <path>
  opensteer browser reset --workspace <id>
  opensteer browser delete --workspace <id>

Navigation:
  opensteer goto <url> --workspace <id> [--capture-network <label>]

DOM inspection:
  opensteer snapshot [action|extraction] --workspace <id>

DOM interaction (all support --capture-network <label>):
  opensteer click --workspace <id> (--element <n> | --selector <css> | --description <text>)
  opensteer input --workspace <id> --text <value> (--element <n> | ...)
  opensteer extract --workspace <id> --description <text> [--schema-json <json>]

Network inspection:
  opensteer network query --workspace <id> [--json] [--url <pattern>] [--capture <label>] [filters...]
  opensteer network detail <recordId> --workspace <id>

Replay:
  opensteer replay <recordId> --workspace <id> [--query key=value ...] [overrides...]

Browser state:
  opensteer cookies --workspace <id> [--domain <domain>]
  opensteer storage --workspace <id> [--domain <domain>]
  opensteer state --workspace <id> [--domain <domain>]

Advanced (semantic operations):
  opensteer run <operation> --workspace <id> --input-json <json>
```

### 2b. Remove WebSocket endpoint from `browser status`

**Current output:**
```json
{
  "mode": "persistent",
  "engine": "playwright",
  "workspace": "target-search",
  "rootPath": "/Users/.../.opensteer",
  "live": true,
  "browserPath": "/Applications/Google Chrome.app/...",
  "userDataDir": "/Users/.../.opensteer/workspaces/target-search/...",
  "endpoint": "ws://127.0.0.1:56247/devtools/browser/801c5ce1-...",
  "baseUrl": "http://127.0.0.1:56247",
  "manifest": { "..." }
}
```

**New output:**
```json
{
  "mode": "persistent",
  "workspace": "target-search",
  "engine": "playwright",
  "live": true
}
```

Drop: `endpoint`, `baseUrl`, `browserPath`, `userDataDir`, `rootPath`,
`manifest`.

---

## 3. CLI Output Filtering

### Design principle

Only include what the agent needs to make its next decision. Strip internal
bookkeeping, duplicated data, and raw blobs. Same philosophy as HTML snapshot
filtering.

All `opensteer run` output currently goes through a single generic path
(`bin.ts:211`):

```typescript
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
```

This must be replaced with operation-aware formatters.

### 3a. `session.open` / `page.goto`

**No changes needed.** Output is already clean:
```json
{
  "sessionRef": "session:abc123",
  "pageRef": "page:def456",
  "url": "https://www.target.com/s/laptop",
  "title": "laptop : Target"
}
```

### 3b. `network query` (biggest win)

**Current:** Each of 20-50 records includes 25+ fields, full header arrays,
base64 body blobs. Total: 2,000-10,000 lines + 250K+ per body blob.

**Drop entirely per record:**

| Field | Reason |
|---|---|
| `record.kind` | Always "http" for standard requests |
| `record.requestId` | Internal CDP identifier |
| `record.sessionRef` | Agent already knows |
| `record.pageRef` | Agent already knows |
| `record.frameRef` | Internal tracking |
| `record.documentRef` | Internal tracking |
| `record.navigationRequest` | Irrelevant for API discovery |
| `record.redirectFromRequestId` | Internal CDP ref |
| `record.redirectToRequestId` | Internal CDP ref |
| `record.initiator` | Script URL/line -- not useful |
| `record.timing` | Performance profiling |
| `record.transfer` | Byte-level stats |
| `record.source` | Protocol/IP/cache metadata |
| `record.captureState` | Internal bookkeeping |
| `record.requestBodyState` | Internal bookkeeping |
| `record.responseBodyState` | Internal bookkeeping |
| `record.*SkipReason` | Internal bookkeeping |
| `record.*Error` | Internal bookkeeping |
| `record.requestBody` | Base64 blob |
| `record.responseBody` | Base64 blob |
| `record.requestHeaders` | Full array, extract content-type only |
| `record.responseHeaders` | Full array, extract content-type only |
| `record.statusText` | Status code is enough |
| `tags` | Rarely populated |
| `savedAt` | Timestamp bookkeeping |

**New output (plain text, scannable):**

```
[network.query] 23 records from capture "laptop-search"

rec:abc123  GET 200  fetch  https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?keyword=laptop&count=24&...
  response: 189,432 bytes (application/json)

rec:def456  GET 200  image  https://target.scene7.com/is/image/Target/GUEST_abc123
  response: 45,231 bytes (image/jpeg)

rec:ghi789  POST 200  fetch  https://assets.targetimg1.com/ssx/api/events
  request: 1,234 bytes (application/json)
  response: 89 bytes (application/json)

rec:jkl012  GET 200  script  https://target.com/_next/static/chunks/webpack-abc123.js
  response: 234,567 bytes (application/javascript)

... (19 more)
```

Per record: 2-3 lines instead of 100+. Agent gets: `recordId`, method, status,
resource type, URL, body size + MIME.

For GraphQL requests (POST to a `/graphql` endpoint), append the operation name:

```
rec:mno345  POST 200  fetch  https://api.example.com/graphql  [query: SearchProducts]
  request: 234 bytes (application/json)
  response: 12,456 bytes (application/json)
```

For WebSocket connections:

```
rec:pqr678  WS 101  websocket  wss://stream.example.com/live
  subprotocol: graphql-transport-ws
```

For Server-Sent Events:

```
rec:stu901  GET 200  event-stream  https://api.example.com/events/stream
  response: streaming (text/event-stream)
```

CORS preflight (`OPTIONS`) requests are filtered out by default.

### 3c. `network detail`

Deep-dive into a single captured request.

**Output:**

```
[network.detail] rec:abc123

GET 200 https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?keyword=laptop&count=24&...

Request headers:
  accept: application/json
  accept-encoding: gzip, deflate, br
  accept-language: en-US,en;q=0.9
  cookie: visitorId=019D66B8ECA2...; TealeafAkaSid=...
  user-agent: Mozilla/5.0 ...

Response headers:
  content-type: application/json
  content-length: 189432
  set-cookie: (none)

Cookies sent:
  visitorId: 019D66B8ECA20200B47204FAD9B3D1C6
  TealeafAkaSid: xHkF2a9...

Response body (189,432 bytes, application/json, truncated):
{
  "data": {
    "search": {
      "search_response": {
        "items": ["... 24 items, first 2 shown",
          { "tcin": "12345678", "item": { "... 6 keys" }, "price": { "current_retail": 499.99 } },
          { "tcin": "87654321", "item": { "... 6 keys" }, "price": { "current_retail": 349.99 } }
        ],
        "typed_metadata": { "total": 1200, "offset": 0, "count": 24 }
      }
    }
  }
}
```

For a GraphQL request, additionally show:

```
GraphQL: query SearchProducts
Variables:
  keyword: "laptop"
  count: 24
  offset: 0
```

For a redirect chain, show the full hop sequence:

```
Redirect chain (3 hops):
  1. GET 302 https://api.example.com/data  →  Location: https://auth.example.com/login?return=...
  2. GET 302 https://auth.example.com/login?return=...  →  Location: https://api.example.com/callback?code=...
  3. GET 200 https://api.example.com/callback?code=abc123
     set-cookie: session=eyJhbGci...
```

For a POST request with a JSON body, show the request body too (truncated):

```
Request body (1,234 bytes, application/json, truncated):
{
  "query": "...",
  "variables": { "keyword": "laptop", "count": 24 }
}
```

Design choices:
- Headers as `name: value` text, not JSON arrays
- Cookies extracted from the `Cookie` header and shown separately
- Request body shown for POST/PUT/PATCH only (omitted for GET/DELETE/HEAD)
- Response body parsed and truncated
- No base64 blobs ever
- GraphQL operation name + variables surfaced
- Redirect chains shown when present

### 3d. `replay`

Replays a captured record, with automatic transport selection (tries direct-http
first, falls back through matched-tls, context-http, page-http until one works).

**Output:**

```
[replay] rec:abc123 → 200 (direct-http, 45ms)

content-type: application/json
body: 189,432 bytes

{
  "data": {
    "search": {
      "search_response": {
        "items": ["... 24 items, first 2 shown",
          { "tcin": "12345678", "item": { "... 6 keys" }, "price": { "current_retail": 499.99 } },
          { "tcin": "87654321", "item": { "... 6 keys" }, "price": { "current_retail": 349.99 } }
        ]
      }
    }
  }
}
```

The agent sees: it worked, which transport was used (so it knows what to set in
`session.fetch` if needed), and the truncated response shape. If direct-http
failed and matched-tls was used, the output says so:

```
[replay] rec:xyz789 → 200 (matched-tls, 62ms)
  note: direct-http returned 403, fell back to matched-tls
```

The agent now knows this API requires TLS fingerprint matching and can set
`transport: "matched-tls"` in its `session.fetch` code.

If all transports fail:

```
[replay] rec:xyz789 → FAILED
  direct-http: 403 (challenge page)
  matched-tls: 403 (challenge page)
  context-http: timeout
  page-http: 403 (bot detection)
```

The agent sees exactly what failed and why, and can pivot (e.g., use DOM
interaction instead of direct API calls, or check for missing cookies/tokens).

### 3e. Data truncation strategy

For any operation that returns parsed response data, truncate deterministically:

1. **Strings** > 200 chars: truncate with `"...{N} chars total"`
2. **Arrays** > 3 items: show first 2 + count: `["... {N} items, first 2 shown", item1, item2]`
3. **Objects** beyond depth 4: replace with `"... {N} keys"`
4. **Total cap**: if serialized `data` > 4KB after truncation, hard-truncate
   with a pointer to `network detail <recordId>` for full content

---

## 4. Architecture Change: Discovery vs Codification

### Current architecture

The current pipeline treats discovery and codification as one continuous flow:

```
Capture → Discover → Probe → Infer Plan → Validate Auth →
Annotate Parameters → Test Plan → Auth Recipe → Done
```

The deliverable is a persisted request plan in a SQLite registry with transport
config, URL template, parameter annotations, auth strategy, recipe bindings,
retry policies, and freshness metadata. The agent must learn this entire schema.

### Problem

Plans, recipes, and the registry are a custom abstraction layer on top of
something agents already understand (HTTP). The agent has to learn
`OpensteerRequestPlanPayload`, `TransportKind`, `OpensteerRequestPlanParameter`,
`OpensteerRecipeStep` subtypes, and registry key/version semantics. Meanwhile,
the agent already knows `fetch`, URLs, headers, cookies, and JSON.

Real-world API chains involve messy, conditional logic ("this endpoint returns a
403, check what cookies are needed, trace back to the token endpoint, which
needs a CSRF token from the HTML page..."). This kind of reasoning is what
agents are good at. A rigid plan/recipe pipeline can't easily represent it.

### New architecture: separate discovery from codification

**Discovery (CLI):** The agent uses inspection tools to understand the API. It
calls `network query`, `network detail`, `replay`, `cookies`, and `storage`
recursively until it understands the full request chain. The agent does the
reasoning -- comparing URLs, understanding parameters, tracing auth
dependencies. We provide clean, filtered views into the captured traffic.

**Codification (SDK):** The agent writes plain TypeScript functions using
`session.fetch`. The code IS the artifact.

### Design philosophy: don't build tools for things the agent is already good at

- **Text comparison**: agents are LLMs, comparing two URLs or header sets is
  trivial. No need for a `diff` tool.
- **Parameter reasoning**: agents can look at param names like `utm_source` or
  `analytics_id` and know they're optional. No need for a `minimize` tool.
- **Transport selection**: `replay` and `session.fetch` handle this
  automatically. No need for a `probe` tool.

We only provide tools for things the agent CAN'T do on its own: inspect browser
network traffic, read browser cookies/storage, make requests with browser-grade
transports.

### What to remove

| Tool | Reason |
|---|---|
| `request-plan.infer` | Custom schema agents don't need |
| `request-plan.get` | Registry read, no longer needed |
| `request-plan.write` | Registry write, no longer needed |
| `request.execute` | Plan-based execution, no longer needed |
| `request.raw` | Replaced by `replay` (simpler: takes a recordId) |
| `auth-recipe.write` | Recipe DSL replaced by plain code |
| `auth-recipe.run` | Recipe execution replaced by plain code |
| `auth-recipe.get` | Registry read, no longer needed |
| `listRequestPlans` | Registry list, no longer needed |
| `listRecipes` | Registry list, no longer needed |
| `listAuthRecipes` | Registry list, no longer needed |
| `network.diff` | Agent can compare two `network detail` outputs |
| `network.minimize` | Agent can reason about params by name, or use all of them |
| `network.probe` | `replay` handles transport selection automatically |

### New discovery flow

```
Agent captures network traffic (goto/click/input with captureNetwork)
  ↓
Agent calls `network query` to scan traffic
  ↓
Agent picks a candidate, calls `network detail <recordId>`
  ↓
Agent calls `replay <recordId>` to test it (transport auto-selected)
  ↓
If it works → agent writes code with session.fetch
  ↓
If it fails (403/401):
  Agent calls `network query --before <recordId>` to find auth/token requests
  Agent calls `cookies --domain <domain>` to check browser cookies
  Agent calls `storage --domain <domain>` to check tokens in localStorage
  Agent traces the dependency chain recursively
  ↓
Agent writes TypeScript code using session.fetch
```

The agent drives the exploration. It compares, reasons, and decides. We give it
clean views of the data and tools to replay requests.

---

## 5. CLI Tools for Discovery

### 5a. `network query`

Scan captured traffic with flexible filters.

| Flag | Purpose |
|---|---|
| `--capture <label>` | Filter by capture label |
| `--url <substring>` | Filter by URL substring (`--url "search"` finds any request with "search" in the URL) |
| `--hostname <host>` | Filter by hostname (`--hostname "redsky.target.com"`) |
| `--path <pattern>` | Filter by URL path |
| `--method GET\|POST\|...` | Filter by HTTP method |
| `--status <code>` | Filter by HTTP status code |
| `--type fetch\|xhr\|websocket\|event-stream\|...` | Filter by resource type |
| `--json` | Only show JSON API calls (shorthand for `--type fetch` + JSON content-type) |
| `--before <recordId>` | Records captured before this one (by time) -- for dependency tracing |
| `--after <recordId>` | Records captured after this one (by time) |
| `--limit <n>` | Max records to return (default: 50) |

Output is always chronological (oldest first), matching the actual request
sequence. Most flags already exist in `OpensteerNetworkQueryInput` (`url`,
`hostname`, `path`, `method`, `status`, `resourceType`, `capture`, `limit`).
New additions: `--before`/`--after` for dependency tracing, `--json` as a
convenience shorthand, and CORS preflight filtering by default.

### 5b. `network detail <recordId>`

Deep inspection of a single captured record. See Section 3c for output format.
Shows all headers as text, extracts cookies separately, parses and truncates
the response body. Surfaces GraphQL operation/variables and redirect chains.

### 5c. `replay <recordId>`

Replays a captured request with automatic transport fallback. See Section 3d
for output format.

```bash
opensteer replay <recordId> --workspace target-search
opensteer replay <recordId> --workspace target-search --query keyword=headphones --query count=10
opensteer replay <recordId> --workspace target-search --header "Authorization=Bearer xyz"
opensteer replay <recordId> --workspace target-search --body-json '{"keyword":"headphones"}'
opensteer replay <recordId> --workspace target-search --variables '{"keyword":"headphones"}'  # GraphQL
```

Takes a captured record, replays it exactly as captured (same URL, headers,
cookies, body). Automatically tries transports in order: direct-http →
matched-tls → context-http → page-http. Reports which transport worked.

**Overrides (optional):**

| Flag | Purpose |
|---|---|
| `--query key=value` | Override or add a query parameter (repeatable) |
| `--header key=value` | Override or add a header (repeatable) |
| `--body-json <json>` | Replace the request body (for POST/PUT) |
| `--variables <json>` | Override GraphQL variables (merges with existing) |

The agent can test variations without constructing a request from scratch.

For the SDK:

```typescript
const result = await opensteer.network.replay("rec:abc123", {
  query: { keyword: "headphones" },
  headers: { "x-custom": "value" },
});
```

### 5d. `cookies [--domain <domain>]`

Extract cookies from the browser session.

**Output:**

```
[cookies] 12 cookies for .target.com

visitorId          019D66B8ECA20200B47204FAD9B3D1C6          expires: 2026-04-14
TealeafAkaSid      xHkF2a9QpN...                             session
accessToken        eyJhbGciOiJSUzI1NiIs...                   expires: 2026-04-07T15:30:00Z  httpOnly
sapphire           s%3Aabc123.sig                             session  httpOnly
```

### 5e. `storage [--domain <domain>]`

Extract localStorage and sessionStorage.

**Output:**

```
[storage] localStorage for target.com (8 keys)

fiatToken         eyJhbGciOiJSUzI1NiIs... (2,340 chars)
guestCartId       abc-123-def-456
storeId           3233

[storage] sessionStorage for target.com (3 keys)

searchHistory     ["laptop","headphones"]
recentStore       3233
```

### 5f. `state [--domain <domain>]`

Full browser state snapshot in one command. Combines cookies, storage, and
hidden form fields. The `OpensteerStateSnapshot` type already captures all of
this.

**Output:**

```
[state] target.com

Cookies (12):
  visitorId   019D66B8ECA2...    expires: 2026-04-14
  csrfToken   a8f3c2d1...        session

Hidden fields (2):
  form#search > input[name="authenticity_token"]  = "abc123..."
  form#cart > input[name="_csrf"]  = "def456..."

localStorage (8 keys):
  fiatToken = "eyJhbGci..." (2,340 chars)
  storeId = "3233"

sessionStorage (3 keys):
  searchHistory = ["laptop","headphones"]
```

Useful when the agent needs to understand what browser-side state exists for
constructing API calls (CSRF tokens, session IDs, stored auth tokens).

---

## 6. SDK Replay Model: `session.fetch`

### Design principle

After the agent understands the API chain through CLI discovery, it writes plain
TypeScript functions. The SDK provides one key addition: `session.fetch` -- a
session-aware fetch that carries browser cookies and auto-selects the right
transport. Everything else is standard TypeScript.

### The SDK surface

```typescript
interface OpensteerSession {
  // Browser actions (unchanged)
  goto(url: string, opts?: { captureNetwork?: string }): Promise<SessionState>;
  dom: {
    click(input: DomClickInput): Promise<ActionResult>;
    input(input: DomInputInput): Promise<ActionResult>;
    hover(input: DomHoverInput): Promise<ActionResult>;
    scroll(input: DomScrollInput): Promise<ActionResult>;
  };
  extract(input: ExtractInput): Promise<unknown>;
  snapshot(mode?: "action" | "extraction"): Promise<string>;

  // Network inspection
  network: {
    query(filter?: NetworkFilter): Promise<NetworkSummary[]>;
    detail(recordId: string): Promise<NetworkDetail>;
    replay(recordId: string, overrides?: ReplayOverrides): Promise<ReplayResult>;
  };

  // Browser state
  cookies(domain?: string): Promise<CookieJar>;
  storage(domain?: string, type?: "local" | "session"): Promise<StorageMap>;
  state(domain?: string): Promise<BrowserState>;

  // Session-aware fetch (the key addition)
  fetch(url: string, opts?: SessionFetchOptions): Promise<Response>;

  // Lifecycle (unchanged)
  close(): Promise<void>;
  disconnect(): Promise<void>;
}

interface SessionFetchOptions {
  method?: string;
  query?: Record<string, string | number | boolean>;
  headers?: Record<string, string>;
  body?: unknown;
  transport?: "direct" | "matched-tls" | "page"; // default: auto (tries in order)
  cookies?: boolean; // default true -- include browser session cookies
}

interface CookieJar {
  has(name: string): boolean;
  get(name: string): string | undefined;
  getAll(): Cookie[];
  serialize(): string;
}
```

`session.fetch` transport defaults to `"auto"`: tries direct-http first, falls
back through matched-tls and page-http. The agent only needs to set `transport`
explicitly if it wants to force a specific one (e.g., it learned from `replay`
output that matched-tls is needed).

### Example: Target search API

```typescript
import { Opensteer } from "opensteer";

const opensteer = new Opensteer({ workspace: "target", rootDir: process.cwd() });

async function ensureTargetSession(session: typeof opensteer) {
  const cookies = await session.cookies(".target.com");
  if (cookies.has("visitorId")) return;
  await session.open("https://target.com");
  await session.goto("https://target.com");
}

export async function searchTarget(keyword: string, count = 24) {
  await ensureTargetSession(opensteer);

  const res = await opensteer.fetch(
    "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2",
    {
      query: {
        keyword,
        count,
        offset: 0,
        key: "9f36aeafbe60771e321a7cc95a78140772ab3e96",
        channel: "WEB",
        platform: "desktop",
        default_purchasability_filter: true,
      },
    },
  );

  return res.json();
}
```

### Example: chaining dependent APIs

```typescript
export async function getTargetProductDetails(keyword: string) {
  const search = await searchTarget(keyword);
  const firstItem = search.data.search.search_response.items[0];

  const details = await getProductById(firstItem.tcin);
  const reviews = await getProductReviews(firstItem.tcin);

  return { product: details, reviews };
}

async function getProductById(tcin: string) {
  await ensureTargetSession(opensteer);
  const res = await opensteer.fetch(
    "https://redsky.target.com/redsky_aggregations/v1/web/pdp_client_v1",
    { query: { tcin, key: "9f36...", channel: "WEB" } },
  );
  return res.json();
}
```

### Example: auth with browser login

```typescript
async function loginToSite(session: typeof opensteer) {
  await session.goto("https://example.com/login");
  await session.dom.input({
    target: { kind: "description", description: "email input" },
    text: process.env.EXAMPLE_EMAIL!,
  });
  await session.dom.input({
    target: { kind: "description", description: "password input" },
    text: process.env.EXAMPLE_PASSWORD!,
  });
  await session.dom.click({
    target: { kind: "description", description: "sign in button" },
  });
}

async function fetchProtectedData() {
  const cookies = await opensteer.cookies("example.com");
  if (!cookies.get("auth_token")) {
    await loginToSite(opensteer);
  }

  let res = await opensteer.fetch("https://api.example.com/data");

  if (res.status === 401) {
    await loginToSite(opensteer);
    res = await opensteer.fetch("https://api.example.com/data");
  }

  return res.json();
}
```

### Persistence

The code file IS the persistence. The agent writes `target-search.ts` with
exported functions. No separate registry.

---

## 7. Skill and Documentation Updates

### 7a. SKILL.md

**Current Gate 1:**
> Is the deliverable a replayable request plan?
> YES → Load [Request Plan Pipeline](references/request-workflow.md).

**New Gate 1:**
> Is the task about understanding, reverse-engineering, or calling an API?
> YES → Use network discovery tools below. Then write TypeScript with
> `session.fetch` for the replay code.

The deliverable is no longer "a persisted request plan." It's "working code that
calls the API."

The main skill file must include enough info for common tasks without requiring
external reference loading:

- All network-related CLI commands with one-line descriptions
- The `captureNetwork` parameter and which operations support it
  (`goto`, `click`, `input`, `hover`, `scroll`)
- The discovery flow: `network query` → `network detail` → `replay`
- Key `network query` filters: `--json` (API calls only), `--url`,
  `--before`/`--after` (dependency tracing), `--capture`
- `cookies`, `storage`, `state` for browser state inspection
- `session.fetch` as the replay mechanism (transport auto-selected)

### 7b. request-workflow.md

Replace the nine-phase pipeline with:

1. **Capture** -- navigate/interact with `captureNetwork`
2. **Discover** -- `network query` to find API calls
3. **Inspect** -- `network detail` for headers, cookies, response
4. **Test** -- `replay` to see if it works (transport auto-handled)
5. **Trace dependencies** -- `network query --before`, `cookies`, `storage`
6. **Write code** -- TypeScript functions with `session.fetch`

### 7c. sdk-reference.md

Add `session.fetch`, `cookies`, `storage`, `state`, and `network.replay`.
Remove all plan/recipe sections.

### 7d. cli-reference.md

Add documentation for: `network query` (with all filter flags), `network
detail`, `replay` (with override flags), `cookies`, `storage`, `state`. Remove
all plan/recipe/probe/diff/minimize commands.

---

## 8. Edge Cases

### 8a. WebSocket APIs

Many modern apps use WebSocket for real-time data (chat, live prices, GraphQL
subscriptions). The protocol already supports `websocket` as a
`NetworkRecordKind` and captures open/frame/close events.

**What's needed:**
- `network query` shows WebSocket connections in the summary (Section 3b)
- `network detail` for a WebSocket record shows the connection URL,
  subprotocol, and a sample of recent frames (sent + received)
- The SDK needs `session.websocket(url, opts)` for code that needs to connect
  to a WebSocket using the browser's cookies and TLS context

```typescript
const ws = await opensteer.websocket("wss://stream.example.com/live", {
  subprotocol: "graphql-transport-ws",
});
ws.send(JSON.stringify({ type: "subscribe", payload: { query: "..." } }));
ws.on("message", (data) => console.log(data));
```

### 8b. Server-Sent Events (SSE)

Streaming APIs for real-time updates. Common in AI apps (streaming LLM
responses). The protocol already supports `event-stream` as a record kind.

**What's needed:**
- `network detail` for an SSE record shows the URL and a sample of recent
  events (event name + data preview)
- The SDK needs `session.stream(url, opts)` returning an async iterator

```typescript
const stream = await opensteer.stream("https://api.example.com/events", {
  query: { channel: "prices" },
});
for await (const event of stream) {
  console.log(event.name, event.data);
}
```

### 8c. GraphQL APIs

Single endpoint (`POST /graphql`), different operations via the query body. The
codebase already detects GraphQL and persisted queries internally.

**What's needed:**
- `network query` shows the GraphQL operation name alongside the URL
- `network detail` for a GraphQL request shows operation name, type
  (query/mutation/subscription), variables, whether it's a persisted query
  (hash-based), and truncated response data
- `replay` for a GraphQL record should allow overriding variables:
  `opensteer replay <recordId> --variables '{"keyword":"headphones"}'`

### 8d. Redirect chains

Some auth flows involve multi-step redirects: API → 302 → login → 302 →
callback → 302 → original API with token cookie set.

**What's needed:**
- `network detail` shows the full redirect chain when a record has redirect
  references (Section 3c)

### 8e. CORS preflight filtering

Browsers send `OPTIONS` preflight requests before cross-origin API calls.

**What's needed:**
- `network query` filters out `OPTIONS` preflight requests by default

### 8f. Request signing and dynamic tokens

Some APIs require per-request HMAC signatures, timestamps, or nonces. These
change on every request and can't be replayed from a captured record.

The agent handles this in code. It captures two instances of the same API call,
runs `network detail` on each, and compares the headers/params side by side to
see which fields are dynamic. Then it finds the signing logic in the page's
JavaScript (via `evaluate` or reading the source) and replicates it:

```typescript
const timestamp = Math.floor(Date.now() / 1000);
const nonce = crypto.randomUUID();
const signature = computeHmac(secret, `${timestamp}:${nonce}:${path}`);

const res = await opensteer.fetch(url, {
  headers: { "x-timestamp": String(timestamp), "x-nonce": nonce, "x-sig": signature },
});
```

### 8g. Anti-bot protections

Cloudflare challenges, Akamai Bot Manager, PerimeterX, DataDome.

**How it surfaces:**
- `replay` will try direct-http first and get a 403 with a challenge page,
  then fall back to matched-tls or page-http. The output tells the agent which
  transport worked.
- `network detail` should detect common challenge patterns and flag them:
  `"Note: Response appears to be a Cloudflare challenge page"`

For the SDK, `session.fetch` with auto transport handles this transparently.

### 8h. Hidden form fields and JS-injected tokens

Some APIs require values from hidden form fields (`<input type="hidden">`) or
JavaScript-injected tokens (CSRF nonces, window variables).

**What's needed:**
- The `state` command captures hidden fields and JS globals alongside cookies
  and storage (Section 5f)
- The agent reads the CSRF token from `state` and includes it in
  `session.fetch` headers

---

## Summary

| Area | Current | New |
|---|---|---|
| **CLI help** | Lists 10 commands, no network ops | Lists all operations by category |
| **CLI output** | Generic `JSON.stringify` dump | Operation-aware filtered formatters |
| **`network query` output** | 100+ lines per record | 2-3 lines per record |
| **`browser status`** | Leaks WebSocket endpoint | Mode + workspace + live only |
| **Discovery flow** | 9-phase plan pipeline | Agent-driven: query → detail → replay |
| **Network filtering** | Generic JSON query | Rich CLI flags: `--json`, `--url`, `--before/after`, `--limit` |
| **Transport selection** | Manual per-transport probing | Auto (replay + session.fetch try in order) |
| **Replay mechanism** | Plan registry + recipe DSL | `session.fetch` + plain TypeScript |
| **Chaining** | Inter-plan recipe bindings | Function composition |
| **Auth handling** | Auth recipe JSON steps | TypeScript functions with DOM actions |
| **Persistence** | SQLite plan registry | Code files with exported functions |
| **Skill docs** | Relies on external references | Key info inline |
| **WebSocket/SSE** | Captured but not exposed | Visible in query + detail, SDK methods |
| **GraphQL** | Detected internally | Operation name in query + detail |
| **Browser state** | Not exposed | `cookies`, `storage`, `state` commands |

### CLI tool count

| Category | Tools |
|---|---|
| Network inspection | `network query`, `network detail` |
| Replay | `replay` |
| Browser state | `cookies`, `storage`, `state` |
| DOM (unchanged) | `snapshot`, `click`, `input`, `extract`, `goto` |
| Lifecycle (unchanged) | `open`, `close`, `status`, `browser *` |

Six new tools for API reverse engineering. Each does one thing. The agent
already knows HTTP, so it just needs: see the traffic, look at a request, try
it, check the browser state. Everything else is the agent's reasoning.
