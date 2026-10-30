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
session must wait. Cancellation supersedes admission/finalization; stop flushes
recognized text before ending, including timeout. Input identity/format changes
end capture; output-only route changes do not.

iOS uses record/measurement with Bluetooth HFP for headset microphones and
deactivates with notification so other audio resumes. Microphone tests need a
disposable device; a generated-speech engine test does not qualify live capture.
Use [test-mobile-dictation](../.agents/skills/test-mobile-dictation/SKILL.md).
