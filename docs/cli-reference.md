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

Saved machine logins remain scoped per resolved cloud host (`baseUrl` +
`siteUrl`). The CLI remembers the last selected cloud host, so `opensteer auth
status`, `opensteer auth logout`, and other cloud commands reuse it by default
unless `--base-url`, `--site-url`, or env vars select a different host.

## Global Flags

- `--session <id>`
- `--name <namespace>`
- `--headless`
- `--connect-url <url>`
- `--channel <browser>`
- `--profile-dir <path>`
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
- `OPENSTEER_CLOUD_SITE_URL`: cloud site URL for device login endpoints
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
