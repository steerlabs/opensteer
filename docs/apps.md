# Opensteer Apps

An app renders on the person's device, inline in its Thread or full-screen.
A chart or interactive explanation should travel with its conversation and work
on a phone; a streamed browser tab would add a computer, latency and a separate
place to find it.

Published HTML has an opaque origin: both the frame and its response sandbox
allow scripts and popups without `allow-same-origin`. The app cannot reach the
Opensteer session, storage or Host API. HTTPS CDN scripts and presentation assets
are allowed; direct data connections, nested frames and forms are not. Desktop uses a
separate scheme through the main process; mobile uses an isolated WebView without
Opensteer credentials. View capabilities expire and remain only in memory.

Each Thread has one live card per app, placed at its latest publication. The
card resolves its app ID to the latest version, including in older history. Old immutable versions are retained as history, not pinned views.
An app belongs to its origin Thread: deleting that Thread removes its rows.
The Host owns digest-named bytes and removes unreferenced content at startup.
Back up the database and Host data directory together, as with attachments.

Phase 2 will let an app run its own server on its computer, with Opensteer routing
its `api/*` requests. Frameworks, data and background work belong to that app.
