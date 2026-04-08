# Opensteer CLI Reference

Use the CLI for fast exploration before writing SDK code.

## Quickstart

```bash
opensteer open https://example.com --workspace demo
opensteer snapshot action --workspace demo
opensteer input 5 laptop --workspace demo --persist "search input" --capture-network search
opensteer click 7 --workspace demo --persist "search button" --capture-network search
opensteer snapshot extraction --workspace demo
opensteer extract '{"items":[{"name":{"element":13},"price":{"element":14}},{"name":{"element":22},"price":{"element":23}}]}' \
  --workspace demo --persist "search results"
opensteer close --workspace demo
```

## Snapshot Reading

- Read the `html` string from snapshot output.
- Find `c="N"` markers in that HTML.
- Use those numbers as positional `element` ids.
- Re-snapshot after navigation before using new element numbers.

## Core Commands

### Session and Pages

```bash
opensteer open https://example.com --workspace demo
opensteer goto https://example.com/search --workspace demo --capture-network page-load
opensteer snapshot action --workspace demo
opensteer snapshot extraction --workspace demo
opensteer tab list --workspace demo
opensteer close --workspace demo
```

### DOM Actions

```bash
opensteer click 7 --workspace demo --persist "primary button"
opensteer input 5 "search term" --workspace demo --persist "search input" --press-enter
opensteer scroll down 400 --workspace demo
opensteer extract '{"title":{"element":3}}' --workspace demo --persist "page summary"
```

### Network Discovery

```bash
opensteer network query --workspace demo --capture search
opensteer network detail rec_123 --workspace demo
opensteer replay rec_123 --workspace demo
opensteer fetch https://api.example.com/search --workspace demo --query keyword=laptop
```

### Browser State

```bash
opensteer cookies example.com --workspace demo
opensteer storage example.com --workspace demo
opensteer state example.com --workspace demo
```

### Browser Admin

```bash
opensteer browser status --workspace demo
opensteer browser clone --workspace github-sync --source-user-data-dir "$HOME/Library/Application Support/Google/Chrome"
opensteer browser reset --workspace github-sync
opensteer browser delete --workspace github-sync
opensteer record https://example.com --workspace demo
```

## Recommended Loop

1. `opensteer open`
2. `opensteer goto ... --capture-network <label>` or a DOM action with `--capture-network`
3. `opensteer network query`
4. `opensteer network detail <recordId>`
5. `opensteer replay <recordId>`
6. `opensteer cookies` / `storage` / `state` if needed
7. `opensteer close`

## Common Mistakes

- Starting API discovery with `snapshot` instead of `captureNetwork`.
- Parsing counters instead of reading the `html` string.
- Trying to use removed surfaces such as `opensteer run`, `--input-json`, `--selector`, or `--description`.
