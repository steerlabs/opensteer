# CLI Reference

The `opensteer` CLI runs a per-session local daemon and returns JSON on stdout
for browser/session commands. `opensteer skills ...` is an installer workflow
that streams human-readable output from the wrapped upstream `skills` CLI.

## Session and Namespace Model

- `--session` / `OPENSTEER_SESSION`: logical session name (daemon routing is
  scoped by canonical `cwd` + logical session)
- `--name` / `OPENSTEER_NAME`: selector cache namespace (applies on `open`)

If `--session` is omitted:

- Interactive terminal: Opensteer creates/reuses a terminal-scoped default.
- Non-interactive mode: set `OPENSTEER_SESSION` or `OPENSTEER_CLIENT_ID`.

### CWD-Scoped Routing

- Daemon reuse now requires both:
  - same logical session name, and
  - same canonical current working directory (`realpath(cwd)`).
- The same logical session name can be active in multiple directories on the
  same machine without collisions.

## Common Flow

```bash
opensteer open https://example.com --session agent-a --name product-scraper
opensteer snapshot --session agent-a
opensteer click 3 --session agent-a
opensteer status --session agent-a
opensteer close --session agent-a
```

## Commands

### Navigation

- `open <url>`
- `navigate <url>`
- `back`
- `forward`
- `reload`
- `close`
- `close --all`
- `sessions`
- `status`

### Observation

- `snapshot [--mode action|extraction|clickable|scrollable|full]`
- `state`
- `cursor [on|off|status]`
- `screenshot [file]`

### Actions

- `click [element]`
- `dblclick [element]`
- `rightclick [element]`
- `hover [element]`
- `input [element] <text>`
- `select [element]`
- `scroll [element]`

### Keyboard

- `press <key>`
- `type <text>`

### Element Info

- `get-text [element]`
- `get-value [element]`
- `get-attrs [element]`
- `get-html [selector]`

### Tabs

- `tabs`
- `tab-new [url]`
- `tab-switch <index>`
- `tab-close [index]`

### Cookies

- `cookies [--url <url>]`
- `cookie-set --name <name> --value <value> [--url ...]`
- `cookies-clear`
- `cookies-export <file>`
- `cookies-import <file>`

### Utility

- `eval <expression>`
- `wait-for <text>`
- `wait-selector <selector>`
- `extract <schema-json>`

### API Reverse Engineering

- `api capture start`
- `api capture stop`
- `api capture status`
- `api span list`
- `api span start --label <label>`
- `api span stop`
- `api request list [--span <@span1>] [--kind candidates|all] [--limit <n>]`
- `api request inspect <@request1> [--body summary|full] [--raw true|false]`
- `api slot list [--request <@request1>] [--span <@span1>]`
- `api slot inspect <@slot1>`
- `api evidence inspect <@slot1|@evidence1>`
- `api value trace <literal|@value1> [--span <@span1>]`
- `api probe run --span <@span1> --values <json-array|csv>`
- `api plan infer --task <task> [--span <@span1>] [--request <@request1>]`
- `api plan inspect <@plan1>`
- `api plan validate <@plan1> [--dry-run] [--inputs <json>]`
- `api plan codegen <@plan1> --lang <ts|py>`
- `api plan render <@plan1> --format <ir|exec|curl-trace>`
- `api plan export <@plan1> --format <ir|exec|curl-trace>`

Capture is session-scoped. Once `api capture start` is active, mutating browser
commands automatically create action spans tied to the request burst they
trigger. Use `api span start/stop` only when you need to bracket work that did
not happen through a normal Opensteer action.

For reliable agent use, the recommended workflow is:
- `api request list --kind candidates`
- `api request inspect <@request>`
- `api slot list --request <@request>`
- `api evidence inspect <@slot>`
- `api plan infer --task ... --request <@request>`
- `api plan validate <@plan> --inputs '{"term":"Ada"}'`
- `api plan render <@plan> --format curl-trace`

`schema-json` describes the output shape, not just selector bindings. Use semantic placeholders like `"string"` with `--description` and `--prompt`, or explicit bindings like `{ "element": 3 }` and `{ "attribute": "href" }` when you want deterministic field mappings.

```bash
opensteer extract '{"images":[{"imageUrl":"string","alt":"string","caption":"string","credit":"string"}]}' \
  --description "article images with captions and credits" \
  --prompt "For each image, return the image URL, alt text, caption, and credit. Prefer caption and credit from the same figure. If missing, look at sibling text, then parent/container text, then nearby alt/data-* attributes."
```

### Skills

- `skills install [options]`
- `skills add [options]` (alias for `skills install`)

Supported options:

- `-a, --agent <agents...>`
- `-g, --global`
- `-y, --yes`
- `--copy`
- `--all`

### Profiles

- `profile list [--json] [--limit <n>] [--status active|archived|error]`
- `profile create --name <name> [--json]`
- `profile sync --from-profile-dir <dir> [--to-profile-id <id> | --name <name>] [--domain <domain> ... | --all-domains] [--dry-run] [--yes] [--json]`

Use `profile list` to inspect available cloud browser profiles, `profile create`
to provision a new reusable profile, and `profile sync` to upload cookies and
other browser state from a local profile directory into a cloud profile before
launch.

### Auth

- `auth login`
- `auth status`
- `auth logout`
- `login` (alias for `auth login`)
- `logout` (alias for `auth logout`)

`opensteer auth login` opens your default browser when possible. Use
`opensteer auth login --no-browser` when you need to copy the printed device
URL into another browser manually. `opensteer auth login --json` keeps prompts
on stderr and writes the final JSON payload to stdout.

Saved machine logins remain scoped per resolved cloud API host (`baseUrl`). The
CLI remembers the last selected cloud host, so `opensteer auth status`,
`opensteer auth logout`, and other cloud commands reuse it by default unless
`--base-url` or env vars select a different host.

## Global Flags

- `--session <id>`
- `--name <namespace>`
- `--headless`
- `--browser <chromium|real>`
- `--profile <name>`
- `--headed`
- `--cdp-url <url>`
- `--user-data-dir <path>`
- `--browser-path <path>`
- `--cloud-profile-id <id>`
- `--cloud-profile-reuse-if-active <true|false>`
- `--api-key <key>`
- `--access-token <token>`
- `--cursor <true|false>`
- `--element <N>`
- `--selector <css>`
- `--description <text>`

## Environment Variables

- `OPENSTEER_SESSION`: logical session id (scoped by canonical `cwd`)
- `OPENSTEER_CLIENT_ID`: stable identity for default session binding
- `OPENSTEER_NAME`: default selector namespace for `open`
- `OPENSTEER_CURSOR`: cursor default for SDK and CLI daemon preference bootstrap
- `OPENSTEER_MODE`: `local` (default) or `cloud`
- `OPENSTEER_API_KEY`: cloud API key credential (best for CI/headless)
- `OPENSTEER_ACCESS_TOKEN`: cloud bearer token credential (from `opensteer auth login`)
- `OPENSTEER_BASE_URL`: cloud control-plane base URL
- `OPENSTEER_AUTH_SCHEME`: `api-key` (default) or `bearer`
- `OPENSTEER_REMOTE_ANNOUNCE`: `always` (default), `off`, or `tty`
- `OPENSTEER_CLOUD_PROFILE_ID`: default cloud browser profile id
- `OPENSTEER_CLOUD_PROFILE_REUSE_IF_ACTIVE`: optional `true`/`false` profile session reuse

Cursor defaults:

- CLI sessions are enabled by default unless overridden by `--cursor` or
  `OPENSTEER_CURSOR`.
- SDK instances default to disabled unless configured via `cursor.enabled`.

Credential precedence for cloud commands:

1. explicit flags (`--api-key` / `--access-token`)
2. environment (`OPENSTEER_API_KEY` / `OPENSTEER_ACCESS_TOKEN`)
3. saved machine login for the resolved host (`opensteer auth login`)
