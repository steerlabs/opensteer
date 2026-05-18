# Opensteer

Opensteer helps AI agents control browsers and use local code as tools. It gives agents a small Python command surface for local Chrome or Edge, Opensteer Cloud browsers, and project-specific automation.

Opensteer handles the browser plumbing: CDP, local and cloud attach, named sessions, screenshots, JavaScript, clicks, typing, scrolling, tabs, and reusable interaction skills. The agent's working directory supplies the specialized behavior through Markdown instructions, selectors, data, and custom functions.

## Install

```bash
curl -fsSL https://opensteer.com/install.sh | sh
```

## What Opensteer Does

Opensteer lets an agent drive a browser through short Python snippets:

```bash
opensteer -c "print(page_info())"
```

Python snippets run with Opensteer's browser helpers available, so an agent can navigate, inspect, click, type, scroll, capture screenshots, evaluate JavaScript, and call raw CDP methods without building its own browser bridge.

```bash
opensteer -c "new_tab('https://example.com'); wait_for_load(); print(page_info())"
```

Reusable code can import the helpers directly:

```python
from opensteer.helpers import goto_url, js, click_at_xy, type_text, wait_for_load
```

Named browser sessions are routed with `OPENSTEER_NAME`, which lets different agents or workflows keep separate browser state:

```bash
OPENSTEER_NAME=linkedin opensteer -c "new_tab('https://linkedin.com')"
```

Opensteer can also attach to a cloud browser when `OPENSTEER_API_KEY` is configured:

```bash
opensteer -c "start_remote_daemon('research', profileId='bp_...')"
OPENSTEER_NAME=research opensteer -c "new_tab('https://example.com')"
```

## Specialized Harnesses

A specialized harness is a project directory that makes an agent useful for a specific workflow. It can include Markdown instructions, selectors, data, API clients, and Python functions for repeated actions.

For example:

```text
support-harness/
  AGENTS.md
  tools.py
  selectors.py
  data/
```

`AGENTS.md` tells the agent how the workflow works. `tools.py` exposes actions the agent can call:

```python
# tools.py
from opensteer.helpers import goto_url, js, type_text, wait_for_load


def open_customer(customer_id):
    goto_url(f"https://support.example.com/customers/{customer_id}")
    wait_for_load()
    return js("document.title")
```

When the agent runs from that directory, local imports work like normal Python imports:

```bash
cd support-harness
opensteer -c "from tools import open_customer; print(open_customer('cus_123'))"
```

That is the core pattern: Opensteer provides browser control, and the current directory provides the domain-specific instructions and tools.

If your tools live in a subdirectory, add it to the import path:

```text
support-harness/
  AGENTS.md
  actions/
    helpers.py
```

```bash
cd support-harness
opensteer -c "import sys; sys.path.insert(0, 'actions'); from helpers import open_customer; print(open_customer('cus_123'))"
```

## What Belongs Where

Opensteer owns the browser layer: the daemon, CDP transport, helper functions, local and cloud attach, named sessions, profile helpers, and generic interaction skills.

Harnesses own the workflow layer: selectors, local functions, data files, API clients, and Markdown instructions for a specific site, product, or business process.

This keeps Opensteer reusable while letting each workspace become specialized. A sales harness, QA harness, and data-entry harness can all expose different tools while sharing the same browser primitives.

## Verify

```bash
opensteer --doctor
opensteer -c "print(page_info())"
```

If local browser attach needs setup:

```bash
opensteer --setup
```

Opensteer will guide Chrome or Edge through enabling remote debugging for the current profile.
