# Messaging

**Slack.** Create an app at https://api.slack.com/apps from the setup manifest in
[catalog.ts](../../../../packages/channel-core/src/catalog.ts). Enable Socket Mode, install it, get
the bot OAuth token and an app-level token with `connections:write`, and enter them in Settings →
Messaging. Then, on that account: **Link my account** shows a code to send the bot from your own
Slack account, which makes that identity "me"; **Add a chat** makes a connected agent for the
account's direct messages or for one channel (invite the bot there), choosing once who may give it
work. What a chat can use is set on its page under Connected agents. An integration OAuth sign-in
does not configure messaging.

**iMessage.** Set up on the Mac that is signed in to the bot's Apple account (Settings → Messaging →
iMessage), with the Messages app connected at read and send. Link "me" by texting the code from your
own phone. A message sent while the account is paused arrives when it is resumed; Slack does not
keep one.

**A new provider.** Implement `ChannelAdapter` in `packages/channel-<provider>` with an injectable
transport. Commit `onEvent` before acknowledging, call `onReady` only when carrying messages, honor
actor audience, and reconcile delivery IDs or document the duplicate risk. Add its manifest to the
catalog and register its factory in [main.ts](../../../../apps/channel-runtime/src/main.ts), or
`prepareMessagingModule` for transports on one computer. Authorization stays in the Host.

```sh
pnpm exec vitest run packages/channel-slack/src/connection.test.ts packages/channel-slack/src/events.test.ts packages/channel-slack/src/outbound.test.ts packages/channel-slack/src/mrkdwn.test.ts
OPENSTEER_LOCK_ORDER_MODE=enforce pnpm test:integration apps/host/src/channels/slack-journey.integration.test.ts
OPENSTEER_LOCK_ORDER_MODE=enforce pnpm test:integration apps/host/src/channels/imessage-channel.integration.test.ts
OPENSTEER_LOCK_ORDER_MODE=enforce pnpm test:integration apps/host/src/channels/bridge-ingress.integration.test.ts
```

Swap in another provider's adapter tests. The iMessage test fakes the desktop bridge; real Messages
runs only in the VM and real Apple account behavior needs manual qualification. At the cheapest
layer, confirm direct messages, mentions and follow-ups, that only "me" (or anyone, in an "anyone"
chat) starts work, that a pause holds and a resume delivers, and uncertain-send recovery. In mock
mode the web's `?mock-agents=chats` (or `chats-empty`) shows every chat state without a provider.
