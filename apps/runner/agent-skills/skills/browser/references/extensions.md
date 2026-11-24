# Chrome extensions

A saved browser profile on a computer keeps Chrome extensions, as Chrome does: the person installs them from the Chrome Web Store, and you can build and load your own. Guest keeps none, and phone browsers run none.

To build one, write an ordinary Manifest V3 folder (`manifest.json`, a service worker, content scripts, a popup) on the computer that hosts the profile, then load it from any handle in that profile:

```js
const { id } = await cdp("Extensions.loadUnpacked", { path: "/absolute/path/to/extension" });
```

It loads in place, like Chrome's Load unpacked, stays in the profile across restarts, and appears in the browser's Extensions menu, and in its toolbar when it has an action, where the person can remove it. Loading the same folder again reloads it under the same ID, keeping its storage: edit, load again, then reload the page you test on. `Extensions.getExtensions` lists the profile's extensions, `Extensions.triggerAction({ id })` triggers its toolbar action, and `Extensions.uninstall({ id })` removes one.

Test it like any page: content scripts run in pages you open, and its own pages open as tabs (`tab_open` or navigation to `chrome-extension://<id>/popup.html` or its options page), where `cdp` and `evaluate` reach the extension's context. The `tabs`, `windows` and `action` APIs see the profile's tabs, with the tab the person is looking at as the active one. Chrome manifest permissions (`cookies`, `tabs`, `webNavigation`, `contextMenus`, `notifications`, and `host_permissions`) are enforced, so declare what your extension needs in `manifest.json`.

The browser is Electron's Chromium. Use `scripting`, `storage`, `tabs`, `action`, `contextMenus`, `cookies`, `webNavigation`, `notifications`, `commands` and runtime messaging. Avoid `webRequest` (the browser's own handler takes those requests), `declarativeNetRequest`, `sidePanel`, `offscreen`, `identity` and native messaging. `runtime.onInstalled` never fires, so create menus and defaults when the service worker starts, not in `onInstalled`.

An extension keeps running in the person's own browsing after your task ends. Load only what the task needs, and remove what the person did not ask to keep.
