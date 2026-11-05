# Opensteer Apps

Apps render on the person's device, inline in their Thread or as a tab beside it. Each card resolves
its app ID to the latest publication, even in old history, and the origin Thread owns the app. Stored
HTML and the database belong in the same backup as Host attachments. App authors follow the shipped
[apps reference](../apps/runner/agent-skills/skills/threads/references/apps.md).

There is no full-window view: a person must be able to look at an app and ask for a change. An open
tab is one fact about the app, shared by the Workspace like a Guest browser tab, so it reaches every
member's devices. It travels on the bootstrap, not the event stream, because clients follow only some
Workspace channels; a type-only frame prompts the reread, and the bootstrap poll repairs a lost one.
A Workspace holds at most 50, so a listed set is complete and absence means closed.

An HTML app's only state is its running frame, because the sandbox leaves it no storage. So a client
runs one copy: while an app is a tab, its cards show a link instead of a frame. Web and desktop keep a
shown tab's frame mounted and never move it, since moving an iframe reloads it. Opening a tab, leaving
for Settings on web, and leaving an app's page on mobile all reload the frame; apps with data that
must survive belong in a server app.

An HTML app is a self-contained document the Host stores. A server app runs from a folder in the
publishing Run's local-directory Workspace, on the computer that owns that directory, and its folder
holds source and data. Publishing verifies the start command before committing a version but never
copies or rolls back files, so editing the folder can affect a running server. App versions record
their owning computer and never move to the viewer's.

Starting a server and `app_fetch` need a full-access Run, because calling an app can run code with
the computer user's full authority, and a Personal macOS Runner has no outer sandbox. Connected
agents and programs publish or call apps through a managed Run; approving a connection grants no
direct app-server authority. Servers use the program launch and containment paths, get the program
environment allowlist plus `PORT`, and never receive an Opensteer tool credential.

The frame and every app response enforce an opaque-origin sandbox without `allow-same-origin`, so
Opensteer cookies, storage and the parent document stay out of reach. The
[proxy](../apps/host/src/apps/app-proxy.ts) strips credentials and cookies both ways. Desktop
streams through a separate scheme in its main process; mobile uses a WebView without Opensteer
credentials. Links inside the capability prefix stay in the frame; other links open outside.

App tool outputs carry app identity and publication metadata, never the view capability or a
token-bearing URL; clients get viewing authority on their own. A view capability lasts until Host
restart, one per app and person, and every request checks current Workspace membership. Logout does
not revoke a copied view URL, so clients treat the whole URL as private and keep it only in memory.

Servers keep running for background work, restart lazily after a crash, and have no idle shutdown.
They stop when republished as HTML, when their Workspace is deleted, or when the Runner loses its
primary Host connection or stops; a Workspace awaiting deletion refuses new starts. Only agents get
the startup-failure log tail; viewer error pages omit it.
