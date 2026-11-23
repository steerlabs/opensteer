# The command table

Generated from `command-table.rows.json` by `command-table-markdown.test-support.ts`; do not
edit. Callers: (a) your own agent at Full access, (b) your own agent below Full access
(an Auto answer that differs is shown beside it), (c) a connected agent with `everything`,
(d) a connected agent with a selected grant. `nf`: not found.

## Tasks, inputs, Requests (24)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `thread.create` | new task; parent = caller's task (lineage) ← `input` | widen-self | now | now | now | now | A | `tsvc:74` |
| `thread.rename` | task ← `threadId` | preference | now | now | now | now | A | agent path `tsvc:470` (`write`); D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.icon.set` | task ← `threadId` | preference | now | now | now | now | B | `commands.setThreadIcon` takes no authority (`server.ts:1893`) |
| `thread.sendMessage` | task ← `threadId` | widen-self | now | now | now | now | A | `connection` with selected grant: own lineage only |
| `thread.inputQueue.resume` | task queue ← `threadId` (+ who paused it, stored) | widen-self | now | now | now | now | A | step C splits by who paused (brief C7); X11: the inputs it releases run in the task's lineage, so a connection asks unless that lineage is its own; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.input.steer` | waiting input ← `threadId`,`messageId` | widen-self | now | now | now | now | A | ; X11: the input steers the running Run, in that Run's lineage, so a connection asks unless that lineage is its own; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.input.cancel` | waiting input ← `messageId` | narrow | now | now | now | now | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.input.move` | waiting input ← `messageId` | preference | now | now | now | now | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.input.lease.take` | the person's editor lease ← `messageId` + session | person-view | nf | nf | nf | nf | — | a lease belongs to one signed-in editor (`server.ts:1836-1846`) |
| `thread.input.lease.renew` | same | person-view | nf | nf | nf | nf | — |  |
| `thread.input.lease.release` | same | person-view | nf | nf | nf | nf | — |  |
| `thread.input.edit` | waiting input ← `messageId` | widen-self | now | now | now | now | B | refused today: "Only the owner can edit waiting inputs." (`tsvc:344-347`); needs a lease-less edit |
| `thread.visit` | the person's read marker ← `threadId` | person-view | nf | nf | nf | nf | — | an agent marking a task read would hide it from the person |
| `thread.done.set` | task ← `threadId`; `done:true` narrow / `done:false` widen-self | narrow / widen-self | now | now | now | now | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.execution.update` | task's engine account, model ← `threadId`,`harnessInstanceId` | preference | now | now | now | now | A | `tsvc:263`; X11: the task's later Runs use it, in the task's lineage, so a connection asks unless that lineage is its own; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `thread.access.update` | task's mode ← `threadId`,`accessMode` vs stored; lower narrow / higher approve | narrow / approve | now/ask | now/ask | now/ask | now/ask | B | `server.ts:1906` owner-only |
| `run.interrupt` | Run ← `threadId`,`runId` | narrow | now | now | now | now | A | `tsvc:507` |
| `node.stop` | subagent ← `threadId`,`nodeId` | narrow | now | now | now | now | A | `h/product.ts:908` passes `authority`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `assignment.cancel` | delegation ← `assignmentId` → worker task | narrow | now | now | now | now | A | `h/product.ts:927` passes `admission`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `request.respond` | Request ← `requestId` (its kind, origin task); answer to `harness.input` widen-self / allow a permission kind approve / decline narrow | widen-self / approve / narrow | now/ask | now/ask | now/ask | now/ask | A | answer face exists (`h/product.ts:964`); allow face "asks" = points at the same Request (no new one); decline face B; X11: the Run that asked goes on, in its lineage, so a connection asks unless that lineage is its own; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `request.command.approve` | a command Request ← `requestId`; the person approves the command, as proposed or changed | approve | ask | ask | ask | ask | — | A4: the person's answer to a command Request; an agent's ask about it points at that Request |
| `agent.session.stop` | a connected agent's direct session ← `threadId`,`agentSessionId` | narrow | now | ask | now | now | B | (c)(d): its own session only; another connection's → nf |
| `attachment.upload.create` | an upload slot for the person's client ← name, size | person-view | nf | nf | nf | nf | — | bytes arrive on the session-bound binary route; agents pass files by path |
| `attachment.upload.discard` | same ← `attachmentId` | person-view | nf | nf | nf | nf | — |  |

## Settings and defaults (6)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `execution.preferences.remember` | new-task defaults ← `selection`,`accessMode` (mode above the caller's own is approve) | preference / approve | now/ask | ask | now/ask | nf | A | `admin-svc:369`; review G2: raising the mode new tasks start in lifts a gate (`packages/database/src/harness-store.ts:1098-1131`); D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `viewer.timeZone.update` | the person's time zone | preference | now | ask | now | nf | A | echoes only, stores nothing (`admin-svc:366-367`) |
| `viewer.quietTasks.update` | quiet-task days | preference | now | ask | now | nf | A | `admin-svc:342` |
| `viewer.name.update` | the owner's display name | identity | ask | ask | ask | nf | — | refused today (`admin-svc:135-137`) |
| `settings.idleCompaction.set` | Claude idle compaction policy | preference | now | ask | now | nf | B | refused today (`admin-svc:130-134`) and its store write takes no identity (`admin-svc:334-340`) |
| `notification.preview.register` | this client's notification key ← `installationId`,`keyId` + session | person-view | nf | nf | nf | nf | — | device key of the person's own client |

## Engines (12)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `harness.create` | engine account ← `environmentId`, source | widen-self / widen-other | now/ask | ask | now/ask | nf | B | `server.ts:2085`; sign-in that follows is its own secret command; lead decision 2: an endpoint elsewhere sends what tasks say to that server (`packages/harness/src/compatible-endpoint.ts:20-35`, `packages/harness-antigravity/src/config.ts:6-9`) |
| `harness.update` | engine account ← `harnessInstanceId` | preference | now | ask | now | nf | B | `server.ts:2146` |
| `harness.delete` | engine account ← `harnessInstanceId` | destroy | now | ask | now | nf | B | ambient CLI: only its Mac's owner (`server.ts:1001-1014`) — stays ask |
| `harness.model.configure` | model limits ← `harnessInstanceId`,`nativeModelId` | preference | now | ask | now | nf | A | `admin-svc:413`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `harness.rename` | engine account ← `harnessInstanceId` | preference | now | ask | now | nf | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `harness.enabled.set` | engine account; `false` narrow / `true` widen-self | narrow / widen-self | now | ask | now | nf | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `harness.default.set` | default account per engine | preference | now | ask | now | nf | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `harness.authentication.begin` | engine sign-in ← `harnessInstanceId`,`methodId` | secret | ask | ask | ask | nf | — | collected on the person's screen |
| `harness.authentication.submit` | the typed sign-in value | secret | ask | ask | ask | nf | — |  |
| `harness.authentication.cancel` | a pending sign-in | narrow | now | ask | now | nf | B |  |
| `harness.authentication.browse` | sign-in opened as a tab | secret | ask | ask | ask | nf | — | redirect |
| `harness.authentication.logout` | engine sign-in | narrow | now | ask | now | nf | B | ambient CLI rule stays (`server.ts:2313`) |

## Devices (12)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `machine.access.update` | device switches ← `deviceId`\|`runnerId`, `policy` vs stored; all down/equal narrow / any up approve | narrow / approve | now/ask | ask | now/ask | nf | B | `server.ts:2339`; store already computes `changed` (`packages/database/src/machine-store.ts:396-400`) |
| `machine.rename` | device ← `machineId` | preference | now | ask | now | nf | A | `admin-svc:545`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `machine.revoke` | device ← `machineId` (deletes its profiles) | destroy | now | ask | now | nf | A | `admin-svc:532`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `machine.access.session.stop` | a device shell session ← `sessionId` | narrow | now | ask | now | nf | A | `admin-svc:577`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `machine.session.bind` | binds this client's session to its device ← signed `proof` | person-view | nf | nf | nf | nf | — | device-bound proof (`server.ts:2329`) |
| `iphone.screen.attach` | an iPhone screen driver ← `machineId` | widen-self | ask | ask | ask | nf | — | needs the owner's signed-in session (`admin-svc:558-562`); ask until that is understood |
| `iphone.screen.detach` | same | narrow | now | ask | now | nf | B | same refusal today; detach should not need the session |
| `computer.view.close` | the person's live view | person-view | nf | nf | nf | nf | — |  |
| `computer.view.renew` | same | person-view | nf | nf | nf | nf | — |  |
| `runner.enrollment.createLocal` | a new device; returns a one-use token | widen-other + secret | ask | ask | ask | nf | — | token is never returned to an agent |
| `runner.enrollment.createPhone` | a new phone; returns token and pairing | widen-other + secret | ask | ask | ask | nf | — |  |
| `runner.enrollment.retire` | a pending enrollment ← `enrollmentId` | narrow | now | ask | now | nf | B | `server.ts:2495` |

## Device apps, approvals, local servers (13)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `integration.computer.setup.request` | an app approval to set up ← `input.runnerId`, app | approve | ask | ask | ask | ask | — | today's `app_access_request` is this ask (`h/devices.ts:180`) |
| `integration.computer.setup.respond` | a setup Request ← `setupRequestId`; allow approve (+secrets) / decline narrow | approve / narrow | now/ask | now/ask | now/ask | now/ask | B | allow face points at the same Request; re-authenticates the session (`dev-routes:274-283`) |
| `integration.computer.setup.set` | an approval's settings ← `input.connectionId` | approve | ask | ask | ask | ask | — |  |
| `integration.computer.setup.cancel` | a pending setup ← `requestId` | narrow | now | ask | now | now | B |  |
| `integration.computer.session.stop` | a computer-use session ← `sessionId` | narrow | now | ask | now | now | — | the person's app ends a session from its live view (AD10: was the RPC `integration.computer.session.stop`); `computerUse.stop` unchanged |
| `integration.computer.policy.set` | a device's computer-use approval policy (`appApproval:"ask"` only) | narrow | now | ask | now | nf | B |  |
| `integration.computer.app.block` | a Mac app approval ← `connectionId` | narrow | now | ask | now | now | B | store takes an identity already |
| `integration.grant.create` | which installation may use a device-data account ← `input.connectionId`,`installationId` | approve | ask | ask | ask | ask | — | today's `app_access_request {dataApp}` |
| `integration.grant.revoke` | same ← `grantId` | narrow | now | ask | now | now | A (d: B) | `dev-admin:42` takes an identity; only the tool whitelist (`h/administration.ts:43-53`) blocks it |
| `integration.disconnect` | a device-app connection ← `connectionId` | narrow | now | ask | now | now | A (d: B) | `dev-admin:50` |
| `plugin.remove` | a local server ← `pluginId` | destroy | now | ask | now | ask | A | `dev-admin:39`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `integration.server.secrets.set` | a local server's secrets ← `serverId` | secret | ask | ask | ask | ask | — |  |
| `settings.plugin.enabled.set` | a plugin target ← `target`; `false` narrow / `true` approve | narrow / approve | now/ask | ask | now/ask | now/ask | B | store takes an identity; handler does not pass it (`server.ts:1746`) |

## Remote access, account link, sign-ins (7)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `personal.remoteAccess.request` | Remote access ← `intent`; on widen-other / off narrow | widen-other / narrow | now/ask | ask | now/ask | nf | B | session-bound service (`server.ts:2393`) |
| `personal.remoteAccess.pairing.create` | a pairing code for another client | widen-other + secret | ask | ask | ask | nf | — | code never returned to an agent |
| `personal.accountLink.approve` | the Home's link to the Opensteer account | identity | ask | ask | ask | nf | — |  |
| `personal.accountLink.complete` | same | identity | ask | ask | ask | nf | — |  |
| `personal.accountLink.resume` | same | identity | ask | ask | ask | nf | — |  |
| `personal.accountLink.unlink` | same | identity | ask | ask | ask | nf | — |  |
| `session.revoke` | another signed-in client ← `sessionId` | narrow | now | ask | now | nf | B | `server.ts:2452` |

## Connected agents (5)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `connection.authorize` | a pending consent ← its request id | widen-other / narrow | now/ask | ask | nf | nf | — | the ask points at the consent screen itself; review G2: denying a consent ends the ask (`apps/host/src/mcp/connections/connection-oauth.ts:374-408`) |
| `connection.update` | a connection, a chat included ← `connectionId`; grant ⊆ and mode ≤ narrow / otherwise widen-other | narrow / widen-other | now/ask | ask | now/ask | now/ask | B | on the branch a chat's grant and mode are edited here (`channel-handlers.ts:64-65` comment); (c)(d): own connection only — a chat is another principal, not_found |
| `connection.revoke` | a connection, a chat included ← `connectionId` (a chat's Disconnect) | narrow | now | ask | now | now | B | (c)(d): own connection only; a chat is another principal, not_found |
| `connection.remove` | a revoked or expired entry in the list, a chat included | preference | now | ask | nf | nf | B |  |
| `connection.uncertain.acknowledge` | "Check its last action" | person-view | nf | nf | nf | nf | — | the person's acknowledgement of evidence; an agent must not clear it |

## Plugins (21)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `plugins.install` | a plugin ← `source` | widen-self | now | ask | now | ask | A | `pauth:390`; (d): a new plugin is outside the grant, ask for more; X11: its code runs wherever the plugin is used, so a connection asks unless that lineage is its own; D0a: differs from the tool at f4d789f84: a grant holding nothing has no tool server today; a new plugin is outside the grant and the door asks for more (the table's (d)) |
| `plugins.version.activate` | a plugin version ← `pluginId`,`versionId` | widen-self | now | ask | now | ask | A | (d): a new version is a changed target (architecture: "A granted thing that changed is not granted"); X11: what the plugin's schedules and workflows run from now on, so a connection asks unless that lineage is its own |
| `plugins.remove` | a plugin ← `pluginId` | destroy | now | ask | now | ask | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `plugins.access.set` | agents' access to a plugin ← `pluginId`,`access`; lower narrow / higher approve | narrow / approve | now/ask | ask | now/ask | now/ask | B |  |
| `plugins.account.create` | an API-key account ← `pluginId`, fields | secret | ask | ask | ask | ask | — | today's `plugin_account_request` |
| `plugins.account.remove` | a plugin account | narrow | now | ask | now | now | B |  |
| `plugins.account.link` | link an account to a plugin | approve | ask | ask | ask | ask | — | today's `plugin_account_request` |
| `plugins.account.unlink` | same | narrow | now | ask | now | now | B |  |
| `plugins.schedule.configure` | a plugin schedule ← `pluginId`,`scheduleId`; enable widen-self / disable narrow | widen-self / narrow / approve | now | ask | now/ask | now/ask | A (c: B, d: B) | runs only; a connection lineage is refused today (`pauth:331`) → B for (c)(d); review G2: automatic approval lifts the browser approval (`apps/host/src/plugins/plugin-owner-api.ts:1150-1159`); review D5: left out, the store's default may be automatic; the lead's ruling on D0a: your own agent at Full access makes it now, with today's default, and below Full access and every connection ask |
| `plugins.schedule.answer` | a scheduled approval | approve / narrow | now/ask | ask | now/ask | now/ask | — | the ask points at the approval itself; review G2: declining a scheduled run narrows (`packages/protocol/src/plugins.ts:607-612`) |
| `plugins.workflow.start` | a plugin workflow run | widen-self | now | ask | now | now | A (c: B, d: B) | (d): read-write grant; lineage B (`pauth:331`); X11: the workflow run goes on in the plugin engine as the person's, so a connection asks unless that lineage is its own |
| `plugins.workflow.stop` | same ← `runId` | narrow | now | ask | now | now | A (c: B, d: B) | lineage B |
| `plugins.webhook.remove` | a webhook | narrow | now | ask | now | now | A (c: B, d: B) | lineage B |
| `plugins.webhook.removal.confirm` | confirms manual cleanup at the provider | narrow | now | ask | now | now | B |  |
| `plugins.webhook.setup.complete` | confirms manual setup at the provider | widen-self | now | ask | now | now | B |  |
| `plugin.authorization.prepare` | plugin OAuth sign-in ← connection, method | secret | ask | ask | ask | ask | — | redirect on the person's device |
| `plugin.authorization.begin` | same | secret | ask | ask | ask | ask | — |  |
| `plugin.authorization.return` | same | secret | ask | ask | ask | ask | — |  |
| `plugin.authorization.cancel` | a pending sign-in | narrow | now | ask | now | now | B |  |
| `plugin.oauthApp.save` | a custom OAuth client | secret | ask | ask | ask | nf | — |  |
| `plugin.oauthApp.remove` | same | narrow | now | ask | now | nf | B |  |

## Chats (6)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `channel.connection.create` | a chat bridge (bot credentials) | widen-other + secret | ask | ask | nf | nf | — | ; X13: a chat account and its chats are other connections, so not found for every connected agent |
| `channel.connection.credentials.replace` | bridge credentials ← `connectionId` | secret | ask | ask | nf | nf | — | ; X13: a chat account and its chats are other connections, so not found for every connected agent |
| `channel.connection.computer.create` | iMessage on a Mac ← `runnerId` | widen-other | ask | ask | nf | nf | — | ; X13: a chat account and its chats are other connections, so not found for every connected agent |
| `channel.connection.status.set` | a chat account ← `connectionId`; its chats wait while it is paused; `paused`/`revoked` narrow / `connected` widen-other | narrow / widen-other | now/ask | ask | nf | nf | A | branch `channel-handlers.ts:84-86`; agent path `administration-service.ts:314` still passes the identity; no tool builds it on the branch; chat states `packages/database/src/connection-liveness.ts:15-16,92-93`; X13: a chat account and its chats are other connections, so not found for every connected agent |
| `channel.chat.create` | a new chat connection (an AgentConnection) on a chat account ← `accountId`, `conversation` (null = its direct messages), `senders` (fixed for life), `accessMode`, `grant` | widen-other | ask | ask | nf | nf | — | branch `host-api.ts:1026-1044`, `channel-handlers.ts:66-77`; "anyone" senders only for a named channel, holding tasks and plugins only; X13: a chat account and its chats are other connections, so not found for every connected agent |
| `channel.me.link` | the person's own identity on a chat account ← `accountId`; returns a code the person sends from that account | identity | ask | ask | nf | nf | — | branch `host-api.ts:1046-1054`, `channel-handlers.ts:80-83`; the code is never returned to an agent; X13: a chat account and its chats are other connections, so not found for every connected agent |

## Browser (16)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `browser.session.start` | a page in a profile ← `input.profileId` | widen-self | now | now | now | now | B | owner-only `browser.start` (`server.ts:2504`); `tab_open` is the actor path; X11: the session goes on for the task it was started for, so a connection asks unless that lineage is its own |
| `browser.session.close` | a browser session ← `sessionId` | narrow | now | now | now | now | B |  |
| `browser.profile.create` | a new profile ← `input.name` | widen-self | now | ask | now | ask | B |  |
| `browser.profile.rename` | a profile ← `profileId` | preference | now | ask | now | now | A (d: B) | `admin-svc:613`; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `browser.profile.delete` | a profile and its sign-ins ← `profileId` | destroy | now | ask | now | ask | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `browser.history.remove` | one history entry ← `profileId`,`url` | destroy | now | ask | now | ask | A (d: B) | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2); destroy, as decided: it cannot be put back, so a connection removes it only at Full access and a selected grant asks |
| `browser.history.clear` | a profile's history ← `profileId` | destroy | now | ask | now | ask | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `browser.site.remove` | a site's copied Chrome sign-in ← `site` (every profile) | destroy | now | ask | now | nf | A | Home-wide, not a grant-nameable resource; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2); destroy, as decided: it cannot be put back, so a connection removes it only at Full access and a selected grant asks |
| `browser.source.pair` | pairing the tab-sharing extension | widen-other + secret | ask | ask | ask | nf | — |  |
| `browser.source.rename` | a paired Chrome ← `sourceId` | preference | now | ask | now | now | B |  |
| `browser.source.revoke` | same | narrow | now | ask | now | now | B |  |
| `browser.session.sign-in` | copy a site's Chrome sign-in into a session ← `sessionId`,`sourceId`,`url` | approve | ask | ask | ask | ask | — | today's `chrome_cookies_request` |
| `browser.sign-in.respond` | a sign-in Request ← `requestId`; allow approve / decline narrow | approve / narrow | now/ask | now/ask | now/ask | now/ask | B | allow face points at the same Request |
| `browser.password-sign-in.respond` | decline a saved-password sign-in ← `requestId` | approve / narrow | now/ask | now/ask | now/ask | now/ask | B | needs `context.session` (`bsr:150-154`); review G2: approve and approve-card release a saved login or a card (`apps/host/src/browser/password-sign-in-service.ts:815-927`); the allow face points at the same Request |
| `browser.pool.restart` | a Cloud Computer's pooled browser ← `runnerId` | destroy | now | ask | now | nf | B |  |
| `browser.pool.notice.seen` | a notice shown to the person | person-view | nf | nf | nf | nf | — |  |

## Tabs and apps (11)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `tab.open` | the shared tab list ← `target` | widen-self | now | now/ask | now | now | A | `TabActor` (`apps/host/src/tabs/ports.ts:45-49`); X12: today's tab_open refuses below the read-write ceiling (Full access or Auto), recorded in D0a, so the door asks there; approved C2 line: a connection opens tabs from Auto up and asks below it |
| `tab.close` | tabs ← `tabIds` | narrow | now | now | now | now | A | ; approved C2 line: a connection closes tabs from Auto up and asks below it; your own agents as today's tab_close (D0a) |
| `tab.reopen` | a closed tab ← `tabId` | widen-self | now | now | now | now | B | takes `TabActor` but its agent admission is unverified (`tab-service.ts:792-800`) |
| `tab.activate` | the person's selection | person-view | nf | nf | nf | nf | — | the agent equivalent is `show_to_person` |
| `tab.organize` | tab order and groups | preference | now | now | now | now | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `tab.group.update` | a tab group ← `groupId` | preference | now | now | now | now | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `tab.group.delete` | a tab group ← `groupId` | preference | now | now | now | now | B | `deleteGroup(ownerId, …)` (`tab-service.ts:913`) |
| `app.rename` | a published app ← `appId` | preference | now | ask | now | nf | B | `rename(ownerId, …)` (`app-service.ts:401`) |
| `app.start` | an app server ← `appId` | widen-self | now | ask | now | nf | A | `AppActor` (`app-service.ts:51-53`); X11: an app server runs on, in no connection's Disconnect set, so a connection asks unless that lineage is its own |
| `app.stop` | same | narrow | now | ask | now | nf | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |
| `app.delete` | an app ← `appId` | destroy | now | ask | now | nf | A | ; D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2) |

## Automations (5)

| Command | Governs ← input | Class | (a) | (b) | (c) | (d) | Step | Note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `trigger.create` | an automation anchored to a task ← `input` | widen-self | now | ask | now | now | A | `TriggerService.manage` (`trigger-service.ts:272`); review D1: Full access, as today's tool (`packages/agent-tools/src/tools/triggers.ts:47`); D0a: differs from the tool at f4d789f84: the tool is not on a connection's surface today; the design gives a connection the same table cut to its grant (brief C2); X11: the automation takes its anchor task's lineage (trigger-store.ts:2437), so a connection asks unless that lineage is its own |
| `trigger.update` | an automation ← `triggerId` | widen-self / widen-self | now | ask | now | now | A | another lineage's program stays nf/refused (`h/triggers.ts:58-61`); a new program needs Full access, as today's tool (`packages/agent-tools/src/tools/triggers.ts:65`); D0a: today's tool refuses any change below Full access, a name included (opensteer_automation_update for a Supervised Run: access_denied); X11: a new program or source runs on in the automation's lineage, so a connection outside that lineage asks |
| `trigger.status.set` | an automation ← `triggerId`,`status`; pause/archive narrow / resume widen-self | narrow / narrow / widen-self | now | now/ask | now | now | A | (b): archive needs full access today (`t/triggers.ts:86`); X11: resuming starts the automation again in its own lineage, so a connection asks unless that lineage is its own |
| `trigger.run` | run now ← `triggerId` | widen-self | now | ask | now | now | A | full access today; X11: the occurrence is the automation's lineage's (`trigger-store.ts:1879`), so a connection outside that lineage asks |
| `trigger.cancel` | pending occurrences ← `triggerId` | narrow | now | now | now | now | A |  |
