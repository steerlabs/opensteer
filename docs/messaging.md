# Messaging: channels, identities, and deliveries

This is the spec for how a message in a chat product (Slack, and iMessage through a Mac) becomes a
Run, how the Run's answer gets back, and what a person configures to make that happen.
`docs/computers.md` owns how the messaging service is enrolled as a computer; nothing here changes
that.

## 1. Two halves, one durable owner

The **Host** owns every durable fact: which provider workspaces are connected, which
conversations route where, who a provider user is inside Opensteer, every message that arrived,
and every message that must go out. It never talks to a provider.

The **messaging service** (`apps/channel-runtime`) owns the provider transports and nothing
durable. It is one Runner identity whose only module is `messaging`, attached over the fenced
auxiliary stream (`packages/protocol/src/runner-auxiliary.ts`), and it holds a socket per
connected provider workspace. It has no database, no routing, no policy, and only the
credential fields the manifest marks for the purpose at hand, on a short lease. Restarting it
loses nothing; the Host's queues carry every message across the gap. The module itself is
`MessagingModule` in `packages/messaging-module`; a Mac's own Runner carries one too, for a
transport only that Mac can hold (§7a).

Everything provider-specific is a **`ChannelAdapter`** (`packages/channel-core/src/adapter.ts`):
`connection.inspect` and `connection.run` for the transport, `outbound.send` and
`outbound.reconcile` for delivery, and a `manifest` describing credentials, the app the person
must create, and `maxMessageChars`. The Host and the service are provider-agnostic; they read the
manifest and nothing else.

## 2. Vocabulary

| Word              | Table                         | Meaning                                                                                                                                                         |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection        | `integrationConnections`      | The sealed credentials for one provider workspace, and which messaging service currently drives them (`runnerId`). Shared with the other integration kinds.     |
| Account           | `channelAccounts`             | The provider workspace itself: provider, `externalAccountId` (Slack team id), display name. One per connection.                                                 |
| Binding (a route) | `channelBindings`             | "Conversations matching this selector run in this Workspace, for these people, on this engine." A connection starts with one; more can be added.                |
| Identity          | `channelIdentities`           | A provider user seen by this bot, with its own `principal`, and `linkedUserId` once the person has proved which Opensteer account it is.                        |
| Conversation      | `channelConversations`        | One provider conversation (workspace, channel, thread) pinned to one binding.                                                                                   |
| Context           | `channelConversationContexts` | A provider conversation's Thread for one execution authority and policy revision.                                                                               |
| Access grant      | `channelAccessGrants`         | A pending, approved, declined, or revoked external sender for one binding. No Opensteer account is required.                                                    |
| Ingress           | `channelIngressEvents`        | A normalized provider message, committed before the provider is acknowledged, deduplicated on `(accountId, providerEventId)`, and worked off a claim lease.     |
| Delivery          | `channelDeliveries`           | One provider message that must exist: an agent `reply` part, or a `status` notice from the system. Claimed under a lease with a hashed token; four-way outcome. |
| Link code         | `channelLinkCodes`            | A one-hour code the bot hands a provider user so they can claim that identity in the web app.                                                                   |

`ChannelConversationType` is `dm | group | channel`. A thread is not a type: it is a conversation
whose `externalThreadId` is set. For Slack a channel mention starts a conversation keyed on the
mention's own `ts`, so the reply and every follow-up land in that Slack thread; a DM is one
rolling conversation.

## 3. Inbound

1. The adapter emits **exactly one** `NormalizedChannelEvent` per provider message that the bot
   should act on: a DM (`direct-message`), a message that mentions the bot (`mention`), or a
   message inside a conversation the bot is already in (`conversation-followup`). Ambient chatter
   in a channel or group DM is never emitted. The adapter drops its own messages.
2. The service commits it (`ingress.commit`). The Host inserts into `channelIngressEvents` with
   `ON CONFLICT (account_id, provider_event_id) DO NOTHING`; a duplicate answers `duplicate: true`.
   Only after the Host answers does the adapter acknowledge the provider's envelope. If the Host
   does not answer, the envelope stays unacknowledged, the provider redelivers, and the socket
   stays up. That is the at-least-once contract, and the unique index is what makes it safe.
3. `ChannelService` drains the queue. A claim takes the **oldest pending row of a lane** (the lane
   is the conversation key) and only when that lane has nothing leased, so messages in one Slack
   thread are adopted in the order they arrived.
4. `adoptIngress` (`packages/database/src/channel-store.ts`) runs in one transaction under an
   advisory lock on the lane: find or create the conversation; resolve the binding (an existing
   conversation keeps its binding; a new one is routed by selector specificity, ties refused);
   upsert the identity; resolve authority through the binding's access policy
   (`channel-authority.ts`); choose a work location; rotate or reuse the Thread; then hand the
   content to the shared Thread Inbox with `policy: "queue"` and a `replyTarget` naming the
   conversation. The inbox re-reads the current binding, identity, grant and membership under
   transaction locks. Queued inputs follow `docs/agent-orchestration.md`: in a group or work
   Thread they wait for a new turn while a Run is active, and in the owner's direct-message
   conversation the owner's message joins the reply under way to that same conversation.
5. Every way adoption can decline is written to `lastError` **and answered in the same
   transaction**: see §5. The Host hands `adoptIngress` the words (`notices`), because only the
   Host knows the canonical origin and the provider's label, and the store inserts whichever one
   it decided on beside the ignored row. There is no state in which a message is closed and the
   person was told nothing. Routing and identity are resolved before placement, so a person who
   needs a link code or a route hears about it even while no computer is online to run anything.
6. A message nothing can run yet — no computer awake, the Workspace not ready — is **deferred**,
   not failed: it is looked at again in five seconds while it is under a minute old and every
   thirty seconds after that, and spends no attempt. Somebody is still watching for the answer to
   a message they just sent; nobody is helped by a tight loop for the rest of the hour. Once a
   message is more than an hour old it is dropped before adoption and the person is told, because
   an answer to yesterday's question is worse than none — and that notice, too, is inserted with
   the row that dropped it. Age is counted from `occurredAt`, when the person sent it, never from
   when the Host received it: a transport that was offline (a Mac asleep with its Messages, a
   socket that missed a window) hands over an old message as if it were new.
   Failures back off exponentially and die at twenty attempts; the sweep that kills them says so
   to anybody who addressed the bot, because nothing else ever will.

## 4. Outbound

1. When a Run with a channel `replyTarget` completes, finalization takes its reply — the last
   message its agent wrote that says something — splits its text at the manifest's `maxMessageChars`
   (`splitMessageText`, fence-aware) and inserts one `reply` delivery per part,
   `(message_id, part)` unique, all `pending`. What the agent wrote on the way there stays in the
   Thread.
2. The service polls `delivery.claim`. A claim takes the oldest claimable row of a lane
   (`coalesce(conversation_id, ingress_id)`), ordered by `(created_at, part)`, and only when that
   lane has nothing in flight, so parts and successive replies post in order. Claimable statuses
   are `pending`, `retryable-failed`, and `unknown`; the claim says `mayHaveBeenSent` for the last.
3. `delivery.start` moves the row to `attempt-started` under `FOR NO KEY UPDATE` on the connection row:
   revocation and attempt-start race on one lock, so a revoked connection can never start a send,
   and a send that started before revocation is honestly `unknown` rather than `dead`.
4. The adapter renders the content into the provider's markup and posts **one** provider message,
   tagged with the delivery id (Slack: message `metadata`). `audience: "conversation"` posts where
   the conversation is; `audience: "actor"` reaches only the person whose message caused it
   (Slack: an ephemeral message in a channel, a plain message in a DM).
5. `delivery.finish` records `sent` with the receipt, `retryable-failed` with an optional
   `Retry-After`, `dead`, or `unknown`. Backoff is exponential with jitter (5 s doubling to 10 min,
   never shorter than the provider's `Retry-After`) and twenty attempts end in `dead`. A lease
   that expires in `attempt-started` becomes `unknown`.
6. `unknown` is not a terminal state. The next claim carries `mayHaveBeenSent`, the service calls
   `outbound.reconcile`, and the adapter looks the message up by the one identity it stamped on
   it: Slack posts the delivery id as message metadata and reads the conversation back with
   `include_all_metadata`. Found means `sent` with the real receipt; not found means send again,
   which is the at-least-once promise and the only duplicate this system can produce. Ephemeral
   messages are never stored, so an actor-audience notice that lost its outcome is simply sent
   again. An adapter that cannot look a message up returns `unknown` from `reconcile` and accepts
   the same duplicate; it must say so in its own file.

## 5. The system speaks for itself

A messaging product's worst failure is silence, so every outcome a person would otherwise infer
from nothing is a `status` delivery:

| Cause                                                 | Audience     | Text says                                                                      |
| ----------------------------------------------------- | ------------ | ------------------------------------------------------------------------------ |
| Sender is not linked and the binding requires linking | actor        | How to link: sign in at the Deployment and enter the code the bot just issued. |
| No binding matches an explicitly addressed message    | actor        | This conversation is not routed; ask whoever connected the bot to add a route. |
| The Run failed                                        | conversation | What went wrong, briefly, and a link to the Thread.                            |
| The Run is waiting on a person (a live Request)       | conversation | The agent needs input, and a link to the Thread.                               |
| The Run was stopped                                   | conversation | It was stopped, and a link to the Thread.                                      |
| No computer was available within an hour of sending   | actor        | It was dropped; send it again once a computer is online.                       |
| It reached the Host more than an hour after sending   | actor        | It was not run; send it again if it is still needed.                           |
| The resolved person is not in the routed Workspace    | actor        | They do not have access to the Workspace this conversation is routed to.       |
| The event ran out of attempts                         | actor        | Something went wrong; open Opensteer to check on it.                           |
| A code cannot travel privately here (§6)              | conversation | Send the bot a direct message to link an account.                              |

`conversation-followup` messages that cannot be adopted stay silent: they are other people's
threads the bot happens to be in. Where anybody who knows the address can write — a manifest
with `senders: "anyone"`, iMessage — an `actor` notice reaches only a sender linked to an
Opensteer account or approved for the binding (`insertStatusDelivery`); a stranger is never
answered, not even to say they wait for approval, so the address cannot be probed. Link codes expire after one hour. A new explicit request replaces the previous unused code; only the latest code can be redeemed.
Redemption confirms success privately and asks the person to send their message again. Every one of these is written in the same
transaction as the row it explains, so a crash cannot swallow the answer.

## 6. Identity linking

Linking proves which Opensteer account a provider user is, and it is **sender-pull**: the bot
hands the code to the provider user, and that user redeems it on the Messaging page of the web
app while signed in (`channel.identity.link`); the notice links straight to that page. Nobody has to mint a code for somebody else, and the code travels only
to the person it is for (actor audience). A code lives one hour, is stored hashed, and redemption
requires an authenticated session, which is why there is no lockout: the keyspace is `32^8` per
hour against a caller the Host already knows.

A code is a secret, so it only ever goes where nobody else can read it. The manifest's
`actorDelivery` says whether the provider can reach one person inside a conversation:
`in-conversation` (Slack, whose ephemeral messages do exactly that) means the code is handed over
where the person wrote, and `direct-message-only` means no code is minted for a conversation that
is not a `dm` at all — the conversation is told to ask for one by direct message instead. That is
the Host's decision, made from the catalog manifest, not the adapter's.

## 6a. Conversation scope, admission, and authority

`ChannelAccessPolicy` separates channels from direct messages. Its `channels` arm has a scope
(`off`, `selected`, or `all`), a list of provider conversation IDs for `selected`, and a sender
policy. Group DMs use this arm too: a group is a shared conversation, never a private DM. The
`directMessages` arm has its own sender policy. Selectors remain routing constraints applied
before policy; a channel admitted by policy still has to match the binding's selector.

The setup default is selected channels admitting anyone, with DMs limited to the owner. Slack
channel links are accepted by the UI, so people need not learn route selectors. Inviting the bot
to a Slack channel is still required by Slack. Installation, channel membership, and Opensteer
admission are separate facts; a valid token alone does not prove any human's identity.

Sender policies:

- `off`: do not admit this surface.
- `anyone`: admit every external sender within the selected conversation scope.
- `owner`: admit only the external identity linked to the binding creator.
- `approved`: admit external identities approved by the connection owner, plus the verified owner.
- `linked-members`: advanced mode, admitting linked active Workspace members as themselves.

`allowedExternalUserIds`, when nonempty, is an additional restriction within that sender policy.
It never grants access by itself. There is one persisted policy format, no legacy runtime policy
interpretation.

All modes except `linked-members` execute as the binding creator, regardless of whether the
sender has separately linked an Opensteer identity. The external principal remains the actor
for attribution. Shared execution uses the Workspace capability profile, never the owner's
personal Main profile. This does not create an OS sandbox: the chosen Runner and thread access
mode still determine filesystem and command permissions.

The one exception is a person writing to their own bot: a direct message whose sender is linked
to the authority user, routed to that user's own Main, is their main agent and takes the `main`
profile. A channel or group conversation stays `workspace` even when only the owner writes in it,
because others share it. A profile change rotates the context to a fresh root.

Main inheritance belongs to a Thread's lineage, not to the Workspace it runs in
(`IntegrationPlatformStore.mainAccess`). A Thread in its owner's Main reaches the owner's
connections only when its lineage root has the `main` profile. A channel root below Main, and
everything it delegates, sees only integrations granted to that Workspace explicitly, and
`integration_request`/`integration_propose` for that Main are refused, since Main access is
fulfilled by inheritance this lineage does not have. Route such a conversation to a specialized
Workspace to give it integrations.

Each `(conversation, authority user)` has its own context. Changing policy revision or execution
placement starts a fresh root Thread with no parent/provider-context inheritance. Different
linked members cannot reuse each other's private provider conversation; shared-owner messages
consistently use the owner's shared context. Admission is checked again at the Thread Inbox,
including current binding revision, membership, and grant status. Policy and grant changes use
expected revisions so stale UI actions cannot overwrite newer decisions.

Admission does not grant permanent execution authority. Queued commands, Runner binding, and
final command dispatch recheck the current policy and sender grant. Final dispatch holds those
locks until the Runner accepts the command, so a policy change or revocation cannot slip between
the last check and the send. Revoking one sender cancels that sender's pending approved inputs,
without cancelling unrelated shared-channel work. Paused connections cannot adopt queued ingress
or dispatch new commands; resuming allows still-valid pending ingress to be reconsidered.
Changes do not undo work the Runner already accepted.

Host API epoch 3 introduced these incompatible command and admission semantics; clients older than
it stopped through normal version negotiation rather than interpreting the new policy.

## 6b. Requests and verification

An unknown sender under `approved` creates one durable pending access grant for the binding and
external identity, and gets a private acknowledgment — except where anybody can write (§5), where
they get nothing until approved. It creates no Thread or Run. The connection
owner can approve or decline it on Messaging; approved people can later be revoked. Decisions are
stored with operator, timestamp, and revision and produce a private status delivery. Approval
admits the person's **next** message; the old request message is not executed after a delay.
Declined or revoked people do not recreate their own request by repeatedly messaging the bot.

Identity linking is only needed for `owner` and `linked-members`; it is independent of an access
grant. A person invited to a shared channel or approved for DMs does not need an Opensteer
account. For a Personal Deployment, the verification notice directs the owner to Messaging on
the computer running Opensteer instead of presenting a loopback URL that opens the wrong machine
on a phone. Server Deployments use their canonical sign-in URL. The same Host commands, stores,
and checks apply to desktop Personal, self-hosted server, and managed server Deployments.

## 7. Where the service runs

A self-hosted stack runs it as the `channel-runtime` compose service; the desktop app runs it
as a fourth supervised process of a Personal Deployment, enrolled with a messaging-only token
the app keeps in its protected secret store, so the same token is presented on every start and
the Host's idempotent enrollment accepts it. Slack's Socket Mode is outbound-only, which is what
lets a laptop behind NAT hold the transport. The desktop reports messaging as its own component:
`starting` until the service's readiness route says it has attached to the Host, `ready` after,
and if the process exits it is restarted alone on its own bounded budget, never the Host or the
Runner; a spent budget or a service that never attaches becomes a `messaging-unavailable` issue
on a Deployment that stays ready.

## 7a. Transports that run on one computer

iMessage has no provider API: the bot is an Apple account kept for it, signed into Messages on one
Mac, and the Opensteer Computer Use helper there reads `chat.db` and sends through Messages
(`docs/computer-use.md`, "iMessage channel"). Such a transport is kind `computer`, and its
manifest names the computer app it is a use of (`computerApp: "apple-messages"`); the manifest
schema requires that a `computer` transport is the only one, with no credential fields.

- **Pinned, no secret.** `channel.connection.computer.create` names the Mac. The connection's
  `runnerId` is that Mac, never reassigned (`reassignDisconnectedRuntimeConnections` skips the
  kind), and it holds no credential; `delivery.claim` and `credential.resolve` lease empty
  secrets. The Mac's Runner carries the adapter in its own `messaging` module
  (`apps/runner/src/messaging/prepare.ts`), which every computer's grant now includes.
- **A use of the app.** Creation requires the owner's live `apple-messages` connection on that Mac
  at read and write (`sourceConnectionId`, checked under its row lock). While that connection is
  narrowed to reading, the channel answers nobody — a text is ignored as `source-withdrawn` and a
  delivery that has not started ends `dead` — and widening it again restores the channel.
  Removing the app, the Mac or the installation revokes the channel in the same transaction
  (`revokeComputerConnectionsInTransaction`), and the Host tells the Mac's module at once
  (`ChannelService.syncRuntimes`). The table constraint
  `integration_connections_computer_channel_shape` holds the shape.
- **The owner is known in advance.** Setup takes the handles the owner texts from; they are
  normalized (`normalizePersonalAddress`: email lower case, phone `+` and digits) and linked to the
  owner at creation, and every sender the Mac reports goes through the same function. Direct
  messages are `approved`, channels off: anybody else waits silently for the owner (§5).
- **Where to start, and where it got to.** Setup records the newest row in Messages as the
  account's `initialCursor`, so texts from before setup are never answered; the Host drops it
  once the Mac first reports `connected`. From then the Mac's Runner keeps the channel's cursor
  in `<data dir>/messaging/imessage-cursors.json` and moves it past a row only once the Host has
  recorded it; a Runner that has no cursor for a channel that has connected stops for attention
  rather than replay or skip.
- **Once per reply.** A reply is sent with its delivery id as the key, and the helper sends a key
  once, so `reconcile` answers `unknown` and the send that follows is the lookup. The helper
  persists the attempt before sending and keeps confirmed receipts and unconfirmed attempts
  across restarts. A lost transport answer can be retried with the same key; an unconfirmed
  attempt reported by the helper ends the delivery with an explanation to check Messages,
  without sending again. Definite non-sends remain retryable. One channel at a
  time holds an Apple account on a Mac, and a Mac signed into a different account holds the
  channel for attention rather than answer as somebody else. Only what the bot's own account
  received is read, whatever else that Mac's Messages holds from other accounts.
- **Fixed at the Mac, resumed by itself.** A refusal the person fixes on the Mac — a missing
  grant, Messages signed out or into another account, the account held by another Opensteer —
  is reported as needing attention while the transport keeps trying, so the channel resumes,
  with the texts that came meanwhile, once it is fixed. A non-`transport` issue always needs
  attention; `retryable` says only whether the transport keeps trying
  (`packages/messaging-module/src/connection-supervisor.ts`).

## 8. Health and assignment

The service reports each connection as `connecting | connected | needs-attention`; a
`ChannelConnectionError` that is not retryable, or whose issue is not a `transport` one, is the
only way to `needs-attention`, and only a retryable one keeps the session trying. The relay hub keeps
a service's account assignments through a stream blink for exactly the stream lease, so a
reconnect does not migrate a Slack workspace to another service and back. Credential rotation
bumps `credentialGeneration` on the descriptor the service receives, which restarts that one
adapter session with the new secrets.

**One Host process, by design.** The relay hub's account assignments live in that process's
memory: which computer currently drives which provider workspace is decided by whichever Host the
messaging services attached to, and there is nothing durable to reconcile two of them against. A
second replica would hand the same Slack workspace to two sockets and reorder deliveries. Both
shipped Hosts run exactly one replica — the compose service and the Kubernetes Deployment — and
the Deployment authority lease is what keeps it that way.

Terminal rows are pruned after seven days (`ChannelStore.pruneHistory`, hourly). Seven days is
longer than any provider's redelivery window, so pruning never reopens a dedupe hole.

## 9. Adding a provider

1. `packages/channel-<provider>`: export `create<Provider>Adapter()` returning a `ChannelAdapter`.
   Implement `run` so it emits one normalized event per provider message, never acknowledges
   before `onEvent` resolves, and calls `onReady` once the transport is actually carrying
   messages — an adapter that never calls it never becomes `connected`, and nothing is ever
   delivered through it; implement `send` for one message per delivery, honouring
   `audience`; implement `reconcile` by looking the delivery id up, or return `unknown` and
   document the duplicate you accept. Unit-test with an injectable transport.
2. Add the manifest to `channelProviderCatalog` in `packages/channel-core/src/catalog.ts`:
   credential fields with their `uses`, `maxMessageChars`, `actorDelivery` (§6 — whether the
   provider can reach one person inside a conversation, which decides where a link code may go),
   the setup artifact if the provider supports one, and the transport kinds the adapter supports.
   The catalog is the **one** description of a provider: the Host reads manifests from it and
   never from a connected computer, so two computers can never disagree about one.
3. Register it in `apps/channel-runtime/src/main.ts`, or — for a `computer` transport — in the
   Runner's `prepareMessagingModule`. Every app bundles its dependencies, so the registry is a
   static list on purpose.

The Host admission rules, queues, grants, linking, and status notices are shared. Generic
credential setup works from the manifest; providers with unusual installation steps can add a
focused setup presentation without changing authorization or transport ownership.

## 10. Verifying

The queues, adoption, linking, deferral, splitting, ordering, reconciliation and pruning are
exercised against real PostgreSQL by `apps/host/src/channels/channel-pipeline.integration.test.ts`
through the real `ChannelService`, and the whole path from a fake Slack socket to a fake Slack
post — real Host service, real messaging-service classes, real Slack adapter — by
`apps/host/src/channels/messaging-end-to-end.integration.test.ts`, and the store paths by the `packages/database/src/store-*.integration.test.ts` partitions ([file list](../scripts/README.md#integration-databases)). The
Slack adapter is exercised with a fake WebSocket and a fake `fetch` in
`packages/channel-slack/src/{connection,events,outbound,mrkdwn}.test.ts`. The messaging module's stream handling is covered
in `packages/messaging-module/src/*.test.ts`, including the request/response lane separation that a
sync handler depends on. iMessage runs end to end in
`apps/host/src/channels/imessage-channel.integration.test.ts` — a real Host, a Mac Runner's real
modules as the Runner prepares them, and only the desktop's end of the bridge faked — which writes
its `result.json` to `OPENSTEER_IMESSAGE_E2E_ARTIFACT_DIR`; the adapter's cursor and refusal
rules are in `packages/channel-imessage/src/adapter.test.ts`.
