# CLI Reference

The `opensteer` CLI runs a per-session local daemon and returns JSON on stdout
for browser/session commands. `opensteer skills ...` is an installer workflow
that streams human-readable output from the wrapped upstream `skills` CLI.

## Session and Namespace Model

- `--session` / `OPENSTEER_SESSION`: runtime routing (which daemon/browser to use)
- `--name` / `OPENSTEER_NAME`: selector cache namespace (applies on `open`)

If `--session` is omitted:

- Interactive terminal: Opensteer creates/reuses a terminal-scoped default.
- Non-interactive mode: set `OPENSTEER_SESSION` or `OPENSTEER_CLIENT_ID`.

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

## Global Flags

- `--session <id>`
- `--name <namespace>`
- `--headless`
- `--connect-url <url>`
- `--channel <browser>`
- `--profile-dir <path>`
- `--element <N>`
- `--selector <css>`
- `--description <text>`

## Environment Variables

- `OPENSTEER_SESSION`: runtime session id
- `OPENSTEER_CLIENT_ID`: stable identity for default session binding
- `OPENSTEER_NAME`: default selector namespace for `open`
- `OPENSTEER_MODE`: `local` (default) or `cloud`
- `OPENSTEER_API_KEY`: required in cloud mode
- `OPENSTEER_BASE_URL`: cloud control-plane base URL
- `OPENSTEER_AUTH_SCHEME`: `api-key` (default) or `bearer`
- `OPENSTEER_REMOTE_ANNOUNCE`: `always` (default), `off`, or `tty`
