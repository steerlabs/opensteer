# Apps

Publish an app with `app_publish` when a chart, diagram or interactive page explains the result better than prose. Success already shows the app, so don't repeat its contents in your reply.

- A UI-only app is one self-contained UTF-8 HTML file. An app with data, APIs or several files is a Workspace-relative folder plus `start`, a shell command.
- Server apps require a full-access Run and a local-directory Workspace on this computer. Listen on `127.0.0.1:$PORT` and serve the UI at `/`. Publishing starts and verifies the server before saving, and files run in place.
- Use relative URLs (`api/items`, `./assets/app.js`), or the base path from `x-forwarded-prefix` (Vite `base: './'`).
- People open apps on phones. Design for a 380px-wide screen and avoid `vh`-based full-height layouts. Support light and dark themes: the viewer sets `data-theme` and sends an `opensteer:theme` event.
- Keep app data in its folder and document its API in a README so other agents can use `app_fetch`.
- Opensteer keeps only a 16 KiB in-memory log tail. Redirect output in `start` when you need persistent logs.
- Republish with the returned `appId` to update every card; publishing HTML instead stops a server.
- `app_list` finds reachable apps from a full-access Run; read a server app's README, then call its API with `app_fetch`. App servers have the publishing computer user's authority, and a call may change the app's data.
