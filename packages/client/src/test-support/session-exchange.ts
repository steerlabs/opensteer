import { AuthenticatedSessionSchema, createId } from "@opensteer/core";
import { SessionExchangeResponseSchema, type SessionExchangeResponse } from "@opensteer/protocol";

/**
 * A completed cookie-delivery exchange, for fixtures that stand in for the
 * exchange client. Cookie delivery is the shape every existing attachment
 * uses; a header-delivery fixture belongs to whichever test is about the
 * credential itself and builds the credential it means to assert on.
 */
export function establishedCookieSession(): SessionExchangeResponse {
  return SessionExchangeResponseSchema.parse({
    credentialDelivery: "cookie",
    schemaVersion: 2,
    session: AuthenticatedSessionSchema.parse({
      absoluteExpiresAt: "2026-10-14T10:00:00.000Z",
      createdAt: "2026-09-14T10:00:00.000Z",
      expiresAt: "2026-09-21T10:00:00.000Z",
      id: createId("authSession"),
      user: {
        disabledAt: null,
        displayName: "You",
        email: "owner@personal.opensteer.invalid",
        emailVerified: true,
        id: createId("user"),
        image: null,
        instanceRole: "administrator",
      },
    }),
  });
}
