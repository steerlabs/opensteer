# Dictation

Dictation turns speech into message text in the composer. Apple's on-device
`SpeechAnalyzer` with `SpeechTranscriber` does the recognition on the person's own Mac
or iPhone. Audio never leaves that device's native process and is never written to
disk; only text, an input level and the session's lifecycle reach JavaScript. No Host,
Runner or server takes part, and dictated words reach the Host only when the person
sends the message.

There is one engine and no substitute. Where it cannot run, the composer has no
microphone button rather than a different recognizer.

## Contract

[`@opensteer/protocol/dictation`](../packages/protocol/src/dictation.ts) is the single
authority for the shapes every platform implements and the composer consumes:
`DictationAvailability`, `DictationEvent` and the `DictationPort` commands.

- **Availability** never prompts, downloads or opens the microphone. It is either a
  resolved language (the first of the system's preferred languages Apple supports,
  never a substituted one), whether its model is installed, and the microphone
  permission; or the reason the button is absent. A denied microphone stays available
  because Settings can fix it; device policy (`restricted`) cannot be fixed, so it is
  a reason for absence.
- **Commands acknowledge; events decide.** `download`, `start`, `stop` and `cancel`
  resolve when accepted. Every outcome, including a start that cannot begin, is exactly
  one `ended` event for that session, and nothing follows it. `error` is present on
  every `ended`, non-null exactly when the reason is `failed`. A rejected command means
  the transport failed.
- **Sessions are fenced.** The controller creates each session id; native code echoes it
  unchanged. `seq` starts at 1 and rises by one per event, so a receiver ignores stale
  events and treats a gap as a failure, keeping the text it already has.
- **Text arrives as segments.** A `text` event carries the segments finalized since the
  previous one and the whole current tentative tail, both in audio order. Native code
  sends each segment exactly as Apple produced it: it never adds, trims or joins
  whitespace or punctuation. The composer controller alone decides whether one space
  goes between two segments, and between the transcript and the draft around it, so
  `["Hello.", "Next"]` reads `Hello. Next` while `["日本語", "です"]` reads `日本語です`
  on every platform.
- **Bounds** are in UTF-16 code units. Real dictation stays far below them, so exceeding
  one fails the session rather than truncating it.

## Composer controller

Create one DictationController from @opensteer/client/dictation per app runtime
and share it across composers. Supply the platform port and a lowercase UUID v4
generator; clock and timers can be injected. Call refresh() at startup, on focus
or foreground, and after returning from microphone Settings. Availability starts
unknown (hide the mic); denied permission keeps the mic visible with Open Settings.

Subscribe with useSyncExternalStore(controller.subscribe, controller.getSnapshot).
Snapshots retain identity between changes. Subscribe the waveform separately with
subscribeLevel; levels never publish snapshots. Dispose the controller at runtime
teardown. Each target has a stable owner, reads the latest draft, and commits into
that original draft even after its composer leaves.

The state machine is idle → starting → listening → finishing → idle, or idle →
downloading → idle. A download never starts capture automatically. Disable other
owners' mic controls while a session is active. Each composer renders
dictationView(snapshot, owner): whether the mic shows, whether another composer
blocks it, its own phase, preview, progress, timer start and notice, and the
language label (the active session's, so a refresh mid-session cannot relabel it).
stop and cancel take the owner, so one composer can never finish or discard
another's words. Render shared presentation labels and status formatters from the
same export; notices only promise kept words when they reached the draft.

Preview stays null until speech arrives. Then render its text over the unchanged
draft, and apply its UTF-16 selection only when the preview text changes. Selection
moves alone do not relocate dictation. On completion the controller inserts final
segments at the captured selection, or appends if the draft changed externally.
Any ending other than cancel also keeps a tentative tail the person already saw; native code finalizes first, so one remains only when that was cut short. Cancel discards the preview.

For Send/Enter, await stop(owner) (one shared promise per session; another owner's call returns idle and touches nothing). Send the explicit
text on committed; use the current draft on idle/empty; never send on failed/aborted.
Re-check existing send gates and mounted ownership after awaiting, and deduplicate
Send presses in the composer. Typing, paste, cut, delete and IME start must adopt
the displayed edit into the draft and call release(owner) in the same handler.
Selection moves are not edits.

Call leave(owner) on unmount, hide or thread switch: starting cancels; listening
stops and commits; finishing continues into the original target. Send waiters abort
immediately. Downloads continue across composer changes. Native owners handle
window destruction. The ten-minute timer starts on listening and stops with a limit
notice. Sequence gaps and rejected commands retain received text and cancel native
work through the same idempotent termination path.

Show notices only for their owner. The next mic action, an edit in that composer,
or dismiss clears them; empty/downloaded dismiss after five seconds. Announce
state changes and notices once, rather than announcing text, level or timer ticks.

## Desktop composer

The web runtime shares one controller backed by the optional desktop dictation
bridge. Availability refreshes on startup, focus and return to a visible window;
unsupported browsers have no microphone control. Each composer scopes ownership
to its deployment, user, thread and instance, and leaves when hidden or unmounted.
Live words appear at the captured selection without changing the draft. Cancel
restores the original words and selection; typing or starting IME composition
adopts the displayed text and releases dictation. Escape keeps the words, while
Enter and Send finalize before submitting through the existing send gates.

The toolbar replaces its model slot with shared live-state copy, a separately
subscribed level meter and a one-second timer. The mic becomes an accent Stop
control while listening and a spinner while waiting; Cancel stays beside the live
state. Narrow conversation composers keep a full-width draft above a permanent
toolbar row; wider conversation composers retain their single-line layout.
Persistent notices appear above the draft. Unsupported browsers create no
controller or lifecycle listeners. A polite live region announces states and notices without
reading partial words, levels or timer ticks. Reduced motion keeps the meter static.
`dictation-visual.html?state=listening` is the fake-port visual fixture; its `state`
parameter also accepts idle, downloading, starting, finishing and every notice kind.

## Engine

`packages/apple-dictation` shares capture and recognition between the Mac helper and
iOS. Only its Apple Speech adapter needs OS 26; lifecycle and wire tests also run on
older systems, where availability reports `os`. Admission checks permission, resolves
the first supported preferred language and requires an installed model before capture.
Availability reconciles reservations; download keeps one for that language and releases
new reservations on unsuccessful installation. Inventory operations share a service-wide serial
coordinator, including suspended reservation calls. Terminal events arrive promptly; the next
session waits for native cleanup. Equivalent ICU and BCP-47 locale identifiers retain the same
reservation. Input configuration notifications end capture only when its input identity or format
changes, or a restart fails. Unchanged-input engine reconfiguration reinstalls the tap and
restarts capture, serialized with teardown; output-only route changes do nothing. The level ticker
samples capture independently of analyzer preparation and backpressure.

Results replace overlapping audio ranges and promote at Apple's finalization watermark,
including unchanged tentative results. Text coalesces every 100 ms, retaining every newly
finalized segment. Stop removes capture, drains the bounded ten-second queue and converter,
finishes input, finalizes and consumes results, then flushes text before ending. Cancellation
supersedes admission and finalization. One five-second deadline from stop acceptance covers
preparation, draining, converter flush, input completion, finalization and result consumption;
a timeout flushes recognized text before ending with `recognition-failed`. Stopping a model
download cancels it rather than reporting installation success. Overflow and
wire limits (1,000 segments per array, 50,000 UTF-16 units per segment) fail explicitly.

iOS uses `.record` / `.measurement` with Bluetooth HFP for minimally processed speech
and headset microphones, deactivating with notification so other audio resumes. Audio
stays in memory within the native process. Microphone tests require a disposable device;
the opt-in live engine test uses a generated speech file instead.

## iPhone

The iOS composer shares one controller across the app runtime. Its optional Expo
module (`apps/mobile/modules/dictation`) wraps the shared Swift engine; Android
resolves a null port. Availability refreshes on launch and foreground. Only a
microphone usage description is required: no speech authorization or background
audio mode is requested.

The mic beside Attach downloads the preferred language when needed; tap again
when ready to dictate. Live words replace the selected range without changing the
saved draft until completion. Stop keeps words, Cancel restores the draft, and
Send waits for the final words before rechecking the normal send gates. Typing
adopts the displayed words and cancels recognition. Navigation blur and unmount
finish into the original persisted draft without sending.

The native module interrupts under a background task when the app backgrounds,
restores the previous idle timer on every exit, and cancels on teardown. If the
background task expires, cancellation is presented as an interruption and the
controller retains text already delivered, including the tentative tail. Levels
and elapsed time update separate components; VoiceOver announces lifecycle and
notices, and Reduce Motion uses static level bars. Native lifecycle tests run in
the iPhone CI lane. Real audio, VoiceOver, haptics and keyboard behavior still need
a disposable device journey; compile-only simulator builds do not verify them.

## Mac

Electron main lazily installs and starts `Opensteer Dictation.app` through the
signed-helper lifecycle on Apple silicon and macOS 26 or newer. Release and
ad-hoc development helpers have separate bundle identities, install roots and
sockets. The helper is launched through LaunchServices so microphone consent
belongs to it. Opensteer itself holds no microphone grant.

The socket authenticates both peers using audit tokens and code requirements.
`@opensteer/protocol/dictation-helper` envelopes the unchanged dictation payloads
in bounded length-prefixed JSON. A connection owns its session; losing it cancels
capture or download. Main additionally checks the owning WebContents for every
stop/cancel and delivers events only there. Destroying, crashing or reloading
that renderer cancels its work. Sleep and screen lock finalize with an interrupt;
quit closes the connection immediately. Sequence gaps fail recognition; malformed
frames close the connection. The next availability request reconnects after a
helper exit. Start/download admission uses the same platform eligibility gate as
availability. Both main and helper reject used session IDs before acquiring ownership;
replays cannot produce another terminal event or block a later session.

Build without launching with `pnpm --filter @opensteer/desktop build:dictation-helper`.
Host-safe tests cover wire encoding and ownership. The post-merge VM dictation
journey must exercise first microphone consent, live transcription, stop, cancel,
window destruction, sleep/lock and helper relaunch on macOS 26+ Apple silicon.
