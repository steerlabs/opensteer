# Opensteer CLI Reference

The CLI is the fastest way to explore a site before writing SDK code.

## Core Commands

### Browser Lifecycle

```bash
opensteer open https://example.com --workspace demo
opensteer close --workspace demo
opensteer status --workspace demo
opensteer browser status --workspace demo
opensteer browser clone --workspace demo --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome"
opensteer browser reset --workspace demo
opensteer browser delete --workspace demo
```

`browser status` is intentionally minimal. It does not expose the raw browser websocket endpoint.

### Navigation

```bash
opensteer goto https://example.com/search --workspace demo --capture-network page-load
```

Use `--capture-network <label>` on actions that should persist traffic.

### DOM Inspection

```bash
opensteer snapshot action --workspace demo
opensteer snapshot extraction --workspace demo
```

Read the `html` output. The `c="N"` markers are the element ids used in CLI targeting.

### DOM Actions

All of these support `--capture-network <label>`:

```bash
opensteer click --workspace demo --element 7
opensteer click --workspace demo --description "search button"
opensteer input --workspace demo --description "search input" --text "laptop"
opensteer extract --workspace demo --description "page summary" --schema-json '{"title":{"element":3}}'
```

## Network Discovery

### Scan Captured Traffic

```bash
opensteer network query --workspace demo --capture search
opensteer network query --workspace demo --capture search --json
opensteer network query --workspace demo --hostname api.example.com
opensteer network query --workspace demo --url search --limit 20
opensteer network query --workspace demo --before rec_123 --limit 30
```

Important flags:

- `--capture <label>`
- `--json`
- `--url <substring>`
- `--hostname <host>`
- `--path <substring>`
- `--method GET|POST|...`
- `--status <code>`
- `--type fetch|xhr|websocket|event-stream|...`
- `--before <recordId>`
- `--after <recordId>`
- `--limit <n>`

`network query` output is summarized on purpose:

- one record per short block
- record id
- method
- status
- resource type
- URL
- request/response size and content type

It filters out CORS preflight requests by default.

### Inspect One Record

```bash
opensteer network detail rec_123 --workspace demo
```

This shows:

- request URL/method/status
- request headers
- parsed cookies sent
- request body preview when useful
- response headers
- response body preview
- GraphQL metadata
- redirect chain
- challenge notes for bot-protection pages when detected

### Replay One Record

```bash
opensteer replay rec_123 --workspace demo
opensteer replay rec_123 --workspace demo --query keyword=headphones --query count=10
opensteer replay rec_123 --workspace demo --header "authorization=Bearer abc"
opensteer replay rec_123 --workspace demo --body-json '{"keyword":"headphones"}'
opensteer replay rec_123 --workspace demo --variables '{"keyword":"headphones"}'
```

`replay` tries the transport ladder automatically and reports which transport succeeded.

## Browser State

### Cookies

```bash
opensteer cookies --workspace demo
opensteer cookies --workspace demo --domain example.com
```

### Storage

```bash
opensteer storage --workspace demo
opensteer storage --workspace demo --domain example.com
```

### Full State

```bash
opensteer state --workspace demo
opensteer state --workspace demo --domain example.com
```

`state` combines cookies, storage, hidden fields, and captured globals for the selected domain.

## When To Use `opensteer run`

Prefer the shorthand commands above. Use `opensteer run <operation>` only when you need a field the shorthand parser does not expose.

```bash
opensteer run page.goto --workspace demo --input-json '{"url":"https://example.com","captureNetwork":"page-load"}'
opensteer run dom.click --workspace demo --input-json '{"target":{"kind":"description","description":"search button"},"captureNetwork":"search"}'
```

For normal exploration, the short commands are the intended surface.

## Recommended Exploration Loop

1. `opensteer open`
2. `opensteer goto ... --capture-network <label>`
3. `opensteer network query`
4. `opensteer network detail <recordId>`
5. `opensteer replay <recordId>`
6. `opensteer cookies` / `storage` / `state` when needed
7. `opensteer close`

## Common Mistakes

- Starting API exploration with `snapshot` instead of `captureNetwork`.
- Reading the old generic JSON dump mentally instead of using the formatted summary/detail output.
- Treating `opensteer run` as the default path when the shorthand commands already cover the task.
