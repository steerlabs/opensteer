# Opensteer CLI Reference

Use the CLI for fast exploration before writing SDK code.

## Quickstart

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
opensteer input 5 laptop --workspace demo --persist "search input" --capture-network search
opensteer click 7 --workspace demo --persist "search button" --capture-network search
opensteer snapshot extraction --workspace demo
opensteer extract "search results" --workspace demo \
  --schema '{"items":[{"name":{"element":13},"price":{"element":14}},{"name":{"element":22},"price":{"element":23}}]}'
opensteer close --workspace demo
```

## What To Read From Snapshots

`snapshot action` and `snapshot extraction` return filtered HTML in the `html` field.

- Read the `html` string.
- Find `c="N"` markers in that HTML.
- Use those numbers as positional `element` ids in CLI commands and extraction schemas.
- Re-snapshot after navigation before using new element numbers.

## Core Commands

### Session and Pages

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer snapshot action --workspace demo
opensteer snapshot extraction --workspace demo
opensteer tab list --workspace demo
opensteer tab 2 --workspace demo
opensteer tab close 2 --workspace demo
opensteer close --workspace demo
```

### DOM Actions

```bash
opensteer click 7 --workspace demo --persist "primary button"
opensteer hover 7 --workspace demo --persist "primary button"
opensteer input 5 "search term" --workspace demo --persist "search input" --press-enter
opensteer scroll down 400 --workspace demo
opensteer scroll down 400 --workspace demo --element 12 --persist "results list"
opensteer extract "page summary" --workspace demo --schema '{"title":{"element":3},"url":{"source":"current_url"}}'
```

Rules:

- `--persist` caches DOM action targets by name.
- `extract <description>` uses `description` because extraction descriptors are named by description.
- There is no CLI `--selector`, `--description` target flag, `--text`, or `--input-json`.

### Network Discovery

```bash
opensteer network query --workspace demo --capture search
opensteer network query --workspace demo --hostname api.example.com --limit 20
opensteer network detail rec_123 --workspace demo
opensteer replay rec_123 --workspace demo
opensteer replay rec_123 --workspace demo --query keyword=headphones --query count=10
opensteer fetch https://api.example.com/search --workspace demo --query keyword=laptop
```

`network query` is intentionally short:

- one compact block per record
- record id
- method and status
- resource type
- URL
- request and response body summaries when useful

Use `network detail` when you need headers, cookies sent, request body previews, response body previews, GraphQL metadata, or redirect chains.

### Browser State

```bash
opensteer cookies --workspace demo
opensteer cookies example.com --workspace demo
opensteer storage example.com --workspace demo
opensteer state example.com --workspace demo
```

Use these when replay needs cookies, storage-backed tokens, hidden fields, or globals.

### Browser Admin

```bash
opensteer browser status --workspace demo
opensteer browser clone --workspace github-sync --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome" --source-profile-directory Default
opensteer browser reset --workspace github-sync
opensteer browser delete --workspace github-sync
opensteer record https://example.com --workspace demo
```

## Recommended Exploration Loop

1. `opensteer open`
2. `opensteer goto ... --capture-network <label>` or a DOM action with `--capture-network`
3. `opensteer network query`
4. `opensteer network detail <recordId>`
5. `opensteer replay <recordId>`
6. `opensteer cookies` / `storage` / `state` if needed
7. `opensteer close`

## Common Mistakes

- Starting API discovery with `snapshot` instead of `captureNetwork`.
- Parsing the old `counters` metadata instead of reading the `html` string.
- Trying to use removed surfaces such as `opensteer run`, `--input-json`, `--selector`, or `--description` target flags.
- Forgetting to re-snapshot after navigation.
