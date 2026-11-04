# Messaging: channels, identities, and deliveries

Provider setup and focused tests are in the [setup skill](../.agents/skills/setup/SKILL.md).

## Ownership and transport

The Host owns durable messages, routing and authority; transports own no database or policy.
Credential leases expose only the manifest-declared fields for their purpose, and the Host reads the
static [provider catalog](../packages/channel-core/src/catalog.ts), never a computer-supplied
manifest. Run exactly one Host process: relay assignments live in memory, so replicas could connect
one provider workspace twice and reorder delivery, and the Deployment authority lease enforces it.
Credential rotation restarts only the affected adapter.

The channel runtime enrolls as a separate messaging-only Runner. Desktop keeps its protected
enrollment token across restarts so enrollment stays idempotent, and a failed messaging process
restarts alone without taking down the Deployment.

## Delivery guarantees

Commit inbound content before acknowledging the provider, deduplicate provider event IDs and keep
order per conversation lane. Emit only addressed messages or participating-conversation followups,
never ambient chatter or the bot's own output. Adoption and rejection notices commit together, so a
crash cannot swallow a message. Age counts from provider send time, so stale work never runs as
fresh. Failure, Stop and needs-input notices commit atomically with their state change
([channel store](../packages/database/src/channel-store.ts)).

Only final authored replies leave the Thread. Delivery is at least once: record the attempt before
contacting the provider, reconcile an uncertain result by the stable delivery ID, and honor
Retry-After. A negative Slack lookup followed by a resend can duplicate a message, and ephemeral
messages cannot be reconciled; an adapter without lookup documents its duplicate risk
([Slack outbound](../packages/channel-slack/src/outbound.ts)).

## Identity and privacy

Link codes are secrets: store hashes, require authenticated redemption and deliver only to the
intended sender. Mint none in a shared conversation the provider cannot privately reach; ask for a
DM. Only the latest unused code is redeemable, and linking proves identity, not admission or
membership. Where anyone can write to the address, unknown or unapproved senders get no notice, so
the address cannot be probed. Approval executes only the sender's next message, never the one that
asked, and declined senders cannot recreate requests by repeating themselves
([channel authority](../packages/database/src/channel-authority.ts)).

## Conversation scope, admission, and authority

Provider installation, membership and Opensteer admission are separate facts. Existing conversations
keep their binding; new ones take the most specific matching route and refuse ties. An external-ID
allowlist restricts a sender policy but never grants access by itself. Except under linked-members
policy, execution uses the binding creator's authority while attributing the external actor. Shared
conversations withhold Main inheritance even under the owner's Main; only an owner-linked DM routed
to that owner's Main inherits it, and a channel cannot gain inheritance by delegating. Agents may
inspect, pause, resume or revoke channels but never connect accounts, link identities or approve
senders.

Each conversation and authority pair has its own context, and policy, placement or consent changes
rotate to a fresh root, so one linked member cannot reuse another's private conversation. Admission
rechecks revision, membership and grants at the Inbox, Runner binding and final dispatch, holding
the final locks until Runner acceptance. Revocation cancels the sender's pending approved inputs,
not unrelated shared work, and cannot undo commands a Runner already accepted.

## Transports that run on one computer

iMessage uses a dedicated Apple account in Messages on one Mac, and its credential-free channel is
pinned to that Mac. The owner's source `apple-messages` connection must stay read-write; narrowing
it stops ingress and delivery, and removing the app, Mac or installation revokes the channel. Read
only messages received by the bot's account, and hold for attention on a changed account or
competing channel rather than answer as another identity. Advance the persisted cursor only after
Host commit; a missing cursor needs attention, never replay or skip. An unconfirmed send stops with
a request to check Messages and is never sent again; definite non-sends stay retryable
([iMessage adapter](../packages/channel-imessage/src/adapter.ts)).
