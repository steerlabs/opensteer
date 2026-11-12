# Test mobile push

Use a physical device; simulators and Metro exports prove no provider tokens, entitlements or
cellular handover.

1. Build a custom client ([build and run](build-and-run.md)) with the Account origin on both
   platforms; for Android supply `OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE` from the Firebase project
   the Account's FCM configuration uses.
2. The Account provider is configured privately under the names in
   [config.ts](../../../../apps/control-plane/src/config.ts): APNs key ID, team ID, private key and
   topic, and FCM service-account JSON. One APNs key serves sandbox and production.
3. Attach a Deployment with an Account channel (a loopback development Host has no push). In
   Settings → General → Notifications, grant permission, check registration status and the Request
   and reply/failure preference groups.
4. Backgrounded, trigger a waiting Request and an unread direct reply. Tap each from background and
   terminated states; the exact Deployment and message or Request must open, including a settled
   Request. Check foreground suppression only while reading that destination. Provider acceptance is
   not display.
5. Sign out of the Account: withdrawal precedes credential revocation, and the device stays
   unregistered after reopening. Sign back in and check registration recovers. For lifecycle changes
   also check cold and warm links, OAuth completion and cancellation, and foreground callbacks.

Signed delivery, first unlock and reinstall follow
[private preview signing](install-beta.md#private-preview-signing-and-acceptance).

For teams, verify the team drawer entry and the one extra team attachment for the selected
computer. Team chat must work with that computer offline. Switch computers and confirm the previous
team connection closes; test a team push from the other computer without attaching it. Inspect
only generic provider payloads and sealed previews, never plaintext team message bodies.
