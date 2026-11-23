import { expect, it } from "vitest";
import { BrowserServerMessageSchema } from "@opensteer/protocol/browser";
import { browserViewerMessage } from "./browser-viewer-protocol.js";
it("projects negotiated input capabilities without a session-wide surface list", () => {
  const snapshot = BrowserServerMessageSchema.parse({
    type: "browser.snapshot",
    access: "read-write",
    dialog: {
      id: "e2799da2-9fe9-438e-a160-47e275ee2703",
      type: "confirm",
      message: "Private dialog",
      surfaceId: "phone-page",
    },
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
    dialog: null,
  });
  expect(BrowserServerMessageSchema.safeParse(modern).success).toBe(true);
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
// CV1: a command's context is projected only to a viewer that asked for it with an editing
// version. A released phone parses the snapshot strictly (BrowserServerMessageSchema, a union of
// strict objects): one that did not ask never sees the field.
it("projects a command's context only to a viewer that asked for it, with editing", () => {
  const snapshot = BrowserServerMessageSchema.parse({
    type: "browser.snapshot",
    access: "read-write",
    dialog: null,
    sessionId: "bsn_e2799da2-9fe9-438e-a160-47e275ee2703",
    state: "ready",
    editingVersion: 2,
    clipboard: true,
    editingCommandContext: 1,
    surfaces: [],
  });
  const asked = { basicInput: false, surfaceState: false, editingCommands: true };
  expect(browserViewerMessage(snapshot, 2)).not.toHaveProperty("editingCommandContext");
  expect(
    browserViewerMessage(snapshot, undefined, undefined, undefined, false, asked),
  ).not.toHaveProperty("editingCommandContext");
  const projected = browserViewerMessage(snapshot, 2, undefined, undefined, false, asked);
  expect(projected).toMatchObject({ editingVersion: 2, editingCommandContext: 1 });
  expect(BrowserServerMessageSchema.safeParse(projected).success).toBe(true);
  // A far side that does not honour it: nothing to project, whatever the viewer asked.
  const { editingCommandContext: _context, ...older } = snapshot as typeof snapshot & {
    editingCommandContext?: 1;
  };
  expect(browserViewerMessage(older, 2, undefined, undefined, false, asked)).not.toHaveProperty(
    "editingCommandContext",
  );
});
