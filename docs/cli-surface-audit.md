# Opensteer CLI Surface Audit

Full audit of every CLI tool, its inputs, outputs, and what to cut.

---

## 1. Design Principles

### For agents, not humans

The primary CLI consumer is an AI agent, not a human typing in a terminal.
Design decisions optimize for agent comprehension and token efficiency.

### Input design

- **Positional args for primary inputs.** The thing the command is about goes
  first: `click 5`, `scroll down 3`, `extract '{"items":[{"name":{"element":13}}]}'`. No flag
  ceremony for the essential argument.
- **Flags for optional/secondary inputs.** `--capture-network`, `--press-enter`,
  `--persist`, `--button`. Always scalar values.
- **JSON only for inherently unstructured data.** Request bodies (`--body`),
  extraction schemas (positional `extract <schema>`), arbitrary dicts (`--cookies`, `--globals`). Never a
  generic `--input-json` blob. JSON is scoped to one named parameter.
- **Union types become separate subcommands.** The command name is the
  discriminator: `computer click`, `computer type`, `computer key`. Not one
  command with a type field in JSON.
- **Repeatable `key=value` flags for simple maps.** `--header Accept=application/json
  --header Auth="Bearer tok"`. Curl pattern.

### Output design

- **Small structured data → filtered JSON.** 2-6 useful fields, no internal refs.
- **Large/scannable data → plaintext.** Network record lists, headers, body previews.
- **Strip everything the agent doesn't need for its next decision.** No internal
  refs (pageRef, frameRef, documentRef, nodeRef), no timestamps, no byte-level
  transfer stats, no base64 duplicates of parsed data.

### Element targeting

CLI targeting is **element numbers only** (the `c` attribute from snapshots).
`--selector` and `--description` are removed from CLI. Agents always:
snapshot → pick element number → act.

`--persist` saves an element's structural path under a name for deterministic
SDK replay. It does NOT enable CLI targeting by name — element number is always
required. Resolution by persist name is SDK-only via
`target: { kind: "persist", name: "..." }`.

### Workspace default

`--workspace` is required for all stateful commands. To avoid repeating it on
every call, set the `OPENSTEER_WORKSPACE` env var:

```
export OPENSTEER_WORKSPACE=target-search
opensteer click 5
opensteer snapshot action
opensteer network query --url redsky
```

The `--workspace` flag overrides the env var when both are present.

---

## 2. Current State: 63 Semantic Operations

The protocol defines 63 operations. 33 are "exposed" (public). After this
audit, all 33 exposed operations have CLI paths — 41 CLI commands total
(8 `computer` subcommands map to a single `computer.execute` operation,
4 `tab` subcommands map to 4 separate page operations).

### Operations with CLI aliases (core workflow)

| CLI command | Operation | Positional args | Flags |
|---|---|---|---|
| `open <url>` | `session.open` | url | `--headless`, `--provider` |
| `close` | `session.close` | — | — |
| `status` | — | — | — |
| `goto <url>` | `page.goto` | url | `--capture-network` |
| `snapshot [mode]` | `page.snapshot` | mode (action\|extraction) | — |
| `click <element>` | `dom.click` | element number | `--button`, `--persist`, `--capture-network` |
| `hover <element>` | `dom.hover` | element number | `--persist`, `--capture-network` |
| `input <element> <text>` | `dom.input` | element number, text | `--press-enter`, `--persist`, `--capture-network` |
| `scroll <dir> <amount>` | `dom.scroll` | direction, amount | `--element` (scope), `--persist`, `--capture-network` |
| `extract <schema>` | `dom.extract` | schema JSON | `--persist` |
| `network query` | `network.query` | — | 11 filter flags |
| `network detail <id>` | `network.detail` | recordId | — |
| `replay <id>` | `network.replay` | recordId | `--query`, `--header`, `--body`, `--variables` |
| `cookies [domain]` | `session.cookies` | domain (optional) | — |
| `storage [domain]` | `session.storage` | domain (optional) | — |
| `state [domain]` | `session.state` | domain (optional) | — |
| `evaluate <script>` | `page.evaluate` | script | — |

### New command groups

| CLI command | Operation | Positional args | Flags |
|---|---|---|---|
| `tab list` | `page.list` | — | — |
| `tab new [url]` | `page.new` | url (optional) | — |
| `tab <n>` | `page.activate` | tab index | — |
| `tab close [n]` | `page.close` | tab index (optional, default: current) | — |
| `init-script <script>` | `page.add-init-script` | script | — |
| `computer click <x> <y>` | `computer.execute` | x, y | `--button`, `--count`, `--modifiers`, `--capture-network` |
| `computer type <text>` | `computer.execute` | text | `--capture-network` |
| `computer key <key>` | `computer.execute` | key | `--modifiers`, `--capture-network` |
| `computer scroll <x> <y>` | `computer.execute` | x, y | `--dx`, `--dy`, `--capture-network` |
| `computer move <x> <y>` | `computer.execute` | x, y | `--capture-network` |
| `computer drag <x1> <y1> <x2> <y2>` | `computer.execute` | start/end coords | `--steps`, `--capture-network` |
| `computer screenshot` | `computer.execute` | — | `--format` |
| `computer wait <ms>` | `computer.execute` | ms | — |
| `fetch <url>` | `session.fetch` | url | `--method`, `--header`, `--query`, `--body`, `--transport`, `--cookies`, `--follow-redirects` |
| `captcha solve` | `captcha.solve` | — | `--provider`, `--api-key`, `--type`, `--site-key`, `--page-url`, `--timeout` |
| `scripts capture` | `scripts.capture` | — | `--url-filter`, `--persist`, `--inline`, `--external`, `--dynamic`, `--workers` |
| `scripts beautify <id>` | `scripts.beautify` | artifactId | `--persist` |
| `scripts deobfuscate <id>` | `scripts.deobfuscate` | artifactId | `--persist` |
| `scripts sandbox <id>` | `scripts.sandbox` | artifactId | `--fidelity`, `--timeout`, `--clock`, `--cookies`, `--globals`, `--ajax-routes` |
| `interaction capture` | `interaction.capture` | — | `--key`, `--duration`, `--script`, `--include-storage`, `--include-session-storage`, `--include-indexed-db`, `--global-names`, `--case-id`, `--notes`, `--tags` |
| `interaction get <id>` | `interaction.get` | traceId | — |
| `interaction replay <id>` | `interaction.replay` | traceId | — |
| `interaction diff <left> <right>` | `interaction.diff` | leftTraceId, rightTraceId | — |
| `artifact read <id>` | `artifact.read` | artifactId | — |

### Internal-only operations (remove from codebase entirely)

| Operation | Reason to remove |
|---|---|
| `request.raw` | Replaced by `network.replay` |
| `request-plan.infer` | Plan/recipe system removed |
| `request-plan.write` | Plan/recipe system removed |
| `request-plan.get` | Plan/recipe system removed |
| `request-plan.list` | Plan/recipe system removed |
| `recipe.write` | Plan/recipe system removed |
| `recipe.get` | Plan/recipe system removed |
| `recipe.list` | Plan/recipe system removed |
| `recipe.run` | Plan/recipe system removed |
| `auth-recipe.write` | Plan/recipe system removed |
| `auth-recipe.get` | Plan/recipe system removed |
| `auth-recipe.list` | Plan/recipe system removed |
| `auth-recipe.run` | Plan/recipe system removed |
| `request.execute` | Plan/recipe system removed |
| `network.tag` | Internal bookkeeping |
| `network.clear` | Internal bookkeeping |
| `network.minimize` | Agents reason about params natively |
| `network.diff` | Agents compare text natively |
| `network.probe` | `replay` handles transport automatically |
| `inspect.cookies` | Superseded by `session.cookies` |
| `inspect.storage` | Superseded by `session.storage` |
| `reverse.discover` | Complex pipeline, replaced by discovery flow |
| `reverse.query` | Complex pipeline, replaced by discovery flow |
| `reverse.package.create` | Complex pipeline |
| `reverse.package.run` | Complex pipeline |
| `reverse.package.get` | Complex pipeline |
| `reverse.package.list` | Complex pipeline |
| `reverse.package.patch` | Complex pipeline |
| `reverse.export` | Complex pipeline |
| `reverse.report` | Complex pipeline |

---

## 3. The `--input-json` / `opensteer run` Removal

### Current state

Every operation accepts `--input-json` as a universal escape hatch. If set,
it overrides all dedicated flags. The `opensteer run <operation>` command is
advertised in `--help` and passes everything through `--input-json`.

### Problems

1. **Two ways to do the same thing.** Agent sees `opensteer click --element 5`
   AND `opensteer run dom.click --input-json '{"target":{"kind":"element","element":5}}'`.
   Both work. The agent doesn't know which to prefer.

2. **JSON string escaping on command line.** Constructing JSON as a CLI string
   argument is error-prone: nested quotes, special characters, escaping.

3. **Exposes internal operations.** `opensteer run` accepts ANY operation name,
   including deprecated ones, internal ones, and complex ones the agent
   shouldn't use.

4. **Output bypass.** `opensteer run` sets `asJson = true` in
   `renderOperationOutput`, so it dumps raw JSON instead of using the
   agent-friendly formatters.

5. **Silent flag override.** When `--input-json` is present, it completely
   bypasses all dedicated flag parsing via an early return in
   `buildOperationInput`. Flags like `--element`, etc. are silently ignored.

### Resolution: Remove `--input-json` entirely

**Delete the flag, the option definition, and the early-return override in
`buildOperationInput`.** Keep `readJsonObject` — it's still used by
`--body`, `--variables`, and `--context`.

Rationale for full removal over "keep as undocumented escape hatch":

- **No testing use case.** The one test that uses it
  (`cli-v2.test.ts` -- `opensteer run network.query --input-json '{}'`) is
  trivially rewritten to `opensteer network query --workspace ...`. SDK tests
  should use `runtime.dispatch()` directly, not shell out with escaped JSON.

- **No debugging use case.** `opensteer click 5` is faster to type
  than `opensteer run dom.click --input-json '{"target":{"kind":"element","element":5}}'`.
  Every agent-facing operation now has dedicated flags/positional args.

- **Dead code is not "free".** The `if (inputJson) return inputJson` early
  return in `buildOperationInput` adds a branch to every operation's input
  path. The option definition and early-return logic are code that must be
  understood and maintained.

- **Undocumented escape hatches get rediscovered.** If the code exists, an
  agent or user will eventually find it.

**Also remove `opensteer run` from `--help`.** The `run` subcommand can be
kept for internal development, but operations invoked via `run` should use
their standard input building, not a JSON bypass.

### Code changes

- Delete the `--input-json` option definition from CLI option parsing
- Delete the early-return override in `buildOperationInput`
- Remove from `--help` output
- Remove from skill docs and reference docs
- Rewrite the one test that uses it (`cli-v2.test.ts`) to use dedicated flags

---

## 4. Flags Removed, Added, and Changed

### Flags removed from CLI entirely

| Flag | Commands | Reason |
|---|---|---|
| `--selector <css>` | click, hover, input, scroll | Agents target by element number only |
| `--description <text>` | click, hover, input, scroll | Agents target by element number only |
| `--element <n>` | click, hover, input | Became positional first arg |
| `--text <value>` | input | Became positional second arg |
| `--direction <dir>` | scroll | Became positional first arg |
| `--amount <n>` | scroll | Became positional second arg |
| `--description <text>` | extract | Replaced by `--persist <name>` |
| `--domain <domain>` | cookies, storage, state | Became optional positional first arg |
| `--input-json` | all | Removed entirely (see Section 3) |
| `--schema-json` | extract | Replaced by positional schema input |

### Flags added

| Flag | Commands | Type | Purpose |
|---|---|---|---|
| `--persist <name>` | click, hover, input, scroll | string | Cache element's structural path under this name for deterministic SDK replay. Element number is still required — persist is save-only, not a targeting mode. |
| `--button <btn>` | click | `left\|middle\|right` | Mouse button (default: left). Supports right-click. |
| `--count <n>` | computer click | number | Click count (for double-click) |
| `--modifiers <list>` | computer click, computer key | comma-separated | `Shift,Control,Alt,Meta` |
| `--dx <n>` | computer scroll | number | Horizontal scroll delta |
| `--dy <n>` | computer scroll | number | Vertical scroll delta |
| `--steps <n>` | computer drag | number | Drag interpolation steps |
| `--format <fmt>` | computer screenshot | `png\|jpeg\|webp` | Screenshot format |
| `--method <m>` | fetch | string | HTTP method (default: GET) |
| `--header <k=v>` | fetch | repeatable key=value | HTTP headers |
| `--query <k=v>` | fetch | repeatable key=value | Query parameters |
| `--body <json>` | fetch | JSON string | Request body (JSON) |
| `--body-text <text>` | fetch | string | Request body (raw text) |
| `--transport <t>` | fetch | `auto\|direct\|matched-tls\|page` | Transport layer |
| `--cookies` | fetch | boolean | Include browser cookies |
| `--follow-redirects` | fetch | boolean | Follow HTTP redirects |
| `--provider <p>` | captcha solve | `2captcha\|capsolver` | CAPTCHA service |
| `--api-key <key>` | captcha solve | string | CAPTCHA service API key |
| `--type <t>` | captcha solve | `recaptcha-v2\|hcaptcha\|turnstile` | CAPTCHA type |
| `--site-key <key>` | captcha solve | string | CAPTCHA site key |
| `--page-url <url>` | captcha solve | string | CAPTCHA page URL |
| `--url-filter <pattern>` | scripts capture | string | Filter scripts by URL |
| `--inline` | scripts capture | boolean | Include inline scripts |
| `--external` | scripts capture | boolean | Include external scripts |
| `--dynamic` | scripts capture | boolean | Include dynamic scripts |
| `--workers` | scripts capture | boolean | Include worker scripts |
| `--fidelity <f>` | scripts sandbox | `minimal\|standard\|full` | Sandbox fidelity |
| `--clock <mode>` | scripts sandbox | `real\|manual` | Clock mode |
| `--globals <json>` | scripts sandbox | JSON string | Global variables |
| `--ajax-routes <json>` | scripts sandbox | JSON string | Mock AJAX routes |
| `--key <name>` | interaction capture | string | Interaction key |
| `--duration <ms>` | interaction capture | number | Capture duration |
| `--script <js>` | interaction capture | string | Script to run during capture |
| `--include-storage` | interaction capture | boolean | Capture localStorage |
| `--include-session-storage` | interaction capture | boolean | Capture sessionStorage |
| `--include-indexed-db` | interaction capture | boolean | Capture IndexedDB |
| `--global-names <list>` | interaction capture | comma-separated | Global variables to capture |
| `--case-id <id>` | interaction capture | string | Test case identifier |
| `--notes <text>` | interaction capture | string | Notes |
| `--tags <list>` | interaction capture | comma-separated | Tags |

### Flag renames

| Old | New | Reason |
|---|---|---|
| `--schema-json <json>` | positional `<schema>` | schema is the primary input, not a flag |

### JSON flag values (exhaustive list)

These are the ONLY flags in the entire CLI that accept JSON strings. JSON
is used because these values are inherently unstructured (maps, arrays of
objects, schemas):

| Flag | Command | Why JSON |
|---|---|---|
| `--body` | fetch, replay | HTTP request bodies are inherently JSON |
| positional `<schema>` | extract | extraction schema JSON |
| `--variables` | replay | Arbitrary key-value overrides |
| `--cookies` | scripts sandbox | Arbitrary key-value map |
| `--globals` | scripts sandbox | Arbitrary key-value map |
| `--ajax-routes` | scripts sandbox | Array of route objects |

---

## 5. Command Reference (Complete)

Every command with its exact syntax. This is what `--help` should teach agents.

### Session

```
opensteer open <url> [--headless] [--provider local|cloud]
opensteer close
opensteer status
```

### Navigation

```
opensteer goto <url> [--capture-network <label>]
```

### DOM

```
opensteer snapshot [action|extraction]
opensteer click <element> [--button left|middle|right] [--persist <name>] [--capture-network <label>]
opensteer hover <element> [--persist <name>] [--capture-network <label>]
opensteer input <element> <text> [--press-enter] [--persist <name>] [--capture-network <label>]
opensteer scroll <direction> <amount> [--element <n>] [--persist <name>] [--capture-network <label>]
opensteer extract <schema> [--persist <name>]
opensteer evaluate <script>
opensteer init-script <script>
```

### Tabs

```
opensteer tab list
opensteer tab new [url]
opensteer tab <n>
opensteer tab close [n]
```

### Network (reverse engineering)

```
opensteer network query [--capture <label>] [--url <pattern>] [--hostname <host>] [--path <path>] [--method <m>] [--status <code>] [--type <resourceType>] [--json] [--before <id>] [--after <id>] [--limit <n>]
opensteer network detail <recordId>
opensteer replay <recordId> [--query key=value ...] [--header key=value ...] [--body <json>] [--variables <json>]
opensteer fetch <url> [--method POST] [--header key=value ...] [--query key=value ...] [--body <json>] [--body-text <text>] [--transport auto|direct|matched-tls|page] [--cookies] [--follow-redirects]
```

### Browser state

```
opensteer cookies [domain]
opensteer storage [domain]
opensteer state [domain]
```

### Computer (coordinate-based automation)

```
opensteer computer click <x> <y> [--button left|right] [--count <n>] [--modifiers Shift,Control,...] [--capture-network <label>]
opensteer computer type <text> [--capture-network <label>]
opensteer computer key <key> [--modifiers Shift,Control,...] [--capture-network <label>]
opensteer computer scroll <x> <y> --dx <n> --dy <n> [--capture-network <label>]
opensteer computer move <x> <y> [--capture-network <label>]
opensteer computer drag <x1> <y1> <x2> <y2> [--steps <n>] [--capture-network <label>]
opensteer computer screenshot [--format png|jpeg|webp]
opensteer computer wait <ms>
```

### CAPTCHA

```
opensteer captcha solve --provider 2captcha|capsolver --api-key <key> [--type recaptcha-v2|hcaptcha|turnstile] [--site-key <key>] [--page-url <url>] [--timeout <ms>]
```

### Scripts

```
opensteer scripts capture [--url-filter <pattern>] [--persist] [--inline] [--external] [--dynamic] [--workers]
opensteer scripts beautify <artifactId> [--persist]
opensteer scripts deobfuscate <artifactId> [--persist]
opensteer scripts sandbox <artifactId> [--fidelity minimal|standard|full] [--timeout <ms>] [--clock real|manual] [--cookies <json>] [--globals <json>] [--ajax-routes <json>]
```

### Interaction

```
opensteer interaction capture [--key <name>] [--duration <ms>] [--script <js>] [--include-storage] [--include-session-storage] [--include-indexed-db] [--global-names <list>] [--case-id <id>] [--notes <text>] [--tags <list>]
opensteer interaction get <traceId>
opensteer interaction replay <traceId>
opensteer interaction diff <leftTraceId> <rightTraceId>
```

### Artifacts

```
opensteer artifact read <artifactId>
```

### Global options

```
--workspace <id>        Required for all stateful commands (or set OPENSTEER_WORKSPACE)
--capture-network <l>   Record network traffic during an action
--help, --version
```

`--provider` and `--headless` are `open`-specific, not global.

---

## 6. Reverse Engineering API Workflow Verification

The core reverse engineering flow is: browse → capture traffic → identify API
→ replay with overrides. Every step must work without `--input-json`.

### Step 1: Open browser and navigate

```
opensteer open https://target.com --headless
opensteer goto https://target.com/s/laptop --capture-network search
```

Both commands use positional URL. `--capture-network` records all traffic
during the navigation into SQLite under the label "search". ✓

### Step 2: Interact to trigger API calls

```
opensteer click 5 --capture-network after-click
opensteer input 3 "laptop" --press-enter --capture-network search-submit
opensteer scroll down 3 --capture-network scroll-load
```

Element targeting by number (positional). `--capture-network` on each action
records traffic triggered by that interaction. ✓

### Step 3: Query captured traffic

```
opensteer network query --capture search --url redsky --type fetch --json
opensteer network query --capture search --method POST --status 200
opensteer network query --capture search --hostname api.target.com --limit 10
```

All 11 filter flags are scalar. No JSON needed. The `--json` flag filters
to `content-type: application/json` responses only (shorthand for the most
common API-discovery filter). Output is plaintext: 2-3 lines per record
with recordId, method, status, resource type, URL, body size. Use
`network detail <recordId>` for full headers and body. ✓

### Step 4: Inspect a specific record

```
opensteer network detail rec:abc123
```

Positional recordId. Output shows full headers (key-value plaintext), decoded
body preview (truncated JSON), cookies, and timing. ✓

### Step 5: Replay with overrides

```
opensteer replay rec:abc123 --query keyword=headphones --query count=10
opensteer replay rec:abc123 --header Auth="Bearer newtoken"
opensteer replay rec:abc123 --body '{"query":"laptop","page":2}'
opensteer replay rec:abc123 --variables '{"keyword":"headphones"}'
```

Positional recordId. `--query` and `--header` are repeatable `key=value` flags.
`--body` and `--variables` take JSON strings (inherently unstructured). ✓

### Step 6: Direct HTTP fetch (alternative to replay)

```
opensteer fetch https://api.target.com/v1/search --method POST --header Accept=application/json --header Auth="Bearer tok" --body '{"q":"laptop"}' --cookies
```

Positional URL. Repeatable `--header`. `--body` for the request body.
`--cookies` boolean to include browser cookies. `--transport` to control
how the request is made (direct HTTP vs browser context). ✓

### Step 7: Inspect browser state

```
opensteer cookies .target.com
opensteer storage .target.com
opensteer state .target.com
```

Optional positional domain filter. ✓

**All 7 steps work with zero JSON input blobs.** JSON appears only as specific
flag values for request bodies (`--body`) and variable maps (`--variables`).

---

## 7. Output Format and Filtering

### Principle

Small structured outputs → **filtered JSON** (strip internal refs).
Large/scannable outputs → **plaintext** (token-efficient, agent-native).

### JSON outputs (filter, don't reformat)

**`session.open` / `page.goto`** — drop internal refs:

```json
{ "url": "https://www.target.com/s/laptop", "title": "laptop : Target" }
```

Drop: `sessionRef`, `pageRef`. Agent uses workspace, not these refs.

**`dom.click` / `dom.hover` / `dom.input` / `dom.scroll`** — flatten, drop refs:

```json
{
  "tagName": "BUTTON",
  "pathHint": "button#submit",
  "point": { "x": 245, "y": 380 },
  "persisted": "submit button"
}
```

Drop: `pageRef`, `frameRef`, `documentRef`, `documentEpoch`, `nodeRef`,
`selectorUsed`. Flatten `target.*` to top level. Show `persisted` only when
`--persist` was used.

For `dom.input`, also include `text`. For `dom.scroll`, include `direction`
and `amount`.

**`dom.extract`** — unwrap, return data directly:

```json
{ "price": "$499.99", "title": "HP Laptop 15.6\"" }
```

**`session.close`** — already minimal: `{ "closed": true }`

**`browser status`** — stripped (no WebSocket endpoint, no paths):

```json
{ "mode": "persistent", "workspace": "target-search", "engine": "playwright", "live": true }
```

### Plaintext outputs (already implemented)

| Operation | Format | Why plaintext |
|---|---|---|
| `page.snapshot` | Raw HTML string | HTML is text; JSON wrapping adds noise |
| `network.query` | 2-3 line record summaries | 20-50 records, agent scans visually |
| `network.detail` | Headers + cookies + body preview | Mixed format |
| `network.replay` | Transport + status + body preview | Mixed format |
| `session.cookies` | Tabular cookie list | Tabular data |
| `session.storage` | Key-value pairs | Simple list |
| `session.state` | Combined sections | Multiple types |

### Formatters to implement

| Formatter | Operations | What it does |
|---|---|---|
| `formatNavigationOutput` | `session.open`, `page.goto` | Drop refs, return `{ url, title }` |
| `formatActionOutput` | `dom.click`, `dom.hover`, `dom.input`, `dom.scroll` | Drop refs, flatten target, include `persisted` when set |
| `formatExtractOutput` | `dom.extract` | Unwrap `{ data: }`, return data directly |
| `formatFetchOutput` | `session.fetch` | Status + content-type + truncated body (same as replay) |
| `formatComputerOutput` | `computer.execute` | Action summary + screenshot path if captured |
| `formatTabOutput` | `page.list`, `page.new`, `page.activate`, `page.close` | Tab list: numbered index, URL, title, active marker. `tab <n>` uses these indices. |

---

## 8. `--persist` Flag

### Purpose

Save an element's structural DOM path under a name in the workspace registry.
This enables the SDK to replay actions against the same element deterministically,
even after page navigations.

### CLI behavior

**Element number is always required.** `--persist` is save-only — it does not
enable targeting by name from CLI.

```
opensteer click 5 --persist "submit button"
opensteer input 3 "laptop" --persist "search input" --press-enter
opensteer hover 7 --persist "cart icon"
```

### What gets cached

When `--persist` is provided:

1. The element (targeted by number) is resolved in the current DOM
2. A stable `ReplayElementPath` is built (structural path through the DOM tree,
   handles iframes, shadow DOM, sibling positioning)
3. The path is stored in the workspace registry:
   `<workspace>/registry/descriptors/` keyed by
   `dom:<namespace>:<method>:SHA256(<name>)`
4. The cache survives page navigations, reloads, and session restarts
   (workspace-scoped filesystem storage)

### SDK usage

The public SDK exposes direct methods on the `Opensteer` class:
`opensteer.click()`, `opensteer.hover()`, `opensteer.input()`,
`opensteer.scroll()`. (Also available via `opensteer.dom.*` which
proxies to the same methods.)

The `persist` field does double duty — it's both save and resolve:

```typescript
// Save: click element 5, persist its path as "submit button"
await opensteer.click({ element: 5, persist: "submit button" })

// Resolve: look up "submit button" from workspace cache, click it
await opensteer.click({ persist: "submit button" })
```

When `persist` is used with `element` (or `selector`), it saves the
element's structural path under that name. When used alone, it resolves
from the cache — looks up the stored `ReplayElementPath` by name hash,
takes a fresh DOM snapshot, walks the path, returns the element.

This resolve mode is SDK-only — the CLI always requires element numbers
and `--persist` is save-only.

### Output

When `--persist` is used, the action output includes the persisted name:

```json
{
  "tagName": "BUTTON",
  "pathHint": "button#submit",
  "point": { "x": 245, "y": 380 },
  "persisted": "submit button"
}
```

---

## 9. `browser` Subcommands

### Current

| Command | Purpose |
|---|---|
| `browser status` | Show workspace browser state |
| `browser clone` | Clone a Chrome profile |
| `browser reset` | Reset workspace browser data |
| `browser delete` | Delete workspace entirely |
| `browser discover` | Find running Chrome instances |
| `browser inspect` | Connect to CDP endpoint (leaked WS!) |

### Changes

**Remove from help: `discover`, `inspect`.** Debugging tools. `inspect`
leaked the WebSocket endpoint. `discover` scans for running browsers.

**Keep in help but secondary: `clone`, `reset`, `delete`.** Workspace
management, useful but not daily.

**`browser status` outputs filtered version only** — no endpoint, no paths:

```json
{ "mode": "persistent", "workspace": "target-search", "engine": "playwright", "live": true }
```

---

## 10. Help Output

### What agents see when they run `--help`

```
Opensteer CLI

Session:
  open <url> [--headless] [--provider local|cloud]
  close
  status

Navigation:
  goto <url> [--capture-network <label>]

DOM:
  snapshot [action|extraction]
  click <element> [--persist <name>] [--capture-network <label>]
  hover <element> [--persist <name>] [--capture-network <label>]
  input <element> <text> [--press-enter] [--persist <name>] [--capture-network <label>]
  scroll <direction> <amount> [--element <n>] [--persist <name>] [--capture-network <label>]
  extract <schema> [--persist <name>]
  evaluate <script>

Tabs:
  tab list
  tab new [url]
  tab <n>
  tab close [n]

Network:
  network query [--capture <label>] [--url <pattern>] [--method <m>] [--status <code>] [--type <t>] [--json] [--limit <n>] [filters...]
  network detail <recordId>
  replay <recordId> [--query k=v ...] [--header k=v ...] [--body <json>] [--variables <json>]
  fetch <url> [--method POST] [--header k=v ...] [--body <json>] [--cookies] [--transport auto|direct|matched-tls|page]

Browser state:
  cookies [domain]
  storage [domain]
  state [domain]

Computer (coordinate-based):
  computer click <x> <y>      computer type <text>       computer key <key>
  computer scroll <x> <y> --dy <n>     computer move <x> <y>
  computer drag <x1> <y1> <x2> <y2>   computer screenshot   computer wait <ms>

Advanced:
  captcha solve --provider <p> --api-key <key> [--type <t>] [--site-key <k>]
  scripts capture [--url-filter <p>]   scripts beautify <id>   scripts deobfuscate <id>   scripts sandbox <id>
  interaction capture [--key <name>]   interaction get <id>    interaction replay <id>
  init-script <script>                 artifact read <id>

Options:
  --workspace <id>        Required (or set OPENSTEER_WORKSPACE)
  --capture-network <l>   Record network traffic during an action
  --help, --version
```

The help is tiered: core workflow commands on top (what agents use 90% of the
time), computer and advanced commands below. An agent doing API reverse
engineering reads the first 4 sections and has everything it needs.

### Removed from help

| Removed | Reason |
|---|---|
| `opensteer run <operation>` | Removed along with `--input-json` |
| `opensteer record` | Interactive recording, not agent workflow |
| `opensteer skills install` | Setup command, not runtime |
| `browser discover/inspect` | Debugging tools, leaked WS endpoint |
| "Common options" dump | Was a confusing flat list of 30+ flags |
| `--input-json` | Removed entirely from code |
| `--selector`, `--description` | Removed entirely from code |
| `--context` | Advanced browser context config |
| Cloud-specific flags | Only relevant for cloud users |
| `--engine` | Default is playwright, rarely changed |
| `--attach-endpoint/header` | Advanced attach mode |
| `--fresh-tab` | Advanced attach mode |
| `--executable-path` | Advanced launch config |
| `--arg` | Advanced launch config |
| `--timeout-ms` | Advanced launch config |

---

## 11. SDK Compatibility

### Rename: `description` → `persist`

The "description" concept is renamed to "persist" throughout the public SDK,
protocol types, and runtime internals. This is a breaking change.

**Public SDK API change:**

Before:
```typescript
await opensteer.click({ element: 5, description: "submit button" })  // save
await opensteer.click({ description: "submit button" })              // resolve
```

After:
```typescript
await opensteer.click({ element: 5, persist: "submit button" })  // save
await opensteer.click({ persist: "submit button" })              // resolve
```

**Protocol type renames:**

| Before | After |
|---|---|
| `OpensteerTargetByDescription` | `OpensteerTargetByPersist` |
| `kind: "description"` | `kind: "persist"` |
| `description: string` (on target) | `name: string` |
| `persistAsDescription: string` (on action inputs) | `persist: string` |
| `description` field in `OpensteerTargetOptions` (SDK) | `persist` |

**Internal rename in `normalizeTargetOptions()`:**

The SDK's `normalizeTargetOptions()` function currently maps:
- `{ description: "...", element: N }` → `target: { kind: "element", element: N }, persistAsDescription: "..."`
- `{ description: "..." }` → `target: { kind: "description", description: "..." }`

After rename:
- `{ persist: "...", element: N }` → `target: { kind: "element", element: N }, persist: "..."`
- `{ persist: "..." }` → `target: { kind: "persist", name: "..." }`

The resolution flow is unchanged — `SHA256(name) + workspace + method` →
stored `ReplayElementPath` → walk current DOM → element found.

### Targeting modes in SDK

After the rename, SDK supports three targeting modes:

- `{ element: 5 }` — by snapshot element number
- `{ persist: "submit button" }` — by persisted name (workspace hash lookup)
- `{ selector: "#submit" }` — by CSS selector

CLI only exposes element numbers (positional) with optional `--persist` for
caching. `extract` follows the same pattern with positional schema and optional
`--persist`. Persist-based resolve and selector targeting are SDK-only.

### Fields only accessible via SDK

These fields have no CLI path (too complex for flags, or niche enough that
CLI support isn't justified):

| Operation | Field | Type | Reason SDK-only |
|---|---|---|---|
| `page.evaluate` | `args` | `JsonValue[]` | Agent embeds values in script string |
| `page.add-init-script` | `args` | `JsonValue[]` | Agent embeds values in script string |
| `interaction.capture` | `steps` | array of 6-variant union | Agents run individual commands instead |
| `dom.click` | `modifiers` | `("Shift"\|"Control"\|...)\[\]` | Use `computer click` for modifier+click |
| `dom.click` | `clickCount` | number | Use `computer click --count 2` for double-click |
| `session.open` | `context` (deep) | nested stealth/viewport | Advanced browser config |
| `session.open` | `launch` (deep) | nested launch options | Advanced browser config |

---

## 12. Summary: What Changes

### By the numbers

| Metric | Before | After |
|---|---|---|
| CLI commands | 16 + `run` escape hatch | 41 dedicated commands |
| Unique operations with CLI path | 15 | 33 (all exposed operations) |
| Flags removed | — | 10 (selector, description, element→positional, text→positional, etc.) |
| Flags added | — | ~40 (for new command groups) |
| JSON flag values | 0 (everything was `--input-json`) | 6 (scoped to specific params) |
| Operations requiring `--input-json` | 18 | 0 |
| `--input-json` | exists | deleted |

### Code changes required

1. **Delete `--input-json`**: option definition, early-return in
   `buildOperationInput`. Keep `readJsonObject` — it's still used by
   `--body`, `--variables`, and `--context`.
   Rewrite 1 test.

2. **Add `buildOperationInput` cases** for all new commands: tab, computer,
   fetch, captcha, scripts, interaction, artifact, evaluate, init-script.

3. **Make positional**: element on click/hover/input, text on input,
   direction/amount on scroll, schema on extract, domain on
   cookies/storage/state.

4. **Remove from parsing**: `--selector`, `--description` (targeting),
   `--element` (now positional), `--text` (now positional), `--direction`,
   `--amount`, `--domain`.

5. **Add `--persist` flag** to click, hover, input, scroll. Maps to
   `persist` in the operation input.

6. **Add `--button` flag** to click. Maps to `button` in the operation input.

7. **Add workspace env var**: read `OPENSTEER_WORKSPACE` as fallback when
   `--workspace` flag is not provided.

8. **Add output formatters**: `formatNavigationOutput`, `formatActionOutput`,
   `formatExtractOutput`, `formatFetchOutput`, `formatComputerOutput`,
   `formatTabOutput`.

9. **Update help output**: new command groups, remove deprecated commands,
   remove "Common options" dump.

10. **Update skill docs and reference docs**: new command syntax, remove
    `--input-json` examples, remove `opensteer run` examples.

11. **Rename "description" → "persist" across all layers**:

    **Protocol types** (`packages/protocol/src/semantic.ts`):
    - `OpensteerTargetByDescription` → `OpensteerTargetByPersist`
    - `kind: "description"` → `kind: "persist"` in `OpensteerTargetInput` union
    - `description: string` → `name: string` on the persist target variant
    - `persistAsDescription: string` → `persist: string` on all DOM action inputs
      (click, hover, input, scroll)

    **Public SDK** (`packages/opensteer/src/sdk/opensteer.ts`):
    - `description` field in `OpensteerTargetOptions` → `persist`
    - `description` field in `OpensteerClickOptions` → `persist` (inherited)
    - `description` field in `OpensteerInputOptions` → `persist` (inherited)
    - `description` field in `OpensteerScrollOptions` → `persist` (inherited)
    - Update `normalizeTargetOptions()` to map `persist` → `kind: "persist"` / `persist`

    **Runtime** (`packages/runtime-core/src/sdk/runtime.ts`):
    - Update `toDomTargetRef()` to handle `kind: "persist"`
    - Update `prepareDomTarget()` to read `persist` instead of `persistAsDescription`

    **Descriptor store** (`packages/runtime-core/src/runtimes/dom/`):
    - Update key generation if it references "description" in key names
    - Update `DomDescriptorRecord` type if it has a `description` field

    **Tests**: Update all tests referencing `description`, `persistAsDescription`,
    `kind: "description"` to use new names
