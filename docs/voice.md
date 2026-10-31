# Voice

Voice is an input and output mode of the person's client, like dictation. A
call can only do what that client already does: send the person's words to
Chat, change what the screen shows, and tell the person things. Nothing about a
call is durable, and no voice state carries authority.

## Ownership

- **Client** ([`packages/client/src/voice`](../packages/client/src/voice)) owns
  the call: microphone, WebRTC, navigation, and forwarding only the person’s words
  to Chat. Audio flows between the device and the vendor only; it never reaches a
  Host or Runner.
- **Host** relays `voice.*` without keeping state. Every call, not just start,
  re-resolves the authorized profile for (user, environment, account), so
  revocation ends a call within one lease.
- **Runner** creates the call with an account it holds, so the vendor
  credential never leaves that computer. It owns the call's life: idempotent
  start per client-chosen session id, one call per person per Runner (the
  newest replaces the older), a renewable lease and a hard cap
  ([`voice.ts`](../packages/protocol/src/voice.ts)).

The vendor sits behind `VoiceProvider` and the platform behind
`VoiceMediaPort` ([contract](../packages/client/src/voice/contract.ts)). A
vendor that hands the client an ephemeral token, or an on-device recognizer,
implements the same provider without the Runner.

## Codex realtime

Voice uses Codex's realtime voice on a ChatGPT plan. It is an experimental,
undocumented Codex API; every engine pin bump must re-qualify a live call.

- Only V3 over WebRTC works on a plan, and the app-server defaults WebRTC to
  V1, which the plan path refuses. Always send `version: "v3"`.
- The browser's `oai-events` data channel delivers the voice events (the
  person's finished utterance is a user `turn.done`). Never write to that
  channel: an event the backend does not accept closes the call.
- The call runs on its own app-server and ephemeral thread, isolated from
  Chat and project instructions. Legacy calls interrupt delegated turns; agent
  calls let a delegated turn decide what to say, show, or hand off. Navigation
  and Chat handoff execute on the client through the voice wire contract.
- Codex keeps a TRACE SQLite log, including realtime events, in the account's
  state home with its own 10-day retention, exactly as Codex's own voice does;
  no setting disables it. The call cannot move that home: a fresh one blocks
  app-server startup until it has backfilled every session in the Codex home.
  Only the call's text `log_dir` lives in its private temporary directory.
- A Host advertising `voice-agent-v1` can negotiate the call’s own delegated
  agent. The client executes its navigation and Chat handoff tools, with
  session-scoped links bound to exact current destinations. A navigation
  acknowledgement means the destination was selected, not that pixels rendered.
  Older Hosts and Runners retain the legacy call.

## Handoff and speaking

In an agent call, finished utterances remain in a bounded client buffer until
the call asks to send them to Chat. Only those verbatim user utterances become
the person’s message; agent text and screen titles never do. Legacy calls send
every non-empty finished utterance verbatim, including navigation requests.

While either call is on, the client speaks Chat’s new durable replies and
announces new "needs you" Requests by Thread title only, never their contents.
Approvals still need a tap or Face ID.

## Privacy

The microphone is open only while a call is, with the voice bar always
visible. While on, the room's audio goes to the vendor on the person's own
account. Opensteer never logs SDP (it carries local addresses), transcripts or
spoken text; Codex's own log on that computer is the one exception above.

## Platforms

- Web needs a secure context: localhost or https (Connect). A plain LAN
  `http://` page cannot open the microphone.
- The desktop app itself holds the microphone for voice, granted only to its
  own origin's main frame for audio; dictation still uses only its helper.
  See [SIGNING.md](../apps/desktop/SIGNING.md).
- Mobile uses `react-native-webrtc`; an older binary without it hides voice.
  A call ends when the app leaves the foreground.
