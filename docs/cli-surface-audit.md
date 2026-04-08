# Opensteer CLI Surface Audit

Full audit of every CLI tool, its inputs, outputs, and what to cut.

---

## 1. Current State: 63 Semantic Operations

The protocol defines 63 operations. Only 31 are "exposed" (public). Only 16
have CLI aliases with dedicated flags.

### Operations with CLI aliases (what agents actually use)

| CLI command | Operation | Dedicated flags |
|---|---|---|
| `open` | `session.open` | positional URL, `--workspace`, `--attach-endpoint`, browser/launch/context flags |
| `goto` | `page.goto` | positional URL, `--capture-network` |
| `snapshot` | `page.snapshot` | positional mode (`action`\|`extraction`) |
| `click` | `dom.click` | `--element`, `--selector`, `--description`, `--capture-network` |
| `hover` | `dom.hover` | `--element`, `--selector`, `--description`, `--capture-network` |
| `input` | `dom.input` | `--element`, `--selector`, `--description`, `--text`, `--press-enter`, `--capture-network` |
| `scroll` | `dom.scroll` | `--element`, `--selector`, `--description`, `--direction`, `--amount`, `--capture-network` |
| `extract` | `dom.extract` | `--description`, `--schema-json` |
| `network query` | `network.query` | `--capture`, `--url`, `--hostname`, `--path`, `--method`, `--status`, `--type`, `--json`, `--before`, `--after`, `--limit` |
| `network detail` | `network.detail` | positional recordId |
| `replay` | `network.replay` | positional recordId, `--query`, `--header`, `--body-json`, `--variables` |
| `cookies` | `session.cookies` | `--domain` |
| `storage` | `session.storage` | `--domain` |
| `state` | `session.state` | `--domain` |
| `close` | `session.close` | none |

Plus non-operation commands: `status`, `record`, `browser *`, `skills install`.

### Exposed operations WITHOUT CLI aliases (input-json only)

| Operation | Category | Used by agents? |
|---|---|---|
| `page.list` | page | Rarely (multi-tab) |
| `page.new` | page | Rarely |
| `page.activate` | page | Rarely |
| `page.close` | page | Rarely |
| `page.evaluate` | page | Sometimes (run JS) |
| `page.add-init-script` | page | Rarely |
| `interaction.capture` | interaction | Never from CLI |
| `interaction.get` | interaction | Never from CLI |
| `interaction.diff` | interaction | Never from CLI |
| `interaction.replay` | interaction | Never from CLI |
| `artifact.read` | artifact | Never from CLI |
| `session.fetch` | session | SDK only |
| `scripts.capture` | scripts | Rarely |
| `scripts.beautify` | scripts | Rarely |
| `scripts.deobfuscate` | scripts | Rarely |
| `scripts.sandbox` | scripts | Rarely |
| `captcha.solve` | captcha | Rarely |
| `computer.execute` | computer | Different paradigm |

### Internal-only operations (not exposed, should be removed from protocol list)

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

## 2. Output Format: JSON vs Plaintext

### Principle

Small, structured outputs stay **JSON** (but filtered to only useful fields).
Large outputs or inherently text-oriented content (HTML, multi-record lists,
headers + body previews, tabular data) go **plaintext**.

### JSON outputs (small structured data -- filter, don't reformat)

**`session.open` / `page.goto`** -- drop internal refs, keep URL + title:

Current:
```json
{
  "sessionRef": "session:abc123",
  "pageRef": "page:def456",
  "url": "https://www.target.com/s/laptop",
  "title": "laptop : Target"
}
```

New:
```json
{
  "url": "https://www.target.com/s/laptop",
  "title": "laptop : Target"
}
```

Drop `sessionRef`, `pageRef`. Agent uses `--workspace`, not these internal
refs. Two fields, clean.

**`dom.click` / `dom.hover` / `dom.input` / `dom.scroll`** -- drop all
`target.*Ref` fields, flatten:

Current:
```json
{
  "target": {
    "pageRef": "page:abc123",
    "frameRef": "frame:def456",
    "documentRef": "doc:ghi789",
    "documentEpoch": 0,
    "nodeRef": "node:jkl012",
    "tagName": "BUTTON",
    "pathHint": "button#submit",
    "description": "submit button",
    "selectorUsed": "#submit"
  },
  "point": { "x": 245, "y": 380 },
  "persistedDescription": "submit button"
}
```

New:
```json
{
  "tagName": "BUTTON",
  "pathHint": "button#submit",
  "point": { "x": 245, "y": 380 },
  "persistedDescription": "submit button"
}
```

Drop: `pageRef`, `frameRef`, `documentRef`, `documentEpoch`, `nodeRef`.
Keep: `tagName`, `pathHint`, `point`, and any of `description`,
`selectorUsed`, `persistedDescription` when present. Flatten `target.*`
to top level.

**`dom.extract`** -- unwrap the `{ data: }` wrapper, return data directly:

Current:
```json
{
  "data": { "price": "$499.99", "title": "HP Laptop 15.6\"" }
}
```

New:
```json
{ "price": "$499.99", "title": "HP Laptop 15.6\"" }
```

Extraction's sole purpose is returning data. The wrapper adds nothing.

**`session.close`** -- already minimal, no change:
```json
{ "closed": true }
```

**`browser status`** -- already filtered in redesign:
```json
{ "mode": "persistent", "workspace": "target-search", "engine": "playwright", "live": true }
```

**`browser reset/delete`** -- already minimal, no change:
```json
{ "reset": true }
```

### Plaintext outputs (large content, scannable lists, mixed text)

These are already implemented and working:

| Operation | Format | Why plaintext |
|---|---|---|
| `page.snapshot` | Raw HTML string | HTML is inherently text; JSON wrapping adds noise |
| `network.query` | 2-3 line record summaries | 20-50 records, agent scans visually |
| `network.detail` | Headers + cookies + body preview | Mixed format: key-value headers, parsed JSON body |
| `network.replay` | Transport + status + body preview | Mixed: status line, transport info, JSON body |
| `session.cookies` | Tabular cookie list | Tabular data with aligned columns |
| `session.storage` | Key-value pairs | Simple key-value list |
| `session.state` | Combined sections | Multiple data types combined |

### Decision rationale

JSON works for small outputs because:
- Agent can reference specific fields programmatically
- Structure is self-describing
- 2-6 fields is easy to scan

Plaintext works for large outputs because:
- Agents are LLMs that read text natively
- No wasted tokens on JSON syntax (`"`, `:`, `{`, `}`, `,`)
- Multi-record lists scan better as lines than as JSON arrays
- HTML should be HTML, not JSON-escaped HTML

---

## 3. Output Filtering: Snapshot

The CLI already returns just the `html` string (the `formatSnapshotOutput`
function extracts it). The `counters[]` array with all its `pageRef`/
`frameRef`/`documentRef`/`documentEpoch`/`nodeRef` fields is NOT included
in CLI output.

**No changes needed.** The html string with `c` attributes is exactly what
agents need.

---

## 4. The `--input-json` / `opensteer run` Problem

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
   `buildOperationInput`. Flags like `--element`, `--selector`, etc. are
   silently ignored. This is a footgun -- the user thinks they're combining
   flags but one path swallows the other.

### Resolution: Remove `--input-json` entirely

**Delete the flag, the option definition, the `readJsonObject` helper (if
nothing else uses it), and the early-return override in `buildOperationInput`.**

Rationale for full removal over "keep as undocumented escape hatch":

- **No testing use case.** The one test that uses it
  (`cli-v2.test.ts` -- `opensteer run network.query --input-json '{}'`) is
  trivially rewritten to `opensteer network query --workspace ...`. SDK tests
  should use `runtime.dispatch()` directly, not shell out with escaped JSON.

- **No debugging use case.** `opensteer click --element 5` is faster to type
  than `opensteer run dom.click --input-json '{"target":{"kind":"element","element":5}}'`.
  Every agent-facing operation has dedicated flags. Internal operations should
  be tested through the SDK, not through CLI escape hatches.

- **Dead code is not "free".** The `if (inputJson) return inputJson` early
  return in `buildOperationInput` adds a branch to every operation's input
  path. The `readJsonObject` helper, JSON parse + validation logic, and the
  option definition are all code that must be understood and maintained. Clean
  code means removing paths nobody uses.

- **Undocumented escape hatches get rediscovered.** If the code exists, an
  agent or user will eventually find it (via `--help` output, source reading,
  or error messages that reference it). The only way to guarantee agents don't
  use it is to delete it.

**Also remove `opensteer run` from `--help`.** Keep the `run` subcommand
itself for now (it's useful for internal operations during development), but
strip `--input-json` from its parsing path too. Operations invoked via `run`
should use their standard input building, not a JSON bypass.

For the one exposed operation that agents occasionally need but lacks an alias
-- `page.evaluate` -- add a dedicated CLI alias:

```
opensteer evaluate --workspace <id> --script "document.title"
```

This closes the last gap. Every agent-facing operation has dedicated flags,
and there is zero reason for `--input-json` to exist.

---

## 5. CLI Surface Simplification

### Current help output issues

The `--help` output currently lists:

1. All 15 aliased commands (good)
2. `opensteer run <semantic-operation>` (bad -- exposes everything)
3. `opensteer record` (niche -- interactive recording)
4. `opensteer skills install` (setup -- not runtime)
5. `opensteer browser *` (5 subcommands, mostly internal)
6. A "Common options" section listing ALL 30+ flags (bad -- mixes flags from
   different commands into one undifferentiated list)

### New help output

```
Opensteer v2 CLI

Session:
  opensteer open <url> --workspace <id>
  opensteer close --workspace <id>
  opensteer status [--workspace <id>]

Navigation:
  opensteer goto <url> --workspace <id> [--capture-network <label>]

DOM:
  opensteer snapshot [action|extraction] --workspace <id>
  opensteer click --workspace <id> (--element <n> | --selector <css> | --description <text>)
  opensteer input --workspace <id> --text <value> (--element <n> | ...) [--press-enter]
  opensteer hover --workspace <id> (--element <n> | ...)
  opensteer scroll --workspace <id> --direction <dir> --amount <n> (--element <n> | ...)
  opensteer extract --workspace <id> --description <text> [--schema <json>]

Network:
  opensteer network query --workspace <id> [--json] [--url <pattern>] [--capture <label>] [filters...]
  opensteer network detail <recordId> --workspace <id>
  opensteer replay <recordId> --workspace <id> [--query key=value ...] [overrides...]

Browser state:
  opensteer cookies --workspace <id> [--domain <domain>]
  opensteer storage --workspace <id> [--domain <domain>]
  opensteer state --workspace <id> [--domain <domain>]

All DOM interactions support --capture-network <label>.

Options:
  --help, --version
  --workspace <id>        Required for all stateful commands
  --capture-network <l>   Record network traffic during an action
  --provider local|cloud  Execution provider (default: local)
  --headless true|false   Run browser headless (default: false)
```

### What changed

| Removed from help | Reason |
|---|---|
| `opensteer run <operation>` | Escape hatch, not for agents |
| `opensteer record` | Interactive recording, not agent workflow |
| `opensteer skills install` | Setup command, not runtime |
| `opensteer browser clone/reset/delete` | Internal workspace management |
| `opensteer browser discover/inspect` | Debugging tools (inspect leaked WS endpoint) |
| "Common options" dump | Replaced with concise, relevant options |
| `--input-json` | Removed entirely -- flag, parser, and override logic deleted |
| `--context-json` | Advanced browser context config |
| `--schema-json` | Renamed to `--schema` (shorter) |
| Cloud-specific flags | 5 flags for cloud provider, only relevant for cloud users |
| `--engine` | Default is playwright, rarely changed |
| `--attach-endpoint/header` | Advanced attach mode |
| `--fresh-tab` | Advanced attach mode |
| `--executable-path` | Advanced launch config |
| `--arg` | Advanced launch config |
| `--timeout-ms` | Advanced launch config |

### Rename `--schema-json` to `--schema`

The `-json` suffix implies "this is JSON" but that's obvious from context.
Every other flag that takes JSON uses a clear name: `--body-json` (because
`--body` could be a string), `--variables` (already implies JSON). For
extract, `--schema` is sufficient and cleaner.

---

## 6. Flag Audit per Command

### `open`

| Flag | Keep? | Notes |
|---|---|---|
| positional `<url>` | yes | |
| `--workspace <id>` | yes | |
| `--attach-endpoint <url>` | remove from help | Advanced, move to undocumented |
| `--attach-header <k=v>` | remove from help | Advanced |
| `--fresh-tab` | remove from help | Advanced |
| `--headless <bool>` | keep in help | Common |
| `--executable-path` | remove from help | Advanced |
| `--arg <value>` | remove from help | Advanced |
| `--timeout-ms <ms>` | remove from help | Advanced |
| `--context-json <json>` | remove from help | Advanced |
| `--provider local\|cloud` | keep in help | Common for cloud users |

New help for open:
```
opensteer open <url> --workspace <id> [--headless true|false]
```

### `click` / `hover`

| Flag | Keep? | Notes |
|---|---|---|
| `--element <n>` | yes | Primary targeting |
| `--selector <css>` | yes | CSS targeting |
| `--description <text>` | yes | NL targeting |
| `--capture-network <label>` | yes | |

No changes needed.

### `input`

| Flag | Keep? | Notes |
|---|---|---|
| `--element <n>` | yes | |
| `--selector <css>` | yes | |
| `--description <text>` | yes | |
| `--text <value>` | yes | Required |
| `--press-enter` | yes | Common |
| `--capture-network <label>` | yes | |

No changes needed.

### `scroll`

| Flag | Keep? | Notes |
|---|---|---|
| `--element <n>` | yes | |
| `--selector <css>` | yes | |
| `--description <text>` | yes | |
| `--direction <dir>` | yes | Required |
| `--amount <n>` | yes | Required |
| `--capture-network <label>` | yes | |

No changes needed.

### `extract`

| Flag | Keep? | Notes |
|---|---|---|
| `--description <text>` | yes | Required |
| `--schema-json <json>` | rename to `--schema` | Cleaner |

### `network query`

Already audited in agent-tooling-redesign.md. 11 flags, all justified.

### `replay`

Already audited. 4 override flags, all justified.

### `cookies` / `storage` / `state`

| Flag | Keep? | Notes |
|---|---|---|
| `--domain <domain>` | yes | Optional filter |

No changes needed.

---

## 7. `browser` Subcommands

### Current

| Command | Purpose |
|---|---|
| `browser status` | Show workspace browser state |
| `browser clone` | Clone a Chrome profile |
| `browser reset` | Reset workspace browser data |
| `browser delete` | Delete workspace entirely |
| `browser discover` | Find running Chrome instances |
| `browser inspect` | Connect to CDP endpoint (this leaked WS!) |

### Recommendation

**Remove from help: `discover`, `inspect`.** These are debugging tools. 
`inspect` is the command that leaked the WebSocket endpoint in the original 
failure. `discover` scans for running browsers, which is an internal concern.

**Keep in help but move to a secondary section: `clone`, `reset`, `delete`.**
These are workspace management, useful but not daily operations.

**Keep `browser status` but only if it outputs the filtered version** (no
endpoint, no paths). Already addressed in agent-tooling-redesign.md.

---

## 8. Complete Output Formatter Map

Operations that need custom formatters (not generic JSON dump):

| Operation | Current formatter | Format | Needed? |
|---|---|---|---|
| `page.snapshot` | `formatSnapshotOutput` (returns html) | plaintext | Done |
| `network.query` | `formatNetworkQueryOutput` | plaintext | Done |
| `network.detail` | `formatNetworkDetailOutput` | plaintext | Done |
| `network.replay` | `formatReplayOutput` | plaintext | Done |
| `session.cookies` | `formatCookiesOutput` | plaintext | Done |
| `session.storage` | `formatStorageOutput` | plaintext | Done |
| `session.state` | `formatStateOutput` | plaintext | Done |
| `session.open` | generic JSON dump | filtered JSON | **Needs formatter** |
| `page.goto` | generic JSON dump | filtered JSON | **Needs formatter** |
| `dom.click` | generic JSON dump | filtered JSON | **Needs formatter** |
| `dom.hover` | generic JSON dump | filtered JSON | **Needs formatter** |
| `dom.input` | generic JSON dump | filtered JSON | **Needs formatter** |
| `dom.scroll` | generic JSON dump | filtered JSON | **Needs formatter** |
| `dom.extract` | generic JSON dump | filtered JSON | **Needs formatter** |
| `session.close` | generic JSON dump | JSON | Already minimal |

### New formatters to implement

**`formatNavigationOutput`** (for `session.open`, `page.goto`):

Strip `sessionRef`, `pageRef`. Return:
```json
{
  "url": "https://www.target.com",
  "title": "Target : Expect More. Pay Less."
}
```

**`formatActionOutput`** (for `dom.click`, `dom.hover`, `dom.input`,
`dom.scroll`):

Strip `pageRef`, `frameRef`, `documentRef`, `documentEpoch`, `nodeRef`.
Flatten `target.*` to top level. Return:
```json
{
  "tagName": "BUTTON",
  "pathHint": "button#submit",
  "point": { "x": 245, "y": 380 },
  "persistedDescription": "submit button"
}
```

For `dom.input`, also include `text` that was typed. For `dom.scroll`,
include `direction` and `amount`.

**`formatExtractOutput`** (for `dom.extract`):

Unwrap the `{ "data": ... }` wrapper. Return the data value directly:
```json
{ "price": "$499.99", "title": "HP Laptop 15.6\"" }
```

---

## 9. Summary: What Changes

### Output formatters to add (3)

| Formatter | Operations | Format | What it does |
|---|---|---|---|
| `formatNavigationOutput` | `session.open`, `page.goto` | JSON | Drop refs, return `{ url, title }` |
| `formatActionOutput` | `dom.click`, `dom.hover`, `dom.input`, `dom.scroll` | JSON | Drop refs, flatten target, return `{ tagName, pathHint, point, ... }` |
| `formatExtractOutput` | `dom.extract` | JSON | Unwrap `{ data: }`, return data directly |

### Help output changes

| Change | Impact |
|---|---|
| Remove `opensteer run` from help | Agents stop discovering the escape hatch |
| Remove `opensteer record` from help | Not agent workflow |
| Remove `opensteer skills install` from help | Not runtime |
| Remove `browser discover/inspect` from help | Debugging tools, leaked WS endpoint |
| Remove "Common options" dump | Was a confusing flat list of 30+ flags |
| Add concise options section | Only workspace, capture-network, provider, headless |
| Rename `--schema-json` to `--schema` | Cleaner |

### Operations to remove from protocol exposed list

| Operation | Reason |
|---|---|
| `interaction.capture` | Complex system agents don't use from CLI |
| `interaction.get` | Complex system agents don't use from CLI |
| `interaction.diff` | Complex system agents don't use from CLI |
| `interaction.replay` | Complex system agents don't use from CLI |
| `artifact.read` | Internal |
| `session.fetch` | SDK-only, not meaningful as CLI command |

### Operations to add CLI alias for

| New alias | Operation | Flags |
|---|---|---|
| `evaluate` | `page.evaluate` | `--script <js>`, `--workspace <id>` |

### `--input-json` removal

- Delete the `--input-json` option definition from CLI option parsing
- Delete the `readJsonObject` helper (if nothing else uses it)
- Delete the early-return override in `buildOperationInput`
- Remove from `--help` output
- Remove from skill docs and reference docs
- Rewrite the one test that uses it (`cli-v2.test.ts`) to use dedicated flags

### Flag rename

| Old | New | Reason |
|---|---|---|
| `--schema-json <json>` | `--schema <json>` | `-json` suffix is redundant |

### CLI tool count (after changes)

| Category | Commands |
|---|---|
| Session | `open`, `close`, `status` |
| Navigation | `goto` |
| DOM | `snapshot`, `click`, `input`, `hover`, `scroll`, `extract` |
| Network | `network query`, `network detail`, `replay` |
| Browser state | `cookies`, `storage`, `state` |
| JS execution | `evaluate` |
| **Total** | **17 commands** |

Everything an agent needs. Nothing it doesn't.
