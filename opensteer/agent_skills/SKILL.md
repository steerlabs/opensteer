---
name: opensteer
description: Direct browser control via CDP. Use when the user wants to automate, inspect, scrape, test, or interact with web pages.
---

# Opensteer

Opensteer is a global browser-control runtime. It exposes small CDP primitives to agents and harness packs.

## Usage

```bash
opensteer -c "open_browser(profile='fresh'); new_tab('https://example.com'); print(page_info())"
```

Python snippets run with helpers pre-imported:

```bash
opensteer -c "new_tab('https://docs.opensteer.com'); wait_for_load(); print(page_info())"
```

For harness code, import helpers from the installed package:

```python
from opensteer.helpers import goto_url, js, click_at_xy, type_text, wait_for_load
```

## Explicit Browser Sessions

For browser work, explicitly choose the browser profile and reuse mode. The returned
handle is bound to exactly one platform session, and its stable identity makes
the browser reusable by later CLI invocations and later agent runs:

```bash
opensteer -c "browser = open_browser(label='research', profile='fresh'); browser.new_tab('https://example.com')"
opensteer -c "browser = open_browser(label='work', profileId='bp_...'); print(browser.page_info())"
opensteer -c "browser = open_browser(profileId='bp_...'); print(browser.page_info())"
```

Use `profile='auto'` only when you deliberately want the platform to select the
sole granted profile (or an unprofiled browser when no grants exist).
`mode='reuse'` is the default. It selects the stable primary browser for this
agent, location, and profile. `label` is optional mutable display metadata: an
explicit different label renames that same browser in the UI; omitting it preserves
the current label. It never selects or creates a different browser. Use
`mode='new'` only when another independent logical browser is intentional.

`profile='fresh'` means no saved profile is attached. It does not guarantee a
new, clean, or signed-out browser because `mode='reuse'` may return a
previously used unprofiled browser, including from an earlier run. Use
`profile='fresh', mode='new'` when separate
clean state is required.

Read helpers never create a cloud browser. If no browser is active, call
`open_browser(...)` first.

List and explicitly select live browsers without creating one:

```bash
opensteer -c "print(list_browsers())"
opensteer -c "browser = use_browser('linkedin'); print(browser.page_info())"
```

`list_browsers()` is read-only. `use_browser(...)` accepts a unique label or
the exact `sessionId` returned by the list.

Browsers outlive a single agent command or run. Normal process/run shutdown
only detaches the controller relay. Call `browser.close()` (or the matching
close API) only when the browser itself should be destroyed.

Browser transport is independent of agent execution placement. Use
`location='cloud'` when a locally executing agent needs an isolated cloud
browser, `location='inapp'` for the desktop app's embedded browser, or
`location='local'` for a separate machine Chromium window. Omit it (or use
`location='auto'`) for normal automatic routing. Cloud execution supports only
`auto` and `cloud` and rejects device-only locations:

```bash
opensteer -c "open_browser(label='research', profile='fresh', location='cloud')"
```

## Browser Profiles

A browser profile is a saved, logged-in browser identity (cookies, auth state)
a cloud browser can launch with. Profile access is grant-based: the server
tracks which profiles this agent may use, and there is no per-agent default
profile.

- `list_cloud_profiles()` lists visible profiles; each entry carries a
  `granted` flag saying whether this agent may use it.
- `open_browser(label=name, profile='auto')` lets the server resolve it:
  exactly one granted profile auto-attaches, none launches an unprofiled
  session, and several granted profiles is rejected with an error telling you
  to pass `profileName` or `profileId`.
- When several profiles are granted, pick one explicitly:
  `open_browser(label='linkedin', profileName='LinkedIn work')` or
  `open_browser(label='linkedin', profileId='bp_...')`. Durable scripts
  should pin `profileId` — it survives profile renames.
- Passing a profile that is not granted to this agent fails with a 403 whose
  message says how to proceed (list granted profiles or request access).
- A granted profile works with either `location='inapp'` or `location='cloud'`.
  A provider that cannot honor the requested profile or location fails without
  changing either one.

Platform profile tools keep access requests separate from saving live state:

- `request_browser_profile` asks the user to choose or grant an existing
  profile. If a granted profile is signed out, open that exact profile, ask the
  user to take over and sign in, and continue. There is no repair mode; normal
  browser close-time persistence writes the refreshed login back.
- `request_save_browser_profile` saves an already-open, unprofiled browser.
  Offer only when future reuse is likely useful; never save automatically or
  keep asking after a decline. A direct request to save is approval; otherwise
  get explicit approval with `request_user_input` first. Keep the handle
  returned by `open_browser(...)` (or recover it with `use_browser(...)`) and
  pass its exact `browser.browser_ref`, never its label and never a guessed
  current browser. A specialized agent omits `cloudAgentId` and receives the
  grant itself. Chat may name a target specialized agent, or omit the target to
  save unassigned; Chat itself never receives the grant. The durable save is a
  point-in-time, cookie-backed auth snapshot. It does not close, rebind, or keep
  syncing the source browser.

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
