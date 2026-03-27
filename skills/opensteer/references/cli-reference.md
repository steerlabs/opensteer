# Opensteer CLI Reference

Use the CLI when you need a fast, stateful loop against a live browser session.

## DOM Automation And Extraction

```bash
opensteer open https://example.com --name demo
opensteer snapshot action --name demo
opensteer click 3 --name demo --description "primary button"
opensteer input 7 "search term" --name demo --press-enter --description "search input"
opensteer snapshot extraction --name demo
opensteer extract --name demo \
  --description "page summary" \
  --schema '{"title":{"selector":"title"},"url":{"source":"current_url"}}'
opensteer close --name demo
```

DOM loop:

- Keep `--name` stable for the whole workflow.
- Use `snapshot action` before counter-based interactions.
- Re-snapshot after any navigation or DOM-changing action before reusing counters.
- Use `--description` when the interaction or extraction should become replayable later.
- Treat `snapshot extraction` as a planning view. `extract` is the step that reads final values from the live page.
- Build the exact JSON object you want. Each leaf field must be explicit: `{ element: N }`, `{ selector: "..." }`, optional `attribute`, or `{ source: "current_url" }`.
- Use `element` fields only with counters from a fresh snapshot in the same live session.
- For arrays, include one or more representative objects. Add multiple examples when repeated rows have structural variants.
- CLI commands return JSON for machine-readable actions and data commands.

## Reverse Engineering And Replay

```bash
opensteer open https://example.com/app --name demo
opensteer click 3 --name demo --description "load products" --network-tag products-load
opensteer network query --name demo --tag products-load --include-bodies --limit 20
opensteer request raw --name demo https://example.com/api/products --transport context-http
opensteer plan infer --name demo --record-id rec_123 --key products.search --version v1
opensteer request execute --name demo products.search --query q=laptop
```

Reverse loop:

- `--network-tag` is supported on `goto`, `click`, `scroll`, `input`, `hover`. It is NOT supported on `open`. MUST use `open` then `goto --network-tag` to tag navigation.
- MUST query by tag first (`--tag`), then query all traffic to catch async requests.
- MUST probe discovered APIs with `request raw` — try `--transport direct-http` first, then `--transport context-http`. Do NOT just log URLs.
- If you find an auth endpoint, acquire a token and re-probe data endpoints with it.
- MUST call `network save` before closing the session.
- `plan infer` throws if the key+version already exists. Use a new version on re-runs.
- Capture the browser action first when cookies, CSRF tokens, or JavaScript-minted headers may matter.
- Prefer `direct-http` only after proving the request no longer depends on live browser state.
- Characterize what you find even when it is not the data you wanted. "No API found" after probing is a valid conclusion.

## Extraction Schema Examples

```bash
opensteer snapshot extraction --name demo

# Explicit field bindings
opensteer extract --name demo \
  --schema '{"title":{"element":3},"price":{"element":7}}'

opensteer extract --name demo \
  --schema '{"url":{"selector":"a.primary","attribute":"href"},"pageUrl":{"source":"current_url"}}'

# Arrays with representative items
opensteer extract --name demo \
  --schema '{"items":[{"title":{"selector":"#products li:nth-child(1) .title"},"price":{"selector":"#products li:nth-child(1) .price"}},{"title":{"selector":"#products li:nth-child(2) .title"},"price":{"selector":"#products li:nth-child(2) .price"}}]}'
```

Do not use semantic placeholder values such as `"string"` or `--prompt` here. The current public CLI extractor is schema-and-descriptor based.

## Browser Connection Modes

Open a brand-new browser:

```bash
opensteer open https://example.com --name demo --headless true
```

Attach to a live Chromium instance:

```bash
opensteer open https://example.com --name demo --browser attach-live --attach-endpoint 9222
opensteer browser discover
opensteer browser inspect --endpoint 9222
```

Launch from a copied local profile:

```bash
opensteer open https://example.com --name demo --browser snapshot-session \
  --source-user-data-dir "~/Library/Application Support/Google/Chrome" \
  --source-profile-directory Default
```

Launch from a copied authenticated profile:

```bash
opensteer open https://example.com --name demo --browser snapshot-authenticated \
  --source-user-data-dir "~/Library/Application Support/Google/Chrome" \
  --source-profile-directory "Profile 1"
```

## Local Browser Profile Helpers

```bash
opensteer local-profile list
opensteer local-profile inspect --user-data-dir "~/Library/Application Support/Opensteer Chrome"
opensteer local-profile unlock --user-data-dir "~/Library/Application Support/Opensteer Chrome"
```

## Cloud Profile Cookie Sync

```bash
opensteer profile sync \
  --profile-id bp_123 \
  --attach-endpoint 9222 \
  --domain github.com
```

## Network Capture

Inspect the traffic triggered by a session:

```bash
opensteer network query --name demo --include-bodies --limit 20
opensteer network save --name demo --tag login-flow
opensteer network diff --name demo --left rec_a --right rec_b
opensteer network probe --name demo --record-id rec_123
opensteer network minimize --name demo --record-id rec_123 --transport context-http
```

## Request Plans

Infer a plan from a captured record, then execute it:

```bash
opensteer plan infer --name demo --record-id rec_123 --key products.search --version v1
opensteer plan get --name demo products.search
opensteer request execute --name demo products.search --query q=laptop
opensteer request raw --name demo https://example.com/api/search --transport context-http
```

## Page Navigation And Snapshotting

```bash
opensteer goto https://example.com/products --name demo
opensteer snapshot action --name demo
opensteer snapshot extraction --name demo
opensteer extract --name demo --schema '{"items":[{"title":{"selector":"h2"}}]}'
```

## Execution Modes

- `managed`: Opensteer launches and owns a fresh browser.
- `attach-live`: Opensteer attaches to an already running Chromium browser.
- `snapshot-session`: Opensteer copies an existing profile into an isolated owned session.
- `snapshot-authenticated`: Opensteer copies a profile while preserving harder authenticated state.

Use `--engine abp` on `open` only when the optional `@opensteer/engine-abp` package is installed.
