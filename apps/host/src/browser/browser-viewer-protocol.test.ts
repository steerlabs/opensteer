import { expect, it } from "vitest";
import { BrowserServerMessageSchema } from "@opensteer/protocol/browser";
import { browserViewerMessage } from "./browser-viewer-protocol.js";
it("projects passkey fields only to opted-in viewers while preserving old snapshots", () => {
  const snapshot = BrowserServerMessageSchema.parse({
    type: "browser.snapshot",
    access: "full-control",
    dialog: null,
    sessionId: "bsn_e2799da2-9fe9-438e-a160-47e275ee2703",
    state: "ready",
    surfaces: [],
    passkeys: "native",
    passkeyConsumerToken: "e2799da2-9fe9-438e-a160-47e275ee2703",
  });
  const old = browserViewerMessage(snapshot);
  expect(old).not.toHaveProperty("passkeys");
  expect(old).not.toHaveProperty("passkeyConsumerToken");
  expect(
    browserViewerMessage(snapshot, undefined, "notice", "e2799da2-9fe9-438e-a160-47e275ee2703"),
  ).toMatchObject({ passkeys: "notice" });
});
