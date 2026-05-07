---
name: opensteer
description: Direct browser control via CDP. Use when the user wants to automate, inspect, scrape, test, or interact with web pages.
---

# Opensteer

Opensteer is a global browser-control runtime. It exposes small CDP primitives to agents and harness packs.

## Usage

```bash
opensteer -c "print(page_info())"
```

Python snippets run with helpers pre-imported:

```bash
opensteer -c "new_tab('https://docs.opensteer.com'); wait_for_load(); print(page_info())"
```

For harness code, import helpers from the installed package:

```python
from opensteer.helpers import goto_url, js, click_at_xy, type_text, wait_for_load
```

## Named Sessions

Use `OPENSTEER_NAME` to route commands to a named browser session:

```bash
OPENSTEER_NAME=linkedin opensteer -c "print(page_info())"
```

Remote browser sessions can be started from a Python snippet when `OPENSTEER_API_KEY` is set:

```bash
opensteer -c "start_remote_daemon('linkedin', profileId='bp_...')"
OPENSTEER_NAME=linkedin opensteer -c "new_tab('https://example.com')"
```

## Interaction Skills

Generic browser mechanics live in `interaction-skills/`:

- connection.md
- cookies.md
- cross-origin-iframes.md
- dialogs.md
- downloads.md
- drag-and-drop.md
- dropdowns.md
- iframes.md
- network-requests.md
- print-as-pdf.md
- screenshots.md
- scrolling.md
- shadow-dom.md
- tabs.md
- uploads.md
- viewport.md

Use them when a page mechanic is tricky. Put domain-specific selectors, workflows, APIs, local databases, and task tools in the harness pack.

## What Works Well

- Start with screenshots for visible state: `capture_screenshot()`.
- Prefer coordinate clicks for visible targets: `click_at_xy(x, y)`.
- Use `js(...)` for DOM inspection, extraction, and page API discovery.
- Use `cdp("Domain.method", ...)` for raw CDP operations not covered by helpers.
- After navigation, call `wait_for_load()`.
- For stale or internal tabs, call `ensure_real_tab()`.
- If a page redirects to login, stop and ask the user. Do not type credentials from screenshots.

## Boundaries

Opensteer owns generic browser primitives, local attach, remote attach, cloud browser attach, and generic interaction skills.

Harness packs own domain-specific tools, selectors, workflows, storage, setup docs, and agent skills.
