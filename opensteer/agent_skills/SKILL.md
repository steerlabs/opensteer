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

## Browser Profiles

A browser profile is a saved, logged-in browser identity (cookies, auth state)
a cloud browser can launch with. Profile access is grant-based: the server
tracks which profiles this agent may use, and there is no per-agent default
profile.

- `list_cloud_profiles()` lists visible profiles; each entry carries a
  `granted` flag saying whether this agent may use it.
- `start_remote_daemon(name)` without a profile lets the server resolve it:
  exactly one granted profile auto-attaches, none launches a fresh signed-out
  session, and several granted profiles is rejected with an error telling you
  to pass `profileName` or `profileId`.
- When several profiles are granted, pick one explicitly:
  `start_remote_daemon('linkedin', profileName='LinkedIn work')` or
  `start_remote_daemon('linkedin', profileId='bp_...')`. Durable scripts
  should pin `profileId` — it survives profile renames.
- Passing a profile that is not granted to this agent fails with a 403 whose
  message says how to proceed (list granted profiles or request access).

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
- Navigate the current Opensteer-owned tab by default; use `list_tabs()` and `switch_tab(target_id)` only when the user explicitly asks for a specific existing tab.
- If a page redirects to login, stop and ask the user. Do not type credentials from screenshots.

## Boundaries

Opensteer owns generic browser primitives, local attach, remote attach, cloud browser attach, and generic interaction skills.

Harness packs own domain-specific tools, selectors, workflows, storage, setup docs, and agent skills.
