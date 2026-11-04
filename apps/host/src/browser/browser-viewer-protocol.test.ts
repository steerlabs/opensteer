import { expect, it } from "vitest";
import { BrowserServerMessageSchema } from "@opensteer/protocol/browser";
import { browserViewerMessage } from "./browser-viewer-protocol.js";
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
});

it("drops popup extensions for watch and old viewers, including coarse click extensions", () => {
  const ref = {
    surfaceId: "page",
    streamId: "dsp_00000000-0000-4000-8000-000000000001",
    documentGeneration: "d",
    authorityEpoch: "a",
    popupId: "p",
    revision: "1",
  };
  const event = BrowserServerMessageSchema.parse({
    type: "browser.popup.opened",
    ...ref,
    state: { kind: "select", multiple: false, rtl: false, items: [] },
  });
  expect(browserViewerMessage(event)).toBeNull();
  expect(browserViewerMessage(event, undefined, undefined, undefined, true)).toEqual(event);
});
