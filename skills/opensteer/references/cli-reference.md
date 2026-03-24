# Opensteer CLI Reference

Use the CLI when you need a fast, stateful loop against a live browser session.

## Session Loop

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

## Core Rules

- Keep `--name` stable for the whole workflow.
- Use `snapshot action` before counter-based interactions.
- Re-snapshot after any navigation or DOM-changing action before reusing counters.
- Use `--description` when the interaction or extraction should become replayable later.
- CLI commands return JSON for machine-readable actions and data commands.

## Navigation And Data

```bash
opensteer goto https://example.com/products --name demo
opensteer snapshot action --name demo
opensteer snapshot extraction --name demo
opensteer extract --name demo --schema '{"items":[{"title":{"selector":"h2"}}]}'
```

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

## Execution Modes

- `managed`: Opensteer launches and owns a fresh browser.
- `attach-live`: Opensteer attaches to an already running Chromium browser.
- `snapshot-session`: Opensteer copies an existing profile into an isolated owned session.
- `snapshot-authenticated`: Opensteer copies a profile while preserving harder authenticated state.

Use `--engine abp` on `open` only when the optional `@opensteer/engine-abp` package is installed.
