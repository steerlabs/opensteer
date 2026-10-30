---
name: configure-messaging
description: Use when setting up, adding, or testing a messaging provider and its channel transport.
---

Read `docs/messaging.md` and `packages/channel-core/src/catalog.ts`.
For Slack, create an app at https://api.slack.com/apps using the catalog's setup manifest. Enable Socket Mode, install it into the workspace, obtain the bot OAuth token and an app-level token with connections:write, and enter them through Messaging setup. Invite the bot to each channel. Configure routes and sender admission separately; an integration OAuth sign-in does not configure messaging.

For a new provider, implement `ChannelAdapter` in `packages/channel-<provider>` with an injectable transport. Commit onEvent before acknowledgment, call onReady only when carrying messages, honor actor audience, and reconcile delivery IDs or document duplicate risk. Add its manifest to the static catalog and register its factory in `apps/channel-runtime/src/main.ts`, or `prepareMessagingModule` for computer transports. Keep authorization in the Host.

Run only the affected focused checks:

```sh
pnpm exec vitest run packages/channel-slack/src/connection.test.ts packages/channel-slack/src/events.test.ts packages/channel-slack/src/outbound.test.ts packages/channel-slack/src/mrkdwn.test.ts
pnpm test:integration -- apps/host/src/channels/messaging-end-to-end.integration.test.ts
pnpm test:integration -- apps/host/src/channels/channel-pipeline.integration.test.ts
```

Replace adapter tests for another provider. For iMessage's Host/Runner contract use `pnpm test:integration -- apps/host/src/channels/imessage-channel.integration.test.ts`; the desktop bridge is faked there. Use the computer-use/VM guidance for real Messages interaction, never the host screen. Confirm DM, mention and followup routing, private identity notices, admission/revocation and uncertain-send recovery at the cheapest relevant layer. Stop started services after failures too.
