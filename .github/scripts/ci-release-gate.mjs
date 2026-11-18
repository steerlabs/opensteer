/**
 * Which jobs of a full CI run on main gate a Stable desktop promotion (release-plan.mjs).
 * A release is gated by what it ships, which is what release.yml publishes: the signed Mac
 * app with the personal Host, Runner, web client, browser extension, native helpers and
 * signed Agent Phone APK it bundles; the Account image; and the Linux team images.
 *
 * Every ci.yml job but Check is in exactly one list; ci-release-gate.test.mjs fails
 * otherwise. A job that does not gate still runs in every full run and still turns its run
 * and Check red; it only does not hold a release that contains nothing it tests. When a
 * release publishes an artifact for its platform, move it to `releaseGating`.
 */
export const releaseGating = {
  changes: "Plans every other job; a full run must select them all.",
  lint: "Formatting, lint, quarantine expiry and the published Stable team API floor.",
  "build-types": "Typechecks every package the release builds.",
  build: "Builds the packages in the Mac app, the Account image and the team images.",
  tests: "Unit tests of the Host, Runner, web client, Account and team server.",
  integration: "The personal Host, Account and team server against PostgreSQL.",
  "native-mac": "The Mac app's native helpers, release-native proof and Darwin-only files.",
  android: "The Agent Phone APK the Mac app bundles.",
  "browser-journeys": "The web client and the bundled browser extension in real Chromium.",
};
export const notReleaseGating = {
  "native-windows": "No release publishes a Windows artifact; Windows runs from source.",
};
/**
 * Check verifies every job, so a red non-gating job turns it red. This step of Check runs
 * the same verification (plan, results, inventories, lock order) for the gating jobs only.
 */
export const releaseGateStep = "Verify release-gating jobs";
