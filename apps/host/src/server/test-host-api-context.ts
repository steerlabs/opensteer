import { createId, type AuthenticatedSession, type UserId } from "@opensteer/core";
import type { HostApiHandlers, HostApiServerContext } from "@opensteer/protocol";
import Fastify, { type FastifyInstance } from "fastify";
import type { HostAuthenticator } from "../identity/auth.js";
import { registerHostApi } from "./host-api-registration.js";

/** A real registered RPC surface for cross-boundary tests. */
export function testHostApiApp(
  authenticator: HostAuthenticator,
  handlers: HostApiHandlers,
): FastifyInstance {
  const app = Fastify();
  registerHostApi(app, authenticator, handlers);
  return app;
}

export function testHostApiContext(
  userId: UserId,
  options: {
    readonly instanceRole?: "administrator" | "user";
    readonly surface?: "canonical" | "personal-remote";
  } = {},
): HostApiServerContext {
  const now = new Date();
  const session = {
    absoluteExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    id: createId("authSession"),
    user: {
      disabledAt: null,
      displayName: "Test User",
      email: "test@example.com",
      emailVerified: true,
      id: userId,
      image: null,
      instanceRole: options.instanceRole ?? "user",
    },
  } satisfies AuthenticatedSession;
  return {
    headers: {},
    requestId: "test-request",
    requestUrl: "https://host.example.test/v1/rpc/test",
    session,
    setHeader: () => undefined,
    signal: new AbortController().signal,
    surface: options.surface ?? "canonical",
  };
}
