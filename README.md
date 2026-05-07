# Opensteer

Opensteer is a global browser-control runtime for agents and harness packs.

It provides:

- CDP browser helpers
- Local browser attach
- Named browser sessions
- Opensteer Cloud browser attach
- Profile helper functions
- Generic browser interaction skills

Harness packs provide domain-specific tools, selectors, workflows, databases, setup docs, and agent skills.

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

```python
from opensteer.helpers import goto_url, js, click_at_xy, type_text, wait_for_load
```

Named browser sessions are routed with `OPENSTEER_NAME`:

```bash
OPENSTEER_NAME=linkedin opensteer -c "new_tab('https://linkedin.com')"
```

## Harness Packs

Harness packs depend on the installed `opensteer` package. They should not mutate Opensteer runtime files.

A pack can import helpers directly:

```python
from opensteer.helpers import goto_url, js, click_at_xy
```

Or provide a small local shim:

```python
# actions/helpers.py
from opensteer.helpers import *
```

Opensteer stays generic. Pack-specific browser workflows, selectors, API clients, and tools live in the harness pack.
