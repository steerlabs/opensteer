# Opensteer Agent Tooling Redesign

This document captures the intended direction for Opensteer's agent-facing CLI,
SDK, and documentation. It is the implementation target for the current
overhaul.

## Goals

- Optimize for AI agents exploring pages and reverse engineering websites.
- Keep the public surface aligned with workflows agents already understand:
  HTTP, cookies, storage, and TypeScript code.
- Remove abstraction layers that force agents to learn Opensteer-specific
  schemas when plain code is a better artifact.
- Keep outputs dense with useful context while aggressively removing internal
  bookkeeping, duplicated data, and raw blobs.

## Design Principles

- Discovery and codification are separate concerns.
- The CLI is for discovery: capture traffic, inspect requests, inspect browser
  state, and replay candidates.
- The SDK is for codification: write plain TypeScript using `session.fetch`.
- Do not ship tools for work an agent can already do with simple code or text
  comparison.
- Do ship tools for things agents cannot do alone: browser network capture,
  cookie/storage inspection, and browser-grade request transports.

## Public CLI Surface

### Browser lifecycle

- `opensteer open <url> --workspace <id> [--browser persistent|temporary|attach]`
- `opensteer close --workspace <id>`
- `opensteer status [--workspace <id>] [--json]`
- `opensteer browser status --workspace <id>`
- `opensteer browser clone --workspace <id> --source-user-data-dir <path>`
- `opensteer browser reset --workspace <id>`
- `opensteer browser delete --workspace <id>`

### Navigation

- `opensteer goto <url> --workspace <id> [--capture-network <label>]`

### DOM inspection and interaction

- `opensteer snapshot [action|extraction] --workspace <id>`
- `opensteer click --workspace <id> (--element <n> | --selector <css> | --description <text>) [--capture-network <label>]`
- `opensteer input --workspace <id> --text <value> (...) [--capture-network <label>]`
- `opensteer hover --workspace <id> (...) [--capture-network <label>]`
- `opensteer scroll --workspace <id> (...) --direction <dir> --amount <n> [--capture-network <label>]`
- `opensteer extract --workspace <id> --description <text> [--schema-json <json>]`

### Network inspection

- `opensteer network query --workspace <id> [--capture <label>] [--url <pattern>] [--hostname <host>] [--path <pattern>] [--method <verb>] [--status <code>] [--type <kind>] [--json] [--before <recordId>] [--after <recordId>] [--limit <n>]`
- `opensteer network detail <recordId> --workspace <id>`

### Replay

- `opensteer replay <recordId> --workspace <id> [--query key=value] [--header key=value] [--body-json <json>] [--variables <json>]`

### Browser state

- `opensteer cookies --workspace <id> [--domain <domain>]`
- `opensteer storage --workspace <id> [--domain <domain>]`
- `opensteer state --workspace <id> [--domain <domain>]`

### Advanced

- `opensteer run <semantic-operation> --workspace <id> --input-json <json>`

## Output Rules

- Do not dump generic `JSON.stringify(result, null, 2)` for every operation.
- Use operation-aware formatters.
- `browser status` must not expose endpoint, base URL, root path, user data
  dir, browser path, or manifest.
- `network query` returns compact summaries, chronological order, and filters
  out CORS preflights by default.
- `network detail` is the deep-dive view for headers, cookies, request body,
  response body, GraphQL metadata, redirect chains, and challenge notes.
- `replay` reports the winning transport, fallback behavior, and truncated
  response data.
- Truncation must be deterministic and predictable.

## Discovery Flow

1. Capture network traffic with `goto` or DOM actions using
   `captureNetwork` / `--capture-network`.
2. Scan traffic with `network query`.
3. Inspect a candidate with `network detail`.
4. Test it with `replay`.
5. If auth or state is required, inspect `cookies`, `storage`, and `state`,
   and use `network query --before/--after` to trace dependencies.
6. Write TypeScript with `session.fetch`.

## SDK Surface

The agent-facing SDK should be centered on:

- `goto`
- `dom.click`
- `dom.input`
- `dom.hover`
- `dom.scroll`
- `extract`
- `snapshot`
- `network.query`
- `network.detail`
- `network.replay`
- `cookies`
- `storage`
- `state`
- `fetch`
- `close`
- `disconnect`

## Removals

The redesign removes the custom request-plan and recipe architecture from the
agent workflow. That includes:

- request plans
- recipes and auth recipes
- reverse package discovery/report/export flows
- network minimize/diff/probe agent tooling
- raw request execution as an agent-facing workflow artifact

The persistence artifact for API work is a code file, not a registry entry.

## Edge Cases To Support

- GraphQL operation detection and variable override
- WebSocket discovery and inspection
- SSE discovery and inspection
- Redirect chains
- CORS preflight filtering
- request signing and dynamic tokens
- anti-bot fallback across transports
- hidden form fields and useful JS state needed for replay
