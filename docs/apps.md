# Opensteer Apps

Apps render on the person's device, inline in their Thread or full-screen. Each
card resolves its app ID to the latest publication, even in older history. The
origin Thread owns the app and its publications.
Stored HTML and the database belong in the same backup as Host attachments.

An HTML app is a self-contained document stored by the Host. A server app runs
from a folder in the publishing Run's local-directory Workspace, on the computer
that owns that directory. The folder holds its source and data. Publishing
verifies the start command before committing a version, but it doesn't copy or
roll back files. Editing the folder can affect an already running server.

Starting a server requires a full-access Run. So do `app_list` and `app_fetch`;
calling an app can execute code with the computer user's full authority. A
Personal macOS Runner has no outer sandbox. Connected agents and programs use a
managed Run for app publication or calls; approval of a connection grants no
direct app-server authority. Servers use the program launch and
containment paths, with the program environment allowlist plus `PORT`, and
receive no Opensteer tool credential. App versions record their owning computer;
they don't move to another computer when someone views them.

Serve the UI at `/` and listen on `127.0.0.1:$PORT`. Use relative URLs for assets,
links and API calls, such as `api/items` or `./assets/app.js`. Opensteer strips the
view prefix before forwarding requests and supplies it as `x-forwarded-prefix`
for frameworks that need a base path. For Vite, use `base: './'`. Document the
app's API in its folder's README so another agent can use `app_fetch`.

The frame and every app response enforce an opaque-origin sandbox, without
`allow-same-origin`. Relative resources and HTTPS presentation assets work;
Opensteer cookies, storage and the parent document stay inaccessible. The proxy
strips credentials and cookies in both directions. Desktop streams through a
separate scheme in its main process; mobile uses a WebView without Opensteer
credentials. Links within the capability prefix stay in the frame; other HTTP(S)
links open outside it. Design for phone width and the supplied light/dark theme.

App tool outputs expose app identity and publication metadata, never the view
capability or a token-bearing URL. Clients obtain viewing authority independently.
A view capability stays valid until Host restart, with one token per app and
person. Every request checks current Workspace membership. Logout doesn't revoke
a copied view URL. Treat the whole URL as private; clients keep it only in memory.

Servers stay running for background work. A crash restarts lazily on the next
request, with concurrent requests sharing a start. Servers stop when republished
as HTML, when their Workspace is deleted, or when the Runner loses its primary
Host connection or stops. A Workspace awaiting deletion refuses new starts and connections;
recovering it allows lazy starts again. After reconnect, the current committed
version starts lazily. There is no idle shutdown.

Only agents receive the Runner's 16 KiB in-memory log tail on startup failure;
viewer error pages omit it. Redirect output in the start command if persistent
logs are needed. `app_fetch` stops reading after 30 seconds or 256 KiB and cancels
the upstream request, including an endless event stream. Browsers can consume
streaming responses and SSE directly.
