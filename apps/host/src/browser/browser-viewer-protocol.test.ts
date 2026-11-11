import { expect, it } from "vitest";
import { BrowserServerMessageSchema } from "@opensteer/protocol/browser";
import { browserViewerMessage } from "./browser-viewer-protocol.js";
it("projects negotiated input capabilities without a session-wide surface list", () => {
  const snapshot = BrowserServerMessageSchema.parse({
    type: "browser.snapshot",
    access: "read-write",
    dialog: null,
    sessionId: "bsn_e2799da2-9fe9-438e-a160-47e275ee2703",
    state: "ready",
    basicInput: 1,
    surfaceState: 1,
    surfaces: [
      { id: "phone-page", title: "Phone", url: "about:blank", active: true, state: "suspended" },
    ],
  });
  const legacy = browserViewerMessage(snapshot);
  expect(legacy).not.toHaveProperty("basicInput");
  expect(legacy).not.toHaveProperty("surfaceState");
  expect(legacy).not.toHaveProperty("surfaces.0.state");
  const modern = browserViewerMessage(snapshot, undefined, undefined, undefined, false, {
    basicInput: true,
    surfaceState: true,
  });
  expect(modern).toMatchObject({
    basicInput: 1,
    surfaceState: 1,
    surfaces: [],
  });
  expect(modern).not.toHaveProperty("editingVersion");
  expect(modern).not.toHaveProperty("clipboard");
});
it("projects passkey fields only to opted-in viewers while preserving old snapshots", () => {
  const snapshot = BrowserServerMessageSchema.parse({
    type: "browser.snapshot",
    access: "read-write",
    dialog: null,
    sessionId: "bsn_e2799da2-9fe9-438e-a160-47e275ee2703",
    state: "ready",
    surfaces: [],
    navigationAttributionVersion: 1,
    passkeys: "native",
    passkeyConsumerToken: "e2799da2-9fe9-438e-a160-47e275ee2703",
  });
  const old = browserViewerMessage(snapshot);
  expect(old).not.toHaveProperty("navigationAttributionVersion");
  expect(old).not.toHaveProperty("passkeys");
  expect(old).not.toHaveProperty("passkeyConsumerToken");
  expect(
    browserViewerMessage(snapshot, undefined, "notice", "e2799da2-9fe9-438e-a160-47e275ee2703"),
  ).toMatchObject({ passkeys: "notice" });
  expect(old).not.toHaveProperty("consumerToken");
  expect(
    browserViewerMessage(
      snapshot,
      undefined,
      undefined,
      "e2799da2-9fe9-438e-a160-47e275ee2703",
      true,
    ),
  ).toMatchObject({ consumerToken: "e2799da2-9fe9-438e-a160-47e275ee2703" });
});
