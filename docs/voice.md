# Voice

Voice is an input and output mode of the person's client, like dictation. A
call can only do what that client already does: send the person's words to
Chat, change what the screen shows, and tell the person things. Nothing about a
call is durable, and no voice state carries authority.

## Ownership

- **Client** ([`packages/client/src/voice`](../packages/client/src/voice)) owns
  the call: microphone, WebRTC, routing what was heard, and choosing what to
  say. Audio flows between the device and the vendor only; it never reaches a
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
- Every voice handoff starts or steers a Codex turn on the attached thread,
  and nothing turns that off. The call therefore runs on its own app-server
  and ephemeral thread with the title-generation lockdown (no tools, MCP,
  skills or project instructions; read-only; interactions refused), and any
  turn that starts is interrupted at once.
- Codex writes a TRACE SQLite log, including voice payloads, that no setting
  disables. The call's `sqlite_home` and `log_dir` live in a private temporary
  directory that is deleted when the call ends, so nothing reaches the
  person's Codex home or outlives the call.
- The voice model is generative. Instructions do not stop it answering simple
  questions itself or claiming it will act, and it does not follow structured
  formats. So it is never the router: every finished utterance goes to Chat
  unless the client's own navigation grammar takes it, and Chat stays the
  source of truth. Text sent with `appendSpeech` is spoken as a faithful
  paraphrase, shortened when long.

## Routing and speaking

- Navigation takes only whole utterances that start with a navigation verb
  and name exactly one Chat, task or place; "open" is not one ("open a PR" is
  work). Everything else is sent to Chat verbatim, as the person's message.
- While a call is on, the client speaks Chat's new durable replies and
  announces new "needs you" Requests by Thread title only, never their
  contents. Approvals still need a tap or Face ID.

## Privacy

The microphone is open only while a call is, with the voice bar always
visible. While on, the room's audio goes to the vendor on the person's own
account. Opensteer never logs SDP (it carries local addresses), transcripts or
spoken text.

## Platforms

- Web needs a secure context: localhost or https (Connect). A plain LAN
  `http://` page cannot open the microphone.
- The desktop app itself holds the microphone for voice, granted only to its
  own origin's main frame for audio; dictation still uses only its helper.
  See [SIGNING.md](../apps/desktop/SIGNING.md).
- Mobile uses `react-native-webrtc`; an older binary without it hides voice.
  A call ends when the app leaves the foreground.
