# Voice

Voice is an input and output mode of the person's client, like dictation. A
call can only do what that client already does: send the person's words to
Chat, change what the screen shows, and tell the person things. Nothing about a
call is durable, and no voice state carries authority.

## Ownership

- **Client** ([`packages/client/src/voice`](../packages/client/src/voice)) owns
  the call: microphone, WebRTC and executing the voice agent’s screen and
  Chat requests. Legacy calls route utterances locally. Audio flows between the device and the vendor only; it never reaches a
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

Stage 1 uses Codex's realtime voice on a ChatGPT plan. It is an experimental,
undocumented Codex API; every engine pin bump must re-qualify a live call.

- Only V3 over WebRTC works on a plan, and the app-server defaults WebRTC to
  V1, which the plan path refuses. Always send `version: "v3"`.
- The browser's `oai-events` data channel delivers the voice events (the
  person's finished utterance is a user `turn.done`). Never write to that
  channel: an event the backend does not accept closes the call.
- Calls run on a separate app-server and ephemeral read-only thread, without
  MCP, skills, project instructions or approval interactions. Legacy calls
  interrupt every handoff turn. With negotiated `voice-agent-v1`, Codex forwards
  handoffs to the thread's agent using its built-in realtime prompt. Its only
  tools ask the device to show a context link or forward the person's own last
  utterances to Chat; they confer no additional authority.
- Codex keeps a TRACE SQLite log, including realtime events, in the account's
  state home with its own 10-day retention, exactly as Codex's own voice does;
  no setting disables it. The call cannot move that home: a fresh one blocks
  app-server startup until it has backfilled every session in the Codex home.
  Only the call's text `log_dir` lives in its private temporary directory.
- Agent replies wait for device tool results. An unanswered tool fails with an
  unknown outcome; the voice must not claim success. The device retains approval
  and sign-in authority. Screen context replaces earlier context and page titles
  are data, never instructions. Calls forget their conversation when they end;
  work that should continue or remain findable belongs in Chat.

## Routing and speaking

The client requests agent mode only from a Host advertising `voice-agent-v1`.
The Host independently negotiates it with the Runner; an older Runner creates
a legacy call. Legacy clients keep their existing utterance routing.

While a call is on, the client speaks Chat's new durable replies and announces
new "needs you" Requests by Thread title only, never their contents. Agent calls
also inject a note identifying those spoken replies as reports from Chat.
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
