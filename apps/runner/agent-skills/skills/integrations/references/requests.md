# Setup and access Requests

For a known installation, call `integration_request` directly; discovery is not a prerequisite. Otherwise search for the action with a nonempty `query`, or supply `provider` or `runnerId` when omitting it. Read response `guidance` and row/server readiness to identify who can repair setup. Missing provider configuration may be repairable through the person's own app setup; request access to that UI. Say an administrator is required only when the result identifies an administrator-only prerequisite.

Pass `reason`, the installation name or `iin_` id as `integration`, and needed `access` (`read` or `read-write`). Select a specific account with its connection id and a multi-server installation with its `server` id from search. Runs may name a reachable `workspaceId`; programs use their own Workspace. For a catalog definition, pass its `definitionId` as `catalog` instead. One request covers installation, connection and access; omit access only for explicit installation alone. `READY` still permits adding, switching or reconnecting an account. Installation progress alone does not fulfill access; use fresh operations for the connection named by the fulfillment outcome.

Choose the intended account by its identifying address, not its display name. A work address does not establish that personal email is connected. If the address is missing, do not guess the account.

Write each request `reason` as one plain sentence explaining what you need and why. The person sees it verbatim; omit internal codes such as `REAUTHORIZATION_REQUIRED`.

Runs, including delegated workers within their inherited reach, can request integration access. Mac app and Android phone discovery and approval also use integration tools; operate them through `app()` or `phone()` in `computer`, following opensteer:computer-use.

`integration_request` and `integration_propose` create an `integration.access`,
`integration.install` or `computer.app.access` Request. In a foreground Run outside voice, the call
waits for the person and returns the outcome. Voice, background Runs and programs receive pending
immediately; a Trigger occurrence gets no continuation (see [boundaries](boundaries.md)). Pending
grants no access; do not poll, repeat or route around the Request. After a decline, continue without
it unless the person asks again. Search results are discovery, not permission or a new Request.

Replay follows the provider call identity, while pending access dedup follows target Workspace,
requester, installation, and access class. Replaying one call returns the same Request; a second
call with the same pending access ask also returns that Request with `replayed: true`. Catalog
installation requests still deduplicate by the proposed manifest for Trigger occurrences. Requests
have no expiry and no separate inbox.

In a run, `pending_request` inspects visible Requests and `request_withdraw` retires one this Thread
originated and no longer needs. Programs can inspect with pending_request but cannot withdraw. A program receives no automatic approval continuation; a later occurrence can inspect readiness.
