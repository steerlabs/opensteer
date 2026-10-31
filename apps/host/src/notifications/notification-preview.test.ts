import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NotificationPreviewEnvelopeSchema,
  NotificationPreviewKeyIdSchema,
  NotificationPreviewKeySchema,
  NotificationPreviewPlaintextSchema,
} from "@opensteer/core";
import {
  notificationPreviewAad,
  sealNotificationPreview,
  type NotificationPreviewContext,
} from "./notification-preview.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../packages/core/src/fixtures/notification-preview-v1.json", import.meta.url),
    "utf8",
  ),
);
const context: NotificationPreviewContext = fixture;
function open(context: NotificationPreviewContext, ciphertext = fixture.ciphertext) {
  const bytes = Buffer.from(ciphertext, "base64url");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(fixture.key, "base64url"),
    Buffer.from(fixture.nonce, "base64url"),
  );
  decipher.setAAD(notificationPreviewAad(context));
  decipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString(
    "utf8",
  );
}
describe("notification preview v1", () => {
  it("seals the committed vector byte for byte and opens it", () => {
    const sealed = sealNotificationPreview({
      context,
      key: fixture.key,
      nonce: Buffer.from(fixture.nonce, "base64url"),
      plaintext: JSON.parse(fixture.plaintext),
    });
    expect(sealed.ciphertext).toBe(fixture.ciphertext);
    expect(open(context)).toBe(fixture.plaintext);
  });
  it("authenticates every routing field and rejects a one-byte tamper", () => {
    for (const field of [
      "deploymentId",
      "notificationId",
      "installationId",
      "keyId",
      "kind",
      "deepLink",
      "expiresAt",
    ] as const) {
      expect(() => open({ ...context, [field]: context[field] + "x" })).toThrow();
    }
    const bytes = Buffer.from(fixture.ciphertext, "base64url");
    bytes[0] = bytes[0]! ^ 1;
    expect(() => open(context, bytes.toString("base64url"))).toThrow();
  });
  it("uses a new nonce per seal and handles the largest JSON-escaped plaintext", () => {
    const plaintext = {
      version: 1 as const,
      title: "\u0000".repeat(120),
      body: "\u0000".repeat(180),
    };
    const a = sealNotificationPreview({ context, key: fixture.key, plaintext });
    const b = sealNotificationPreview({ context, key: fixture.key, plaintext });
    expect(a.nonce).not.toBe(b.nonce);
    expect(Buffer.from(a.ciphertext, "base64url").byteLength).toBeLessThanOrEqual(2064);
  });
  it("rejects noncanonical encodings, unknown fields and malformed Unicode", () => {
    expect(NotificationPreviewKeySchema.safeParse(fixture.key + "=").success).toBe(false);
    expect(NotificationPreviewKeyIdSchema.safeParse(fixture.keyId.slice(0, -1) + "x").success).toBe(
      false,
    );
    for (const ciphertext of ["a".repeat(23), "a".repeat(2753), fixture.ciphertext + "="]) {
      expect(
        NotificationPreviewEnvelopeSchema.safeParse({
          version: 1,
          keyId: fixture.keyId,
          nonce: fixture.nonce,
          ciphertext,
        }).success,
      ).toBe(false);
    }
    expect(
      NotificationPreviewPlaintextSchema.safeParse({ version: 1, title: "x", body: "\ud800" })
        .success,
    ).toBe(false);
    expect(
      NotificationPreviewPlaintextSchema.safeParse({
        version: 1,
        title: "x",
        body: "y",
        extra: true,
      }).success,
    ).toBe(false);
  });
});
