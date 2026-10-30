---
name: test-mobile-push
description: Configure and verify Opensteer mobile push notifications on a physical iPhone or Android device.
---

# Test mobile push

Use the reserved device workflow in `docs/testing.md`; do not drive the host screen.
Use a physical device for provider tokens, entitlements and cellular handover.
A simulator or Metro export does not prove them. Keep credentials and device IDs private.

1. Build a custom client using `apps/mobile/README.md`. For Android, supply
   `OPENSTEER_MOBILE_GOOGLE_SERVICES_FILE=/absolute/path/google-services.json`
   at prebuild; never commit the file. Inspect configuration with
   `pnpm --filter @opensteer/mobile exec expo config --type introspect`.
2. Configure the Account provider privately. For APNs supply key ID, team ID,
   private key and topic; for FCM supply the service-account JSON. Use the exact
   environment names in `apps/control-plane/src/config.ts`. Match Android's
   Firebase project to the build. One APNs key serves sandbox and production;
   the device's signed environment selects the endpoint.
3. Attach a Deployment with an Account channel; a loopback development Host alone
   has no Account push. In Settings → Notifications grant permission and check
   registration status. Verify Request and reply/failure preference groups.
4. Exercise a waiting Request and an unread direct reply while backgrounded.
   Tap from background and terminated states; verify the exact Deployment and
   message/request, including a settled Request. Check foreground suppression
   only while actually reading that destination. Provider acceptance is not display.
5. Sign out and verify withdrawal before credential revocation. Reopen and verify
   registration recovery. For lifecycle changes also check cold/warm links, OAuth
   completion/cancellation and foreground callbacks; exports do not test callbacks.

Record only evidence for the affected flow; report unavailable device checks as
unverified. Stop every server/capture process and release the device afterward.
