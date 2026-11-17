# Apps

Publish an app with `app_publish` when a chart, diagram or interactive page explains the result better than prose. The person owns it: it stays in their Apps list after this task and its chat end. Publishing adds a card to the chat, so don't repeat its contents in your reply; it opens no tab unless you call `tab_open` with `{ kind: "app", appId }`.

- A UI-only app is one self-contained UTF-8 HTML file. An app with data, APIs or several files is a folder in Agent home plus `start`, a command for the hosting computer's shell, which your context names: `/bin/sh` on macOS and Linux, `cmd.exe` on Windows.
- Server apps require a full-access Run on the hosting computer. Listen on `127.0.0.1` at the port in the `PORT` environment variable (`process.env.PORT` in Node) and serve the UI at `/`. Read it in code rather than in `start`, so the command works in either shell. Publishing starts and verifies the server before saving, and files run in place.
- Each server app keeps one port for life and keeps running across Runs, restarts and reconnects until `app_stop`; `app_start` runs it again. `port_in_use` means another program holds that port: report it rather than changing ports.
- Use relative URLs (`api/items`, `./assets/app.js`), or the base path from `x-forwarded-prefix` (Vite `base: './'`).
- Most viewers give an app its own origin, so `localStorage`, cookies, WebSockets and public APIs work. Some viewers have no storage, so the app must load without it. Apps can't receive webhooks or POST callbacks from other sites.
- People open apps on phones. Design for a 380px-wide screen and avoid `vh`-based full-height layouts. Support light and dark themes: the viewer sets `data-theme` and sends an `opensteer:theme` event.
- Keep app data in its folder and document its HTTP API in a README, so later agents can call it.
- Opensteer keeps only a 16 KiB in-memory log tail. Redirect output in `start` when you need persistent logs.
- Republish with the same `appId` to update every card; publishing HTML instead stops a server.

To use an existing server app, find it with `app_list`, read the README in its `folder`, and call its `localUrl` with curl or fetch from a full-access Run on its computer. App servers run with the publishing computer user's authority, and a request may change the app's data. `app_delete` stops the server, closes its tabs and removes it from the Apps list; its folder stays.
