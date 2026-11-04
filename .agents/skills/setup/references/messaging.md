# Messaging

**Slack.** Create an app at https://api.slack.com/apps from the setup manifest in
[catalog.ts](../../../../packages/channel-core/src/catalog.ts). Enable Socket Mode, install it, get
the bot OAuth token and an app-level token with `connections:write`, and enter them in Settings →
Messaging. Invite the bot to each channel. Routes and sender admission are configured separately; an
integration OAuth sign-in does not configure messaging.

**A new provider.** Implement `ChannelAdapter` in `packages/channel-<provider>` with an injectable
transport. Commit `onEvent` before acknowledging, call `onReady` only when carrying messages, honor
actor audience, and reconcile delivery IDs or document the duplicate risk. Add its manifest to the
catalog and register its factory in [main.ts](../../../../apps/channel-runtime/src/main.ts), or
`prepareMessagingModule` for transports on one computer. Authorization stays in the Host.

```sh
pnpm exec vitest run packages/channel-slack/src/connection.test.ts packages/channel-slack/src/events.test.ts packages/channel-slack/src/outbound.test.ts packages/channel-slack/src/mrkdwn.test.ts
pnpm test:integration -- apps/host/src/channels/messaging-end-to-end.integration.test.ts apps/host/src/channels/channel-pipeline.integration.test.ts apps/host/src/channels/imessage-channel.integration.test.ts
```

Swap in another provider's adapter tests. The iMessage test fakes the desktop bridge; real Messages
runs only in the VM and real Apple account behavior needs manual qualification. At the cheapest
layer, confirm DM, mention and followup routing, private identity notices, admission and revocation,
and uncertain-send recovery.
