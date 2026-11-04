# Test dictation

```sh
swift test --package-path packages/apple-dictation
pnpm exec vitest run packages/client/src/dictation/controller.test.ts packages/client/src/dictation/text.test.ts packages/client/src/dictation/presentation.test.ts
pnpm --filter @opensteer/desktop build:dictation-helper
```

The last builds the Mac helper without launching it. Native iPhone lifecycle tests
(`apps/mobile/modules/dictation/ios`) run in the iPhone CI lane. Generated-speech tests are not live
microphone evidence.

**iPhone**, on a reserved disposable device or VM with a custom client: permission refusal and
return from Settings, model download without capture, stop then Send, cancel, typing and IME
adoption, and navigation during start, listen and finish. Final text stays in its original draft;
failed finalization sends nothing. Test Bluetooth input separately from output. Real audio,
VoiceOver, haptics and keyboards need a device journey.

**Mac**, in a VM journey after merge or on request: first microphone consent, live transcription,
stop, cancel, window destruction, sleep and lock, and helper relaunch.
