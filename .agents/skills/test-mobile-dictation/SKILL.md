---
name: test-mobile-dictation
description: Verify mobile dictation ownership, privacy-sensitive lifecycle and native speech capture changes.
---

# Test mobile dictation

Run affected pure logic checks first:

```sh
swift test --package-path packages/apple-dictation
pnpm exec vitest run packages/client/src/dictation/controller.test.ts packages/client/src/dictation/text.test.ts packages/client/src/dictation/presentation.test.ts
```

Build a custom client with `.agents/skills/build-mobile-app/SKILL.md`.
Use only the reserved disposable device/VM workflow in `docs/testing.md` for
microphone or GUI work. Verify permission refusal/Settings return, model download
without capture, stop then Send, cancel, typing/IME adoption and navigation during
start/listen/finish. Confirm final text stays in its original draft and failed
finalization sends nothing. Test Bluetooth input changes separately from output changes.
Do not treat generated-speech tests as live microphone evidence. Report unavailable
OS/device checks as unverified; stop servers, capture and owned devices afterward.
