# Opensteer

Opensteer is a small runtime for agent-controlled browsers and local tool execution.

It lets agents:

- control a local or remote browser through Chrome DevTools Protocol;
- run local Python snippets with browser helpers already imported;
- call your local Python functions as task tools from a harness pack;
- install generic browser interaction skills for common web mechanics.

Opensteer stays generic. Your project or harness pack owns domain-specific tools,
selectors, workflows, storage, setup, and agent instructions.

## Install

```bash
uv tool install opensteer
opensteer skills install
opensteer --setup
```

Or:

```bash
curl -fsSL https://opensteer.com/install.sh | sh
```

## Use

```bash
opensteer -c "print(page_info())"
```

Python snippets run locally and start the daemon on demand:

```bash
opensteer -c "new_tab('https://example.com'); wait_for_load(); print(page_info())"
```

Import the same helpers from local code:

```python
from opensteer.helpers import goto_url, js, click_at_xy, type_text, wait_for_load
```

Useful helpers include:

- `goto_url(url)`
- `page_info()`
- `capture_screenshot(path)`
- `click_at_xy(x, y)`
- `type_text(text)`
- `press_key(key)`
- `js(expression)`
- `cdp("Domain.method", ...)`
- `new_tab(url)`
- `list_tabs()`

## Local Tools

Opensteer can run local code that agents use as tools. Put project-specific
functions in your own harness pack, then call Opensteer helpers from those
functions.

```python
from opensteer.helpers import goto_url, js, wait_for_load

def read_page_title(url: str) -> str:
    goto_url(url)
    wait_for_load()
    return js("document.title")
```

Do not put secrets, private data, or project-specific workflows in Opensteer
itself. Keep those in the harness pack or the user's local environment.

## Sessions

Route commands to named browser sessions with `OPENSTEER_NAME`:

```bash
OPENSTEER_NAME=work opensteer -c "new_tab('https://example.com')"
```

Attach to an Opensteer Cloud browser when `OPENSTEER_API_KEY` is set:

```bash
opensteer -c "start_remote_daemon('remote', profileId='bp_...')"
OPENSTEER_NAME=remote opensteer -c "print(page_info())"
```

## Agent Skills

Install generic browser interaction skills:

```bash
opensteer skills install
```

These cover mechanics such as dialogs, downloads, iframes, screenshots, tabs,
uploads, scrolling, and network requests.

## Development

```bash
uv sync
uv run pytest
uv run ruff check .
```

## Security

Do not commit browser profiles, cookies, local workspaces, `.env` files, API
keys, or generated runtime artifacts. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
