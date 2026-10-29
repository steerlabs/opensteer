# Native event fixtures

These JSON files contain actual events from the shared `ProxyField` and explicitly
labeled independent native password and textarea comparison controls. Electron
captures use physical CGEvents in an isolated macOS VM; Android captures use
native Gboard taps in a headless emulator's Android System WebView. They retain
event order, value and UTF-16 selection. The macOS recorder is
`apps/web/src/components/remote-editing/native-trace.cjs`, with `native-keys.swift`.

Electron captures come from source `d679445234e758319a829b9d2b10ab68dfe350ce`, VM run
`20261027T212330Z-02c7f7cc`. Original evidence is under that run's
`guest/viewer-native-traces/` directory in the VM artifact store.

- `electron-us.json`: US typing, including keypress and native input echo.
- `electron-option-dead-key.json`: Option characters and dead-key composition.
- `electron-held-key-no-accent-picker.json`: the actual result of a held-key attempt
  was `e1`; this fixture does **not** qualify accent-picker behavior.
- `android-baseline-no-suggestions.json`: native `t e h Space` remains `teh ` with
  the old proxy attributes. Active EditorInfo was `0xa80a1`, including
  `NO_SUGGESTIONS`; this is a labeled baseline, not corrected-policy qualification.
- `android-baseline-missed-initial-key.json`: the first `h` tap did not reach the
  proxy. It replays delivered `ello ` events as a failed typing capture.

Android baseline source: `f8ceb76e44d50cd3f5c8e4cd2721b4394a02e26c`.
Provider: Android System WebView 133.0.6943.137, Android 16 / API 36.

- `android-gboard-typing.json`: corrected attributes, native `hello Space`.
- `android-gboard-autocorrect.json`: native `teh Space` correction deletes verified
  `teh`, then inserts `the `.
- `android-gboard-swipe-delete.json`: native Delete swipe selects and deletes the
  exact existing word `hello`.
- `android-gboard-recomposition.json`: a candidate tap missed the left-side
  candidate. The trace qualifies typing and caret movement only; recomposition
  remains failed.

Corrected-policy source: `21d584c7fa1ccb7d6b155e3ed8a4a7b267df5982`.
Native EditorInfo is `0x280a1`, without `NO_SUGGESTIONS`. The actual field has no
form owner inside an ancestor form, and no name, id or associated labels.

The `*-repeat.json` and `android-gboard-existing-word-candidate.json` files come
from source `f3016481de544be4599efcb7e52ffe6ab3cdcd82`. Choosing the
actual left-side `hello` candidate moves the caret from 2 to 6, deletes verified
`llo `, then reinserts it. The final text is unchanged, while both native edits
must still have a producer. No DOM composition event was delivered; that
qualification remains failed.

The `android-corrected3-*.json` files come from source
`828645aed7b3e5928ffdf9464eb5183e3aeecfc2`. They also record
a controlled unique probe word in a sensitive proxy and an independent plain
native password input, plus normal-field prefix typing before and after.
Both password controls report complete `inputType=0xe1` and show no dictionary
suggestion strip. The full probe word was absent from subsequent visible normal
candidates. The proxy's forced `inputmode="text"` changed `imeOptions` from the
native Go key to Return; its fixture is explicitly `failed-keyboard-hint` and
does not qualify complete keyboard equivalence.

The `android-corrected6-*.json` files come from source
`a0035f1300a6df64e7d3e8898ca9bc406ce8129c`. The sensitive
proxy now omits an unspecified inputmode and matches the plain password input's
complete `inputType=0xe1` and `imeOptions=0x12000002`, including the native Go key.
Both password keyboards show no dictionary strip, and the full probe word is
absent from subsequent normal-field candidates. The normal field still has
`NO_SUGGESTIONS` absent; the legacy field has it present.

The independent `native-text-recomposition-control` has the same full EditorInfo
as the proxy and delivers the same verified `llo ` delete/insert candidate
replacement, with no DOM composition events. This third experiment closes that
capture path as unqualified. The latest swipe-delete attempt instead inserted
`x` and ended at `hellox`; its fixture is explicitly `failed-swipe-delete`.
Earlier successful swipe-delete captures remain covered. Failed journeys replay
their actual delivered edits without qualifying their intended native action.

US typing produced keydown → keypress → beforeinput → input → keyup. The reducer
allows this local input echo and binds it to the already emitted keystroke. The
Option/dead-key trace commits before keyup without an additional final insertText.

Gboard DOM composition, Korean, Pinyin and emoji insertion remain unqualified.
Scripted ordering regressions in `reducer.test.ts` are separate from native trace replays.

The `macos1-*.json` fixtures come from source
`444f12dce66f4fcb55e5a66015a8f2a62c2181ad`, VM run
`20261028T060214Z-81a94ac5`. They add real Chrome US and Option input,
Electron/Chrome/Safari text substitution (`omw ` → `On my way! `), and Safari
Option, dead-key and Kotoeri cancellation orders. Safari substitutes the word
before moving its caret over the retained trailing space; both cursor moves
are asserted. Safari's dead-key commit deletes marked text before inserting
the composed character. Native screenshots and original event files remain in
that job's `guest/viewer-native-traces/` directory.

`macos1-electron-japanese-convert-partial.json` retains an active Kotoeri preedit
after Return; it does not qualify a completed commit. Its ordinary initial `n`
keydown precedes compositionstart, and its keyup arrives during composition.
The replay requires exact takeover of the already produced `n` and its release,
with no final edit. Open transactions are explicit fixture expectations; all
other fixtures still require their native transaction to be closed.

The three `macos1-*-emoji-picker.json` recordings contain the actual local
Ctrl–Command–Space activation without a successful emoji insertion. Electron and
Safari consume its keyup. Replays require no remote key from that local IME chord;
the fixtures remain failed picker journeys.

`macos1-safari-us-autocorrect.json` preserves the original `asde ` sample that
Safari corrected to `aside `. It verifies the whole native replacement, including
the unchanged `as` prefix, and both transient caret moves. Its original planned
US result remains failed; the actual native replacement is replayed separately.

The `macos1-*-accent-hold`, `*-korean-*` and `*-pinyin` fixtures preserve failed
native attempts that delivered Latin text. They do not qualify those IMEs or the
accent picker. Click cases retain target text while resetting the local mirror.
Ordinary Enter cases require one native multiline Enter default and no extra
mirrored insertion; they confirm the browser branch's existing Return handling.

All 39 non-empty observations from that VM batch are replayed. Some Chromium
composition-end events have `isTrusted=false` in the unmodified native recording;
failed fixtures assert their exact flags, while qualified fixtures still require
every native input event to be trusted. The capture classifier continues to reject
those untrusted ends. Active Safari conversion/reconversion preedits are explicitly
partial, with no invented final commit. The empty Firefox recording is a blocked
setup diagnostic, not native typing coverage.

The `macos2-*-accent-hold.json` files come from source
`e082eb7139132d47a6878168edddd8099386657b`, VM run
`20261028T072822Z-6715893f`. Native repeat-marked downs open the real accent picker
in Electron, Chrome and Safari; choosing Digit2 replaces `e` with `é`. Only the
initial `e` inserts a character before the replacement. The ten repeat downs and
candidate digit are consumed locally, so their replay must not create remote
characters. All original events and trust flags are retained.

All 31 non-empty observations from that second batch are replayed. Safari now
records completed Kotoeri conversion, native candidate Down/Up selection and
reconversion. Reconversion has two committed `日本` transactions around one native
cancel (`[1, 0, 1]`), with verified takeover of the prior word. The same Chromium
orders retain their untrusted composition ends and remain failed qualifications.
Korean and Pinyin still delivered Latin after the third input-source attempt;
those fixtures are failed captures, and that capture path is stopped.

All 13 observations from VM run `20261028T081344Z-bd1545f1`, source
`47e7bfc0da3a6f169030636f0f06f9b430eb86fc`, are replayed as `macos3-*.json`.
Accepting the actual native Firefox Welcome button enables trusted Firefox US,
Option, dead-key, held-accent, Kotoeri conversion/candidate/cancel/reconversion,
and text-replacement captures. Firefox marks Option as AltGraph; the printable
character therefore carries no remote shortcut modifiers. Its final native
`input` events after compositionend must not add a second commit.

All four final emoji-picker journeys remain failed. The native Character Viewer
popover opens and receives the search text, but its result grid is absent from
the CharacterPalette process's accessibility tree. No emoji is inserted. After
three capture experiments this path is stopped; these recordings require no
remote text from the local picker chord and do not qualify emoji insertion.

`expo-android-us-context-plain.jsonl` contains raw packets from the production
`RemoteInputEditText` on Android API 36, driven by touches on Gboard
15.1.08.726012951-preload-arm64-v8a. The companion JSON records source, provenance,
the raw file's SHA-256 and expected operations. The driver typed `hel`, changed the
remote context, then typed `b` and Space. Gboard delivered plain commits in this
case. The recorder acknowledged native defaults; it did not run the Expo bridge
or a remote target. This fixture covers plain typing across context resets and
does not qualify marked composition. Its replay uses the native packet decoder
and shared reducer in
`apps/mobile/modules/remote-text-input/tests/native-traces.test.ts`.

`expo-android-us-emoji-prediction` adds an actual Gboard `hello ` followed by its
visible wave emoji suggestion, source `95bb4db7930dfc9dd79307182c2faa26fad92ab8`.
The initial intent of that final tap was to open the prior toolbar gear; the
recorded screenshot instead shows the emoji candidate there. Its replay asserts
the actual `hello 👋` with one producer per insertion. It is a native default-ack
recorder capture, separate from the custom Expo client and remote target journeys.

`expo-android-autocorrect` records real Gboard `t e h Space` in the native
EditText at source `5248d68b94e3d103dde70cd1eb912d41f68da778`. Its exact native
order deletes verified `teh`, then inserts `the `; replay preserves both native
edits and the empty final composition state. Full Expo mount qualification is separate.
