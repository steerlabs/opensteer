# Opensteer CLI Reference

All commands follow the pattern: `opensteer <command> [positionals] [--options]`

Long flags are canonical kebab-case. Unknown flags and flags used on the wrong command fail fast.
Action/data commands print JSON on stdout. Help commands print human-readable usage text. Errors are JSON on stderr.

## Global Options

These options apply to most commands:

| Option              | Description                                       |
| :------------------ | :------------------------------------------------ |
| `--name <name>`     | Session name (default: `"default"`)               |
| `--root-dir <path>` | Project root directory (default: `process.cwd()`) |

## Session Management

### `opensteer open [url]`

Opens a browser session. Optionally navigates to a URL.

```bash
opensteer open                                   # Open browser only
opensteer open https://example.com               # Open and navigate
opensteer open https://example.com --headless    # Headless mode
opensteer open https://example.com --engine abp  # Use ABP engine
opensteer open https://example.com --browser cdp --cdp 9222
opensteer open https://example.com --browser auto-connect --fresh-tab
opensteer open https://example.com --browser profile \
  --user-data-dir "~/Library/Application Support/Google/Chrome" \
  --profile-directory Default
opensteer browser discover
opensteer browser inspect --cdp 9222
opensteer open https://example.com --cloud --cloud-profile-id bp_123
```

**Options:**
| Option | Description |
|:-------|:-----------|
| `--engine <name>` | Browser engine: `playwright` (default) or `abp` |
| `--headless` | Run browser in headless mode |
| `--headed` | Force a visible browser window |
| `--browser <kind>` | Browser mode: `managed`, `profile`, `cdp`, or `auto-connect` |
| `--executable-path <path>` | Custom browser executable |
| `--browser-arg <arg>` | Extra Chrome/Chromium argument (repeatable) |
| `--user-data-dir <path>` | Chrome user-data root for `--browser profile` |
| `--profile-directory <name>` | Chrome profile directory for `--browser profile` |
| `--cdp <port|ws-url|http-url>` | Existing Chrome DevTools endpoint for `--browser cdp` |
| `--cdp-header <name:value>` | Extra CDP header (repeatable) |
| `--auto-connect` | Auto-discover a running Chrome/Chromium instance |
| `--fresh-tab` | Open a fresh tab when attaching through CDP/auto-connect |
| `--timeout-ms <ms>` | Session timeout |
| `--viewport <WxH>` | Viewport size (e.g., `1280x720`, `null` for no viewport) |
| `--locale <locale>` | Browser locale (e.g., `en-US`) |
| `--timezone-id <tz>` | Timezone (e.g., `America/New_York`) |
| `--user-agent <ua>` | Custom user agent string |
| `--ignore-https-errors` | Ignore HTTPS certificate errors |
| `--bypass-csp` | Bypass Content Security Policy |
| `--browser-json <json>` | Full browser config as JSON |
| `--context-json <json>` | Full context config as JSON |
| `--cloud-profile-id <id>` | Cloud browser profile ID when opening a cloud session |
| `--cloud-profile-reuse-if-active` | Reuse an active cloud session for the selected profile |

**Execution mode options:**
| Option | Description |
|:-------|:-----------|
| `--local` | Force local execution mode |
| `--cloud` | Use Opensteer Cloud |

### `opensteer close`

Closes the active browser session.

```bash
opensteer close
opensteer close --name my-session
```

### `opensteer browser discover`

Discovers locally attachable Chrome/Chromium DevTools endpoints.

```bash
opensteer browser discover
opensteer browser discover --json
opensteer browser discover --timeout-ms 4000
```

### `opensteer browser inspect --cdp <endpoint>`

Inspects an explicit CDP endpoint and resolves its browser websocket URL.

```bash
opensteer browser inspect --cdp 9222
opensteer browser inspect --cdp http://127.0.0.1:9222
opensteer browser inspect --cdp ws://127.0.0.1:9222/devtools/browser/root
```

### `opensteer local-profile list [--user-data-dir <path>]`

Lists discovered local Chrome/Chromium profiles.

```bash
opensteer local-profile list
opensteer local-profile list --user-data-dir "~/Library/Application Support/Google/Chrome"
```

### `opensteer local-profile inspect [--user-data-dir <path>]`

Inspects a Chrome/Chromium user-data-dir and returns its ownership state as JSON.

```bash
opensteer local-profile inspect
opensteer local-profile inspect --user-data-dir "~/Library/Application Support/Opensteer Chrome"
```

Returned `status` values:

- `available`
- `unsupported_default_user_data_dir`
- `opensteer_owned`
- `browser_owned`
- `stale_lock`

### `opensteer local-profile unlock --user-data-dir <path>`

Removes stale Chrome singleton artifacts only when inspection proves the profile is in a
`stale_lock` state.

```bash
opensteer local-profile unlock --user-data-dir "~/Library/Application Support/Opensteer Chrome"
```

`unlock` never runs implicitly during `open`. If the profile is live or ambiguous, the command
fails with a structured JSON error on stderr.

## Real Browser Modes

- `managed` launches a fresh isolated local Chrome/Chromium process and attaches automatically. This is the default when you want a brand-new browser.
- `profile` launches and owns a dedicated non-default Chrome profile directory.
- `auto-connect` attaches only when Opensteer can identify a unique best local browser candidate.
- `cdp` attaches to the exact endpoint you pass and is the right choice for custom ports or remote browser targets.

If you are launching Chrome manually, use a dedicated `--user-data-dir` and a known port. When attaching to an already-running browser, pass `--fresh-tab` if you want Opensteer to open a clean tab instead of reusing the current one.

### `opensteer profile upload --profile-id <id> --from-user-data-dir <path> [--profile-directory <name>]`

Snapshots a local Chrome profile and uploads it into an existing cloud browser profile.

```bash
opensteer profile upload --profile-id bp_123 --from-user-data-dir "~/Library/Application Support/Google/Chrome"
opensteer profile upload --profile-id bp_123 --from-user-data-dir "~/Library/Application Support/Google/Chrome" --profile-directory "Profile 1"
```

---

## Navigation

### `opensteer goto <url>`

Navigates to a URL in the current session.

```bash
opensteer goto https://example.com/page
opensteer goto https://example.com/page --network-tag "nav"
```

| Option                | Description                                        |
| :-------------------- | :------------------------------------------------- |
| `--network-tag <tag>` | Label network traffic triggered by this navigation |

---

## Snapshots

### `opensteer snapshot [mode]`

Captures a snapshot of the current page state.

```bash
opensteer snapshot action          # Interactive elements with counters
opensteer snapshot extraction      # Full page structure for extraction
```

**Modes:**

- `action` — returns interactive elements with counter numbers. Use these counters as targets for click/hover/input/scroll.
- `extraction` — returns the full DOM structure optimized for `extract` operations.

---

## DOM Actions

**IMPORTANT: Always run `opensteer snapshot action` immediately before using a counter number.** Any action (click, input, scroll, goto) can mutate the DOM, making previous counter numbers stale. A counter from an old snapshot may point to the wrong element or fail entirely. Re-snapshot every time.

All action commands accept a target as either:

- A **positional counter number** (from a fresh snapshot): `opensteer click 5`
- `--selector <css>` — CSS selector: `opensteer click --selector "button.submit"`

All action commands support `--network-tag <tag>` to label triggered network traffic.

### `opensteer click <target>`

Clicks an element.

```bash
opensteer click 5                                            # By counter
opensteer click --selector "button[type=submit]"             # By CSS
opensteer click --selector "#search" --network-tag "search"  # Tag network
```

### `opensteer hover <target>`

Hovers over an element.

```bash
opensteer hover 3
opensteer hover --selector ".dropdown-trigger"
```

### `opensteer input <target> [text]`

Types text into an element.

```bash
opensteer input 12 "search query"                         # Counter + text
opensteer input --selector "input[name=q]" --text "query" # Selector + text
opensteer input --selector "input[name=q]" --text "query" --press-enter  # With Enter
```

| Option          | Description                              |
| :-------------- | :--------------------------------------- |
| `--text <text>` | Text to type (alternative to positional) |
| `--press-enter` | Press Enter after typing                 |

### `opensteer scroll <target> --direction <dir> --amount <n>`

Scrolls an element or the page.

```bash
opensteer scroll 0 --direction down --amount 3
opensteer scroll --selector ".content" --direction up --amount 500
```

| Option              | Description                      |
| :------------------ | :------------------------------- |
| `--direction <dir>` | `up`, `down`, `left`, or `right` |
| `--amount <n>`      | Scroll amount (positive number)  |

---

## Data Extraction

### `opensteer extract --description <text>`

Extracts structured data from the current page using a persisted extraction descriptor.

```bash
opensteer extract --description "product list"
opensteer extract --description "search results"
```

| Option                 | Description                              |
| :--------------------- | :--------------------------------------- |
| `--description <text>` | **(required)** Extraction descriptor key |

---

## Inspection

### `opensteer inspect cookies`

Reads cookies from the current browser session.

```bash
opensteer inspect cookies
opensteer inspect cookies --url https://example.com
opensteer inspect cookies --url https://example.com --url https://api.example.com
```

| Option        | Description                     |
| :------------ | :------------------------------ |
| `--url <url>` | Restrict cookies to URL scopes  |

### `opensteer inspect storage`

Reads browser storage from the current page session.

```bash
opensteer inspect storage
opensteer inspect storage --include-session-storage
opensteer inspect storage --include-indexed-db
```

| Option                      | Description                    |
| :-------------------------- | :----------------------------- |
| `--include-session-storage` | Include sessionStorage entries |
| `--include-indexed-db`      | Include IndexedDB metadata     |

---

## Network Operations

### `opensteer network query`

Queries captured network traffic.

```bash
opensteer network query                              # All traffic
opensteer network query --tag "search"               # By tag
opensteer network query --include-bodies             # Include request/response bodies
opensteer network query --hostname "api.example.com" # Filter by hostname
opensteer network query --method POST                # Filter by method
opensteer network query --source saved --tag "auth"  # Query saved traffic
```

| Option                   | Description                                           |
| :----------------------- | :---------------------------------------------------- |
| `--source <src>`         | `journal` (default, in-memory) or `saved` (persisted) |
| `--tag <tag>`            | Filter by network tag                                 |
| `--include-bodies`       | Include request and response bodies                   |
| `--limit <n>`            | Max records to return                                 |
| `--record-id <id>`       | Filter by record ID                                   |
| `--request-id <id>`      | Filter by request ID                                  |
| `--action-id <id>`       | Filter by action ID                                   |
| `--url <url>`            | Filter by URL (substring match)                       |
| `--hostname <host>`      | Filter by hostname                                    |
| `--path <path>`          | Filter by URL path                                    |
| `--method <method>`      | Filter by HTTP method                                 |
| `--status <code>`        | Filter by status code                                 |
| `--resource-type <type>` | Filter by resource type (xhr, fetch, document, etc.)  |
| `--page-ref <ref>`       | Filter by page reference                              |
| `--output <path>`        | Write output to file instead of stdout                |

### `opensteer network save --tag <name>`

Saves filtered network traffic to persistent storage.

```bash
opensteer network save --tag "api-calls" --hostname "api.example.com"
opensteer network save --tag "search" --method POST --path "/search"
```

Accepts the same filter options as `network query` plus `--tag` (required).

### `opensteer network clear`

Clears network records.

```bash
opensteer network clear              # Clear all
opensteer network clear --tag "old"  # Clear by tag
```

---

## Request Plans

### `opensteer plan infer --record-id <id> --key <key> --version <version>`

Promotes a captured network record to a reusable request plan.

```bash
opensteer plan infer --record-id "rec_abc123" --key "search-api" --version "1.0"
opensteer plan infer --record-id "rec_abc123" --key "search-api" --version "1.0" --lifecycle draft
```

| Option                | Description                                  |
| :-------------------- | :------------------------------------------- |
| `--record-id <id>`    | **(required)** Network record ID to promote  |
| `--key <key>`         | **(required)** Plan key for future reference |
| `--version <version>` | **(required)** Plan version                  |
| `--lifecycle <state>` | `draft`, `active`, or `deprecated`           |

### `opensteer plan write --key <key> --version <version> --payload <json>`

Writes a request plan manually.

```bash
opensteer plan write --key "my-api" --version "1.0" --payload '{"method":"GET","url":"https://api.example.com/data"}'
opensteer plan write --key "my-api" --version "1.0" --payload-file plan.json
```

| Option                  | Description                        |
| :---------------------- | :--------------------------------- |
| `--key <key>`           | **(required)** Plan key            |
| `--version <version>`   | **(required)** Plan version        |
| `--payload <json>`      | Plan payload as inline JSON        |
| `--payload-file <path>` | Plan payload from file             |
| `--lifecycle <state>`   | `draft`, `active`, or `deprecated` |
| `--tags <csv>`          | Comma-separated tags               |

### `opensteer plan get <key> [version]`

Retrieves a stored request plan.

```bash
opensteer plan get search-api
opensteer plan get search-api 1.0
```

### `opensteer plan list [--key <key>]`

Lists available request plans.

```bash
opensteer plan list                    # All plans
opensteer plan list --key search-api   # Plans for a specific key
```

---

## Request Execution

### `opensteer request raw <url>`

Executes a raw HTTP request through either the live browser session (`session-http`) or the
direct HTTP transport (`direct-http`).

```bash
opensteer request raw https://api.example.com/data
opensteer request raw https://api.example.com/data --method POST --body-json '{"q":"test"}'
opensteer request raw https://api.example.com/data --header "Authorization=Bearer token"
opensteer request raw https://api.example.com/data --transport direct-http
```

| Option                  | Description                 |
| :---------------------- | :-------------------------- |
| `--transport <kind>`    | `session-http` or `direct-http` |
| `--method <method>`     | HTTP method (default: GET)  |
| `--header <name=value>` | Request header (repeatable) |
| `--body-json <json>`    | JSON request body           |
| `--body-text <text>`    | Text request body           |
| `--body-base64 <data>`  | Base64-encoded request body |
| `--body-file <path>`    | Request body from file      |
| `--content-type <type>` | Content-Type header         |
| `--no-follow-redirects` | Do not follow redirects     |

### `opensteer request [execute] <key>`

Executes a stored request plan with parameter substitution. `session-http` plans run through the
live browser session. `direct-http` plans run through the direct HTTP transport. If the plan has
an auth failure policy and linked auth recipe, Opensteer runs the recipe once and retries once.

```bash
opensteer request search-api                                       # Execute plan
opensteer request search-api --query "q=airpods"                   # With query params
opensteer request search-api --header "Authorization=Bearer token" # With headers
opensteer request execute search-api --version 1.0                 # Explicit execute
```

| Option                  | Description                     |
| :---------------------- | :------------------------------ |
| `--version <version>`   | Plan version to execute         |
| `--param <name=value>`  | URL path parameter (repeatable) |
| `--query <name=value>`  | Query parameter (repeatable)    |
| `--header <name=value>` | Request header (repeatable)     |
| `--body-json <json>`    | Override request body           |
| `--no-validate`         | Skip response validation        |

---

## Auth Recipes

### `opensteer auth-recipe write --key <key> --version <version> --payload <json>`

Writes a deterministic auth recovery recipe.

```bash
opensteer auth-recipe write --key "refresh-session" --version "1.0.0" --payload '{"steps":[{"kind":"sessionRequest","request":{"url":"https://example.com/auth/refresh","method":"POST"}}]}'
opensteer auth-recipe write --key "refresh-token" --version "1.0.0" --payload-file recipe.json
```

| Option                  | Description                          |
| :---------------------- | :----------------------------------- |
| `--key <key>`           | **(required)** Recipe key            |
| `--version <version>`   | **(required)** Recipe version        |
| `--payload <json>`      | Recipe payload as inline JSON        |
| `--payload-file <path>` | Recipe payload from file             |
| `--tags <csv>`          | Comma-separated tags                 |

### `opensteer auth-recipe get <key> [version]`

Retrieves a stored auth recipe.

```bash
opensteer auth-recipe get refresh-session
opensteer auth-recipe get refresh-session 1.0.0
```

### `opensteer auth-recipe list [--key <key>]`

Lists available auth recipes.

```bash
opensteer auth-recipe list
opensteer auth-recipe list --key refresh-session
```

### `opensteer auth-recipe run <key>`

Runs a stored auth recipe once and returns emitted variables plus any retry overrides.

```bash
opensteer auth-recipe run refresh-session
opensteer auth-recipe run refresh-session --version 1.0.0 --variables '{"csrf":"seed"}'
```

| Option                | Description                         |
| :-------------------- | :---------------------------------- |
| `--version <version>` | Recipe version to run               |
| `--variables <json>`  | Seed variables for interpolation    |

---

## Special Modes

### `opensteer service-host`

Starts a persistent session service (background process for CLI commands to connect to).

```bash
opensteer service-host --name default
```

### `opensteer computer --action <json>`

Executes pixel-space computer-use actions. Used for vision-model integration.

```bash
opensteer computer --action '{"type":"click","x":100,"y":200}'
opensteer computer --action '{"type":"type","text":"hello"}'
```
