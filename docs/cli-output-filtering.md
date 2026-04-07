# CLI Output Filtering for AI Agents

This document covers every reverse-engineering operation in the Opensteer CLI,
what each currently returns to the agent, and how we should deterministically
filter the output before returning it.

**Core principle:** Only include what the agent needs to make its next decision.
Strip internal bookkeeping, duplicated data, and raw blobs. This is the same
philosophy behind HTML snapshot filtering -- agents don't need every DOM node,
and they don't need every byte of a network response.

---

## Pipeline Overview

```
page.goto / dom.click / dom.input / ... (with captureNetwork)
  |
  v
network.query          -- scan captured traffic, pick the right request
  |
  v
request.raw            -- probe the endpoint with different transports
  |
  v
request-plan.infer     -- generate a replayable plan from a captured record
  |
  v
request-plan.get       -- read back / verify the saved plan
  |
  v
request.execute        -- run the plan with parameter overrides
  |
  v
auth-recipe.write/run  -- (optional) handle auth refresh flows
```

Every step currently uses the same generic output path:
`JSON.stringify(result, null, 2)`, which dumps the full internal return object.

---

## 1. `session.open` / `page.goto` (with `captureNetwork`)

### What it does

Opens a browser or navigates to a URL. When `captureNetwork` is set (a string
label), Opensteer records all network traffic during the action into SQLite.

`captureNetwork` is supported on: `page.goto`, `dom.click`, `dom.hover`,
`dom.input`, `dom.scroll`, and `computer.execute`.

### Current output

```json
{
  "sessionRef": "session:abc123",
  "pageRef": "page:def456",
  "url": "https://www.target.com/s/laptop",
  "title": "laptop : Target"
}
```

### Verdict: No changes needed

4 fields, all useful. The agent needs `url` and `title` to confirm navigation
succeeded. `sessionRef` and `pageRef` are small and occasionally referenced.

---

## 2. `network.query`

### What it does

Queries the SQLite network history. Returns matching records from a previous
capture. The agent uses this to scan traffic and identify which request is the
API call it wants to reverse-engineer.

### Current output (per record)

Each `NetworkQueryRecord` wraps a full `NetworkRecord` with 25+ fields:

```json
{
  "records": [
    {
      "recordId": "rec:abc123",
      "capture": "laptop-search",
      "tags": [],
      "savedAt": 1712500000000,
      "record": {
        "kind": "http",
        "requestId": "F9A3.2",
        "sessionRef": "session:abc123",
        "pageRef": "page:def456",
        "frameRef": "frame:ghi789",
        "documentRef": "document:jkl012",
        "method": "GET",
        "url": "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?keyword=laptop&...",
        "requestHeaders": [ /* 15-20 header entries */ ],
        "responseHeaders": [ /* 15-20 header entries */ ],
        "status": 200,
        "statusText": "OK",
        "resourceType": "fetch",
        "navigationRequest": false,
        "redirectFromRequestId": null,
        "redirectToRequestId": null,
        "initiator": {
          "type": "script",
          "url": "https://target.com/_next/static/chunks/...",
          "lineNumber": 1,
          "columnNumber": 23456
        },
        "timing": {
          "requestStartMs": 0,
          "dnsStartMs": 0, "dnsEndMs": 0,
          "connectStartMs": 0, "connectEndMs": 0,
          "sslStartMs": 0, "sslEndMs": 0,
          "sendStartMs": 0.5, "sendEndMs": 0.8,
          "receiveHeadersStartMs": 150.2,
          "receiveHeadersEndMs": 150.5
        },
        "transfer": {
          "requestHeadersBytes": 1234,
          "responseHeadersBytes": 567,
          "encodedBodyBytes": 45231,
          "decodedBodyBytes": 189432,
          "transferSizeBytes": 46798
        },
        "source": {
          "protocol": "h2",
          "remoteAddress": { "ip": "151.101.1.54", "port": 443 },
          "fromServiceWorker": false,
          "fromDiskCache": false,
          "fromMemoryCache": false
        },
        "captureState": "complete",
        "requestBodyState": "skipped",
        "responseBodyState": "complete",
        "requestBodySkipReason": "GET request",
        "responseBody": {
          "data": "eyJkYXRhIjp7InNlYXJjaCI6ey...",
          "encoding": "base64",
          "mimeType": "application/json",
          "charset": "utf-8",
          "truncated": false,
          "capturedByteLength": 189432,
          "originalByteLength": 189432
        }
      }
    }
  ]
}
```

A typical capture produces 20-50 records. At ~100-200 lines per record, that's
**2,000-10,000 lines** of JSON. If `includeBodies` is true (or bodies are
present by default), a single base64 response body can add 250K+ characters.

### What to filter

**Drop entirely (agent never needs these):**

| Field | Reason |
|---|---|
| `record.kind` | Always "http" |
| `record.requestId` | Internal CDP identifier, agent uses `recordId` |
| `record.sessionRef` | Agent already knows the session |
| `record.pageRef` | Agent already knows the page |
| `record.frameRef` | Internal frame tracking |
| `record.documentRef` | Internal document tracking |
| `record.navigationRequest` | Rarely useful for API discovery |
| `record.redirectFromRequestId` | Internal CDP identifier |
| `record.redirectToRequestId` | Internal CDP identifier |
| `record.initiator` | Script URL/line/column -- not useful for API RE |
| `record.timing` | Performance profiling data, irrelevant |
| `record.transfer` | Byte-level transfer stats, irrelevant |
| `record.source` | Protocol/IP/cache metadata, irrelevant |
| `record.captureState` | Internal capture bookkeeping |
| `record.requestBodyState` | Internal capture bookkeeping |
| `record.responseBodyState` | Internal capture bookkeeping |
| `record.requestBodySkipReason` | Internal capture bookkeeping |
| `record.responseBodySkipReason` | Internal capture bookkeeping |
| `record.requestBodyError` | Internal capture bookkeeping |
| `record.responseBodyError` | Internal capture bookkeeping |
| `record.requestBody` | Base64 blob -- if needed, use a detail command |
| `record.responseBody` | Base64 blob -- if needed, use a detail command |
| `record.requestHeaders` | Full array -- just extract content-type |
| `record.responseHeaders` | Full array -- just extract content-type |
| `record.statusText` | Status code is sufficient |
| `tags` | Rarely populated at discovery phase |
| `savedAt` | Timestamp bookkeeping |

### Proposed output

Plain text, one block per record, scannable:

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

**Per record: 2-3 lines instead of 100+.**

Each line gives the agent exactly what it needs to pick the right record:
- `recordId` (needed for `request.raw` and `request-plan.infer`)
- HTTP method + status
- Resource type (fetch/xhr = likely API, image/script/stylesheet = skip)
- Full URL (shows the endpoint and query params)
- Body size + MIME type (confirms it's JSON data vs a static asset)

If the agent needs full headers or body content for a specific record, it should
use a follow-up command (e.g., `network.query --recordId rec:abc123 --includeBodies`
or a dedicated `network.detail` operation).

---

## 3. `request.raw`

### What it does

Fires a diagnostic HTTP request using a specific transport (direct-http,
matched-tls, context-http, page-http). Used to probe whether an API works
outside the browser context and which transport is needed.

### Current output

```json
{
  "recordId": "rec:xyz789",
  "request": {
    "method": "GET",
    "url": "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2?keyword=laptop&...",
    "headers": [
      { "name": "accept", "value": "*/*" },
      { "name": "accept-encoding", "value": "gzip, deflate, br" },
      { "name": "user-agent", "value": "..." }
    ],
    "body": null
  },
  "response": {
    "url": "https://redsky.target.com/...",
    "status": 200,
    "statusText": "OK",
    "headers": [
      { "name": "content-type", "value": "application/json" },
      { "name": "x-frame-options", "value": "SAMEORIGIN" },
      { "name": "content-length", "value": "189432" }
    ],
    "body": {
      "data": "eyJkYXRhIjp7InNlYXJjaCI6ey4uLn19fQ==...",
      "encoding": "base64",
      "mimeType": "application/json",
      "charset": "utf-8",
      "truncated": false,
      "capturedByteLength": 189432
    },
    "redirected": false
  },
  "data": {
    "data": {
      "search": {
        "search_response": {
          "items": [ /* ... */ ]
        }
      }
    }
  }
}
```

**Key problem:** `response.body.data` (base64 blob, 250K+ characters) and
`data` (parsed JSON) are the **same content in two formats**. The base64 blob
is useless to the agent when the parsed version is right there.

### What to filter

**Drop entirely:**

| Field | Reason |
|---|---|
| `request` (entire object) | Agent knows what it sent |
| `response.url` | Agent knows the URL it requested |
| `response.statusText` | Status code is sufficient |
| `response.headers` | Full array -- just extract content-type |
| `response.body` | Base64 duplicate of `data` |
| `response.redirected` | Rarely useful at probe phase |

**Truncate:**

| Field | Strategy |
|---|---|
| `data` | If the parsed response is large (>2KB serialized), truncate intelligently: show object keys at top level, show array lengths with first 2 items, cap string values at 200 chars. This gives the agent the **shape** of the response without filling the context window. |

### Proposed output

```json
{
  "recordId": "rec:xyz789",
  "status": 200,
  "contentType": "application/json",
  "bodySize": 189432,
  "data": {
    "data": {
      "search": {
        "search_recommendations": {},
        "search_response": {
          "typed_metadata": { "... 3 keys" },
          "items": [ "... 24 items, showing first 2 ...",
            {
              "tcin": "12345678",
              "item": { "... 8 keys" },
              "price": { "current_retail": 499.99 }
            },
            {
              "tcin": "87654321",
              "item": { "... 8 keys" },
              "price": { "current_retail": 349.99 }
            }
          ]
        }
      }
    }
  }
}
```

The agent sees: it worked (200), it's JSON, the response shape has
`data.search.search_response.items[]` with product objects. That's enough to
decide "this is the right endpoint" and move to `request-plan.infer`.

---

## 4. `request-plan.infer`

### What it does

Takes a `recordId` from a captured network record and generates a replayable
request plan. This is the core output artifact -- it describes the API endpoint,
its parameters, transport requirements, and auth strategy.

### Current output

Returns a full `RegistryRecord<OpensteerRequestPlanPayload>`:

```json
{
  "id": "plan:abc123",
  "key": "target.search",
  "version": "v1",
  "createdAt": 1712500000000,
  "updatedAt": 1712500000000,
  "contentHash": "sha256:abcdef1234567890",
  "tags": [],
  "provenance": {
    "source": "network-record",
    "sourceId": "rec:xyz789",
    "capturedAt": 1712499999000,
    "notes": null
  },
  "freshness": null,
  "payload": {
    "transport": {
      "kind": "direct-http",
      "requiresBrowser": false,
      "requireSameOrigin": false,
      "cookieJar": null
    },
    "endpoint": {
      "method": "GET",
      "urlTemplate": "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2",
      "defaultQuery": [
        { "name": "keyword", "value": "laptop" },
        { "name": "count", "value": "24" },
        { "name": "offset", "value": "0" },
        { "name": "key", "value": "9f36aeafbe60771e321a7cc95a78140772ab3e96" },
        { "name": "channel", "value": "WEB" }
      ],
      "defaultHeaders": [
        { "name": "accept", "value": "application/json" }
      ]
    },
    "parameters": null,
    "body": null,
    "response": {
      "status": 200,
      "contentType": "application/json"
    },
    "recipes": null,
    "retryPolicy": null,
    "auth": {
      "strategy": "session-cookie",
      "description": "Cookie-based session detected"
    }
  }
}
```

### What to filter

**Drop entirely (registry bookkeeping):**

| Field | Reason |
|---|---|
| `id` | Internal UUID, agent uses `key`+`version` |
| `createdAt` | Timestamp bookkeeping |
| `updatedAt` | Timestamp bookkeeping |
| `contentHash` | Internal integrity check |
| `tags` | Rarely populated at infer time |
| `provenance` | Agent already knows the source record |
| `freshness` | Null at creation time |

**Flatten (reduce nesting):**

| Current path | Proposed field |
|---|---|
| `payload.transport.kind` | `transport` |
| `payload.transport.requiresBrowser` | `requiresBrowser` |
| `payload.endpoint.method` | `method` |
| `payload.endpoint.urlTemplate` | `urlTemplate` |
| `payload.endpoint.defaultQuery` | `defaultQuery` |
| `payload.endpoint.defaultHeaders` | `defaultHeaders` |
| `payload.parameters` | `parameters` |
| `payload.body` | `body` |
| `payload.auth` | `auth` |
| `payload.response` | `expectedResponse` |

**Drop from payload (null/empty noise):**

| Field | Condition |
|---|---|
| `payload.transport.requireSameOrigin` | Drop if false |
| `payload.transport.cookieJar` | Drop if null |
| `payload.recipes` | Drop if null |
| `payload.retryPolicy` | Drop if null |
| `payload.body` | Drop if null |
| `payload.parameters` | Drop if null |

### Proposed output

```json
{
  "key": "target.search",
  "version": "v1",
  "transport": "direct-http",
  "method": "GET",
  "urlTemplate": "https://redsky.target.com/redsky_aggregations/v1/web/plp_search_v2",
  "defaultQuery": [
    { "name": "keyword", "value": "laptop" },
    { "name": "count", "value": "24" },
    { "name": "offset", "value": "0" },
    { "name": "key", "value": "9f36aeafbe60771e321a7cc95a78140772ab3e96" },
    { "name": "channel", "value": "WEB" }
  ],
  "defaultHeaders": [
    { "name": "accept", "value": "application/json" }
  ],
  "auth": {
    "strategy": "session-cookie",
    "description": "Cookie-based session detected"
  },
  "expectedResponse": {
    "status": 200,
    "contentType": "application/json"
  }
}
```

Everything the agent needs to understand the API and decide next steps
(annotate parameters, validate auth). No bookkeeping noise.

---

## 5. `request-plan.get`

### What it does

Reads a saved plan back from the registry by key+version. The output is the
same `RegistryRecord<OpensteerRequestPlanPayload>` as `request-plan.infer`.

### Proposed filtering

Same as `request-plan.infer` above. Flatten, strip registry metadata.

---

## 6. `request.execute`

### What it does

Runs a saved request plan with optional parameter overrides. This is the final
"does it actually work" validation step.

### Current output

```json
{
  "plan": {
    "id": "plan:abc123",
    "key": "target.search",
    "version": "v1"
  },
  "request": {
    "method": "GET",
    "url": "https://redsky.target.com/...?keyword=headphones&count=10",
    "headers": [ /* full array */ ],
    "body": null
  },
  "response": {
    "url": "https://redsky.target.com/...",
    "status": 200,
    "statusText": "OK",
    "headers": [ /* full array */ ],
    "body": {
      "data": "eyJkYXRhIjp7...",
      "encoding": "base64",
      "mimeType": "application/json",
      "truncated": false,
      "capturedByteLength": 189432
    },
    "redirected": false
  },
  "recovery": null,
  "data": {
    "data": {
      "search": { "..." }
    }
  }
}
```

Same duplication problem as `request.raw`: base64 blob + parsed `data` = same
content twice.

### What to filter

**Drop entirely:**

| Field | Reason |
|---|---|
| `plan.id` | Internal UUID |
| `request` (entire object) | Agent knows what it sent |
| `response.url` | Agent knows the URL |
| `response.statusText` | Status code is sufficient |
| `response.headers` | Full array -- just extract content-type |
| `response.body` | Base64 duplicate of `data` |
| `response.redirected` | Rarely relevant |

**Keep conditionally:**

| Field | Condition |
|---|---|
| `recovery` | Only include if `recovery.attempted === true` |

**Truncate:**

| Field | Strategy |
|---|---|
| `data` | Same truncation strategy as `request.raw` |

### Proposed output

```json
{
  "plan": { "key": "target.search", "version": "v1" },
  "status": 200,
  "contentType": "application/json",
  "bodySize": 189432,
  "data": {
    "data": {
      "search": {
        "search_response": {
          "items": [ "... 24 items, showing first 2 ...",
            { "tcin": "12345678", "item": { "... 8 keys" } },
            { "tcin": "87654321", "item": { "... 8 keys" } }
          ]
        }
      }
    }
  }
}
```

If recovery was triggered:

```json
{
  "plan": { "key": "target.search", "version": "v1" },
  "status": 200,
  "contentType": "application/json",
  "bodySize": 189432,
  "recovery": {
    "attempted": true,
    "succeeded": true,
    "recipe": { "key": "target.auth", "version": "v1" }
  },
  "data": { "..." }
}
```

---

## 7. `browser status`

### Current output

```json
{
  "mode": "persistent",
  "engine": "playwright",
  "workspace": "target-search",
  "rootPath": "/Users/timjang/.opensteer",
  "live": true,
  "browserPath": "/Applications/Google Chrome.app/...",
  "userDataDir": "/Users/timjang/.opensteer/workspaces/target-search/...",
  "endpoint": "ws://127.0.0.1:56247/devtools/browser/801c5ce1-be2a-4c09-9fe3-8bf4d13d3cc0",
  "baseUrl": "http://127.0.0.1:56247",
  "manifest": { "..." }
}
```

### What to filter

**Drop entirely:**

| Field | Reason |
|---|---|
| `endpoint` | **The leaked WebSocket URL.** This is what caused the agent to abandon Opensteer and connect directly via Playwright. Agents should never see this. |
| `baseUrl` | Same -- raw debugging URL |
| `browserPath` | Agent doesn't need to know the executable path |
| `userDataDir` | Internal filesystem detail |
| `rootPath` | Internal filesystem detail |
| `manifest` | Internal state blob |

### Proposed output

```json
{
  "mode": "persistent",
  "workspace": "target-search",
  "engine": "playwright",
  "live": true
}
```

Just: is there a browser running, what workspace, what mode. That's all the
agent needs.

---

## Data Truncation Strategy

For operations that return parsed response data (`request.raw`, `request.execute`),
the `data` field can be arbitrarily large. We need a deterministic truncation
strategy:

### Rules

1. **Primitives** (string, number, boolean, null): Keep as-is, but truncate
   strings longer than 200 characters with `"...{N} chars total"`.

2. **Arrays**: If length > 3, show the first 2 items and replace the rest with
   a count: `["... {N} items, first 2 shown", item1, item2]`.

3. **Objects**: If the serialized object exceeds a threshold, show all keys but
   recursively truncate values. For deeply nested objects beyond depth 4,
   replace with `"... {N} keys"`.

4. **Total cap**: If the final serialized `data` still exceeds ~4KB, hard-
   truncate with a note: `"... truncated, {N} bytes total. Use network.query
   --recordId {id} --includeBodies for full response"`.

### Example

Before (full response, 200KB+):
```json
{
  "data": {
    "search": {
      "search_response": {
        "items": [
          { "tcin": "12345678", "item": { "title": "HP Laptop 15.6\"...", "dpci": "...", "upc": "..." }, "price": { "current_retail": 499.99, "formatted_current_price": "$499.99" } },
          { "tcin": "87654321", "..." },
          "... 22 more ..."
        ],
        "search_recommendations": {},
        "typed_metadata": { "total": 1200, "offset": 0, "count": 24 }
      }
    }
  }
}
```

After truncation (~500 bytes):
```json
{
  "data": {
    "search": {
      "search_response": {
        "items": ["... 24 items, first 2 shown",
          { "tcin": "12345678", "item": { "... 6 keys" }, "price": { "current_retail": 499.99 } },
          { "tcin": "87654321", "item": { "... 6 keys" }, "price": { "current_retail": 349.99 } }
        ],
        "search_recommendations": {},
        "typed_metadata": { "total": 1200, "offset": 0, "count": 24 }
      }
    }
  }
}
```

---

## Summary

| Operation | Current size | Proposed size | Reduction |
|---|---|---|---|
| `page.goto` | ~4 lines | ~4 lines | None needed |
| `network.query` (20 records) | 2,000-10,000 lines | ~60-80 lines | ~97% |
| `request.raw` | ~50 lines + 250K body | ~20 lines | ~95% |
| `request-plan.infer` | ~60 lines | ~25 lines | ~60% |
| `request-plan.get` | ~60 lines | ~25 lines | ~60% |
| `request.execute` | ~50 lines + 250K body | ~20 lines | ~95% |
| `browser status` | ~15 lines | ~4 lines | ~75% |

The biggest wins come from:
1. **Eliminating base64 body blobs** that duplicate the parsed `data` field
2. **Collapsing `network.query` records** from 100+ lines each to 2-3 lines
3. **Stripping registry bookkeeping** (id, timestamps, contentHash, provenance)
4. **Removing the WebSocket endpoint** from `browser status`
5. **Truncating large `data` payloads** to show shape, not content
