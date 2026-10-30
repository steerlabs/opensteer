# Messaging: channels, identities, and deliveries

## Ownership and transport

The Host owns durable messages, routing and authority; transports own no database or policy. Credential leases expose only manifest-declared fields for their purpose. The Host reads the static provider catalog, never a computer-supplied policy manifest. See `packages/channel-core/src/{adapter,catalog}.ts` and `packages/messaging-module`.

Run exactly one Host process. Relay assignments live in memory; replicas could connect the same provider workspace twice and reorder delivery. The Deployment authority lease enforces this. Socket Mode needs no inbound listener, so a laptop behind NAT can hold Slack's transport.

## 4. Delivery guarantees

Commit inbound content before acknowledging the provider; deduplicate provider event IDs and preserve ordering per conversation lane. Emit only addressed messages or participating-conversation followups, never ambient chatter or the bot's own output. Adoption and rejection notices commit together so a crash cannot silently swallow a message. Age starts at provider send time, including messages received after an offline gap; stale work must not execute as fresh work. See `packages/database/src/channel-store.ts` and `apps/host/src/channels/channel-pipeline.integration.test.ts`.

Persist notices to the originating conversation when a Run fails, is stopped, or needs human input, atomically with the corresponding state change.

Only final authored replies leave the Thread. Delivery is at least once: record attempt start before provider contact, reconcile an uncertain result using the stable delivery ID, and honor Retry-After. Slack metadata enables lookup; a negative lookup followed by resend can duplicate a message. Ephemeral messages cannot be reconciled. An adapter without lookup must explicitly document its duplicate risk. See `packages/channel-slack/src/outbound.ts`.

## Identity and privacy

Link codes are secrets: store hashes, require authenticated redemption and deliver only to the intended sender. Mint none in shared conversations when the provider cannot privately reach one participant; ask for a DM instead. Only the latest unused code is redeemable. Linking proves identity, not channel admission or Workspace membership.

Where anyone can write to the address, unknown/unapproved senders receive no actor notice, including approval acknowledgments; the address must not be probeable. Unadoptable conversation followups stay silent. Approval executes only the sender's next message, never the message that requested approval; declined/revoked senders cannot recreate requests by repeating messages. See `packages/database/src/channel-authority.ts` and the channel store tests.

## 6a. Conversation scope, admission, and authority

Provider installation, membership and Opensteer admission are separate facts. Group DMs use shared-channel policy. Existing conversations keep their binding; new conversations select the most specific matching route and refuse equal-specificity ties. Selectors constrain routing before admission; an external-ID allowlist restricts a sender policy but never grants access by itself.

Except for linked-members policy, execution uses the binding creator's authority while preserving the external actor for attribution. Shared conversations use the Workspace capability profile, even under the owner's Main; this profile is not an OS sandbox. Only an owner-linked DM routed to that owner's Main uses the main profile.

Main integration inheritance belongs to Thread lineage. A channel root below Main and all its descendants see only explicit Workspace grants; they cannot use or request Main inheritance. Route those conversations to a specialized Workspace for integration access. See `IntegrationPlatformStore.mainAccess` in `packages/database`.

Each conversation/authority pair has separate context. Policy, placement or profile changes rotate to a fresh root without provider-context inheritance, preventing one linked member from reusing another's private conversation. Admission rechecks current revision, membership and grants at the Inbox, Runner binding and final dispatch; hold the final locks until Runner acceptance. Revocation cancels the sender's pending approved inputs, not unrelated shared work. Pausing blocks adoption and dispatch. Changes cannot undo commands already accepted by a Runner.

The incompatible admission semantics require Host API epoch 3; never let older clients interpret the policy as their older contract. See `packages/database/src/channel-authority.ts`, `packages/database/src/channel-store.ts` and `apps/host/src/channels`.

## 7. Where the service runs

The channel runtime enrolls as a separate messaging-only Runner. Desktop must retain its protected enrollment token across restarts for idempotent enrollment. Restart a failed messaging process independently; messaging failure must not take down the ready Deployment. See `apps/channel-runtime` and `apps/desktop`.

## 7a. Transports that run on one computer

iMessage uses a dedicated Apple account in Messages on one Mac. Pin its credential-free channel to that Mac; never reassign it to another runtime. The owner's source apple-messages connection must remain read/write. Narrowing it stops ingress and unsent delivery; removing the app, Mac or installation revokes the channel transactionally. See `apps/runner/src/messaging/prepare.ts` and `packages/channel-imessage/src/adapter.ts`; helper permissions belong in [Computer use](computer-use.md).

Read only messages received by the bot's Apple account, regardless of other accounts on the Mac. A changed account or competing channel holds for attention rather than answering as another identity. Normalize owner handles identically at setup and ingress; other senders wait silently for approval.

Start after the newest setup row, then advance the persisted cursor only after Host commit. A missing cursor after initial connection requires attention, never replay or skip. The helper persists send attempts and receipts by delivery ID; retry a lost response with that same key. An unconfirmed send must stop with an explanation to check Messages, never send again. Definite non-sends remain retryable. See `apps/host/src/channels/imessage-channel.integration.test.ts`.

## Provider work

Use [configure-messaging](../.agents/skills/configure-messaging/SKILL.md) for provider setup, implementation and focused tests. Health/assignment code lives in `packages/messaging-module/src/connection-supervisor.ts` and `apps/host/src/channels`; credential rotation must restart only the affected adapter with its new generation.
