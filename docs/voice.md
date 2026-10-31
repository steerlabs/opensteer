# Voice

Voice is an input and output mode of the person's client, like dictation. A
call has its own agent that decides, turn by turn, whether to answer, change
what the screen shows, or hand work to Chat. It acts only through the client
holding the call, so it can do nothing that client could not. Nothing about a
call is durable, and no voice state carries authority.

## Ownership

- **Client** ([`packages/client/src/voice`](../packages/client/src/voice)) owns
  the call: microphone, WebRTC, carrying out the agent's tool calls, and what
  the agent is told the person sees. Audio flows between the device and the
  vendor only; it never reaches a Host or Runner.
- **Host** relays `voice.*` without keeping state. Every call, not just start,
  re-resolves the authorized profile for (user, environment, account), so
  revocation ends a call within one lease.
- **Runner** creates the call with an account it holds, so the vendor
  credential never leaves that computer. It owns the call's life: idempotent
  start per client-chosen session id, one call per person per Runner (the
  newest replaces the older), a renewable lease and a hard cap
  ([`voice.ts`](../packages/protocol/src/voice.ts)), and the agent's pending
  tool calls.

The vendor sits behind `VoiceProvider` and the platform behind
`VoiceMediaPort` ([contract](../packages/client/src/voice/contract.ts)). A
vendor that hands the client an ephemeral token, or an on-device recognizer,
implements the same provider without the Runner.

## Codex realtime

Stage 1 uses Codex's realtime voice on a ChatGPT plan. It is an experimental,
undocumented Codex API; every engine pin bump must re-qualify a live call
(`pnpm test:engines` drives one, with speech, on the person's own login).

- Only V3 over WebRTC works on a plan; the websocket transport needs an API
  key. The app-server defaults WebRTC to V1, which the plan path refuses, so
  always send `version: "v3"`. Text output needs V2, so the call speaks.
- The browser's `oai-events` data channel delivers the voice events (the
  person's finished utterance is a user `turn.done`). Never write to that
  channel: an event the backend does not accept closes the call.
- The voice model is generative: it fills, paraphrases and claims to act
  whatever its instructions say, so it is never the one that acts. Codex
  delegates each finished utterance to a turn of the call's own thread; that
  turn is the agent, and the voice speaks its final message only after its
  tools have returned. Keep Codex's built-in realtime prompt and its automatic
  hand-back: overriding either lets the voice speak for itself.
- The agent's thread keeps the title-generation lockdown (read-only, no MCP,
  skills, project instructions or approvals) and gets exactly the dynamic
  tools the client carries out, at low reasoning effort for latency.
  `thread/inject_items` updates its context, including mid-turn.
- `thread/realtime/appendText` adds context only; it never starts a turn.
- Codex keeps a TRACE SQLite log, including realtime events, in the account's
  state home with its own 10-day retention, exactly as Codex's own voice does;
  no setting disables it. The call cannot move that home: a fresh one blocks
  app-server startup until it has backfilled every session in the Codex home.
  Only the call's text `log_dir` lives in its private temporary directory.

## The call's agent

- No rule routes an utterance. The agent's instructions explain what it is
  for and what it cannot do (it forgets everything when the call ends and
  cannot do work itself), and it decides.
- Tool calls reach the device by long-polling `voice.next`. The Runner keeps a
  call until it is answered and delivers it again, so the client carries out
  each call id at most once per session and repeats its first answer. An
  unanswered call fails with an unknown outcome, never as "nothing happened".
- Links name exactly what was offered: a place link is an opaque per-call
  reference to the exact destination, including an owner view's generation,
  and resolves only while that destination is still offered.
- Hand-off is the agent's decision but the person's words: Chat receives the
  person's own recent utterances verbatim, never text the agent wrote. Titles
  and pages in the agent's context are untrusted, and Chat treats a human
  message as instructions.
- While a call is on, the client speaks Chat's new durable replies and
  announces new "needs you" Requests by Thread title only, never their
  contents. Approvals still need a tap or Face ID.
- A call negotiates the agent with `voice-agent-v1` on Host and Runner. Without
  it the call is legacy: the client sends every finished utterance to Chat
  verbatim and nothing else changes the screen.

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
