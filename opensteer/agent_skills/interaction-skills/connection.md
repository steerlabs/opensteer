# Connection & Tab Visibility

## The omnibox popup problem

When Chrome opens fresh, the only CDP `type: "page"` targets are often `chrome://inspect` and `chrome://omnibox-popup.top-chrome/` (a 1px invisible viewport). Opensteer avoids taking over arbitrary browser pages by restoring only tabs already owned by the current `OPENSTEER_NAME`; if none are still live, it creates a fresh `about:blank` tab and controls that.

For OpenSteer-managed cloud CDP grants, visible targets are already scoped by the runtime proxy; if exactly one controller-owned page exists, the daemon attaches to that page instead of creating a duplicate blank tab.

If the user asks you to control a specific existing tab, use `list_tabs()` to find it and `switch_tab(target_id)` to explicitly attach to it. If you still end up on an invisible tab, `switch_tab()` calls `Target.activateTarget` to bring the selected tab to front.

## Startup sequence

1. Check if a daemon is already running with `daemon_alive()`
2. If stale sockets exist but daemon is dead, clean them up
3. Let the daemon attach to the current Opensteer-owned tab or create a fresh `about:blank`
4. Navigate the owned tab with `goto_url()`
5. Only use `list_tabs()` and `switch_tab(target_id)` when the user explicitly wants an existing tab

```python
if not daemon_alive():
    import os
    from opensteer.paths import session_paths
    for f in session_paths("default")[:2]:
        if os.path.exists(f):
            os.unlink(f)
    ensure_daemon()

goto_url("https://example.com")
```

## Bringing Chrome to front

If Chrome is behind other windows or on another desktop:

```python
import subprocess
subprocess.run(["osascript", "-e", 'tell application "Google Chrome" to activate'])
```

## Navigating

Prefer navigating the current Opensteer-owned tab. Tabs created via CDP's `Target.createTarget` are visible but may open behind the active tab.

```python
goto_url("https://example.com")
```
