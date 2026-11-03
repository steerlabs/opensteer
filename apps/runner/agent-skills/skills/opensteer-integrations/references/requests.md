# Setup and access Requests

For a known installation, call `integration_request` directly; discovery is not a prerequisite. Otherwise search for the action with a nonempty `query`, or supply `provider` or `runnerId` when omitting it. Read response `guidance` and row/server readiness to identify who can repair setup. Missing provider configuration may be repairable through the person's own app setup; request access to that UI. Say an administrator is required only when the result identifies an administrator-only prerequisite.

Pass `reason`, the installation name or `iin_` id as `integration`, and needed `access` (`read` or `read-write`). Select a specific account with its connection id and a multi-server installation with its `server` id from search. Main may add `workspaceId`. For a catalog definition, pass its `definitionId` as `catalog` instead. One request covers installation, connection and access; omit access only for explicit installation alone. `READY` still permits adding, switching or reconnecting an account. Installation progress alone does not fulfill access; use fresh operations for the connection named by the fulfillment continuation.

Write each request `reason` as one plain sentence explaining what you need and why. The person sees it verbatim; omit internal codes such as `REAUTHORIZATION_REQUIRED`.

Main and Workspace Runs can request integration access. Delegated Runs must return missing access to their assigner. Mac app and Android phone discovery and approval also use integration tools; operate them through `app()` or `phone()` in `computer`, following opensteer-computer-use.

`integration_request` and `integration_propose` create an `integration.access`,
`integration.install` or `computer.app.access` Request and return
`{requestId, kind, status, replayed}` immediately, usually `status: "pending"`. Do not wait, poll,
or resubmit. In a Run, the resolution message arrives on the Thread that opened the Request, so continue
other useful work or end your turn; a trigger occurrence gets no such message (see [boundaries](boundaries.md)). After a decline, continue without it unless the user asks again. A
Request exists only once one of these calls returns a `requestId`; search results are discovery, not
permission or durable state.

Replay follows the provider call identity, while pending access dedup follows target Workspace,
requester, installation, and access class. Replaying one call returns the same Request; a second
call with the same pending access ask also returns that Request with `replayed: true`. Catalog
installation requests still deduplicate by the proposed manifest for Trigger occurrences. Requests
have no expiry and no separate inbox.

In a run, `request_list` inspects visible Requests and `request_withdraw` retires one this Thread
originated and no longer needs. A trigger execution has neither tool; the guidance in the tool
results is all the Request state it gets.
