import Fastify from "fastify";
import { createId, OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { hostApi, rpcFailure, rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { HostAuthenticator } from "../identity/auth.js";
import { registerHostApi } from "./host-api-registration.js";
import { injectRpcRequest } from "./test-host-api-request.js";

const canonical = "http://127.0.0.1:4310";
const route = "https://home.connect.example";
const session: AuthenticatedSession = {
  id: createId("authSession"),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  user: {
    id: createId("user"),
    displayName: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    disabledAt: null,
    image: null,
    instanceRole: "administrator",
  },
};
const commands = [
  {
    type: "integration.authorization.return",
    attemptId: createIntegrationId("oauthAttempt"),
    returnProof: "r".repeat(43),
  },
  { type: "connection.revoke", connectionId: `mcn_${crypto.randomUUID()}` },
  {
    type: "connection.authorize",
    requestId: "r".repeat(43),
    decision: {
      kind: "approve",
      label: "Agent",
      accessMode: "approval-required",
      reach: { kind: "user" },
    },
  },
  { type: "session.revoke", sessionId: createId("authSession") },
  { type: "workspace.delete", workspaceId: createId("workspace") },
  { type: "integration.uninstall", installationId: createIntegrationId("installation") },
  {
    type: "channel.connection.status.set",
    connectionId: createIntegrationId("connection"),
    status: "revoked",
  },
];

describe("credential-aware command origin protection", () => {
  it.each(commands)("protects $type once using its authenticated credential", async (command) => {
    const dispatch = vi.fn(async () => rpcSuccess({}));
    const authenticator = new HostAuthenticator({
      identity: {
        requireSession: async () => session,
        userSessionProfile: async () => session.user,
        authenticateNativeAccessToken: async () => ({
          sessionId: session.id,
          subject: session.user.id,
          createdAt: new Date(session.createdAt),
          expiresAt: new Date(session.expiresAt),
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
        }),
      } as never,
      personalRemote: {
        authenticateRemoteCredential: async () => session,
        authenticateRemoteSession: async (headers, options) =>
          headers.cookie === "remote=x" && (!options?.mutation || headers.origin === route)
            ? session
            : null,
      },
      publicUrl: new URL(canonical),
    });
    const app = Fastify();
    registerHostApi(app, authenticator, {
      "commands.dispatch": dispatch,
    } as unknown as HostApiHandlers);
    try {
      const payload = { ...command, idempotencyKey: "credential-boundary" };
      for (const headers of [
        { authorization: "Bearer native" },
        { authorization: "Bearer native", cookie: "remote=x", origin: "https://hostile.example" },
        { authorization: "PersonalRemote remote" },
        { cookie: "canonical=x", origin: canonical },
        { cookie: "remote=x", origin: route },
      ]) {
        const response = await injectRpcRequest(app, "commands.dispatch", payload, headers);
        expect(response.statusCode, response.body).toBe(200);
      }
      expect(dispatch).toHaveBeenCalledTimes(5);
      for (const headers of [
        { cookie: "canonical=x", origin: "https://hostile.example" },
        { cookie: "remote=x", origin: "https://hostile.example" },
        { cookie: "canonical=x" },
        { cookie: "remote=x" },
      ]) {
        const response = await injectRpcRequest(app, "commands.dispatch", payload, headers);
        expect(response.statusCode, response.body).toBe(403);
      }
      expect(dispatch).toHaveBeenCalledTimes(5);
    } finally {
      await app.close();
    }
  });
});

describe("pending invitation registration", () => {
  it("reserves the identity exception for exactly team.invitation.accept", async () => {
    const authenticator = new HostAuthenticator({
      identity: {
        requireSession: async () => {
          throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
        },
        userSessionProfile: async () => session.user,
        authenticateNativeAccessToken: async () => {
          throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
        },
        requireTeamInvitationSession: async () => session,
      } as never,
      publicUrl: new URL(canonical),
    });
    const invitation = vi.spyOn(authenticator, "authenticateTeamInvitationSessionContext");
    const handlers = Object.fromEntries(
      Object.keys(hostApi).map((name) => [
        name,
        async () => rpcFailure({ code: "bad_request", message: "Test handler" }),
      ]),
    ) as unknown as HostApiHandlers;
    const app = Fastify();
    registerHostApi(app, authenticator, handlers);
    try {
      for (const name of Object.keys(hostApi) as (keyof typeof hostApi)[]) {
        invitation.mockClear();
        await injectRpcRequest(app, name, {} as never, { origin: canonical, cookie: "pending=x" });
        expect(invitation.mock.calls.length, name).toBe(name === "team.invitation.accept" ? 1 : 0);
      }
    } finally {
      await app.close();
    }
  });
});
