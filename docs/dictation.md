# Dictation

## Privacy and availability

Apple's on-device SpeechAnalyzer/SpeechTranscriber is the sole recognizer. Audio
stays in native process memory and never goes to disk, JavaScript, a Host or Runner.
Only text, levels and lifecycle cross the bridge; words reach the Host on Send.
Hide dictation where unsupported rather than substituting a cloud recognizer.

Availability must not prompt, download or open the microphone. Resolve the first
supported preferred language without substitution. Denied microphone access can be
repaired in Settings; restricted device policy cannot. Download never starts capture.
The Speech adapter needs OS 26; logic/wire tests can run on older systems.

## Ownership and ordering

Use one `DictationController` per runtime across composers. Its target includes
Deployment, user, Thread and composer instance; finishing commits to that original
draft after navigation. One composer cannot stop or discard another's session.

Commands acknowledge admission; ordered, session-fenced events decide outcomes.
Every accepted session ends exactly once, with no later events. Gaps fail while
preserving received words. Rejected commands indicate transport failure.
Native sends Apple's segments unchanged; only the shared controller joins them.
Selections and wire bounds use UTF-16. Exceeding bounds fails rather than truncates.
See `packages/protocol/src/dictation.ts` and `packages/client/src/dictation`.

Keep the draft unchanged under preview. Selection movement alone does not relocate
insertion. Editing or IME start adopts displayed text and releases dictation in the
same handler. Completion inserts at the captured selection, or appends if the draft
changed externally. Non-cancel endings retain visible tentative words; cancel discards them.

Send awaits finalization, then rechecks ownership and send gates; failed or aborted
finalization must not send. Deduplicate concurrent Send presses. Leaving while
starting cancels; leaving while listening stops and commits; finishing continues
into the original target, while Send waiters abort. Downloads survive navigation.
Do not announce partial text, waveform or timer ticks to assistive technology.

## Native traps

`packages/apple-dictation` owns shared capture, model reservations and teardown.
Serialize inventory operations even across suspended calls; equivalent ICU/BCP-47
locales share a reservation. Terminal delivery may precede cleanup, but the next
session must wait. The mic opens as soon as permission allows; up to 10 seconds
of audio stay in memory, in order, while recognizer admission and preparation
complete. Overflow fails explicitly. Cancellation supersedes admission/finalization;
stop flushes recognized text before ending, including timeout. Input
identity/format changes end capture; output-only route changes do not.

iOS uses record/measurement with Bluetooth HFP for headset microphones and
deactivates with notification so other audio resumes. Microphone tests need a
disposable device; a generated-speech engine test does not qualify live capture.
Use [test-mobile-dictation](../.agents/skills/test-mobile-dictation/SKILL.md).

## iPhone

The iOS composer shares one controller across the app runtime. Its optional Expo
module (`apps/mobile/modules/dictation`) wraps the shared Swift engine; Android
resolves a null port. Availability refreshes on launch and foreground. Only a
microphone usage description is required: no speech authorization or background
audio mode is requested.

The mic beside Send downloads the preferred language when needed; tap again
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

The Mac helper, `Opensteer Dictation.app`, runs only on Apple silicon with
macOS 26 or newer. Electron main installs and starts it lazily through the
signed-helper lifecycle; release and ad-hoc development builds have separate
bundle identities, install roots and sockets.

- Dictation microphone consent belongs to the helper, launched through LaunchServices.
  Voice mode separately requests microphone consent for the Electron app.
- Both socket peers authenticate with audit tokens and code requirements.
  Frames are bounded length-prefixed JSON
  ([`@opensteer/protocol/dictation-helper`](../packages/protocol/src/dictation-helper.ts)); a
  malformed frame closes the connection and a sequence gap fails recognition.
- A connection owns its session, and losing it cancels capture or download.
  Main also checks the owning WebContents on every stop and cancel and delivers
  events only there; destroying, crashing or reloading that renderer cancels its
  work.
- Sleep and screen lock finalize with an interrupt; quit closes the connection
  at once. After a helper exit, the next availability request reconnects.
- Start and download use the same eligibility gate as availability. Main and
  helper both reject a used session ID before taking ownership, so a replay
  cannot produce another terminal event or block a later session.

Host-safe tests cover wire encoding and ownership. First microphone consent,
live transcription, stop, cancel, window destruction, sleep and lock, and helper
relaunch belong to the post-merge VM dictation journey. Build the helper without
launching it with `pnpm --filter @opensteer/desktop build:dictation-helper`.
