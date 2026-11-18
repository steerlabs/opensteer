import Fastify from "fastify";
import { createId, OpensteerError, type AuthenticatedSession } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import {
  expectedMutationSessionHeader,
  rpcSuccess,
  type HostApiHandlers,
} from "@opensteer/protocol";
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
  },
};
const commands = [
  { type: "tab.close", tabIds: ["tab-from-list"] },
  { type: "app.delete", appId: `app_${crypto.randomUUID()}` },
  {
    type: "plugin.authorization.return",
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
    },
  },
  { type: "session.revoke", sessionId: createId("authSession") },
  { type: "plugins.remove", pluginId: "plg_fixture" },
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

it("checks the expected mutation session against the session authenticated by the current cookie", async () => {
  const dispatch = vi.fn(async () => rpcSuccess({}));
  const old = { ...session, id: createId("authSession") };
  const authenticator = new HostAuthenticator({
    identity: {
      requireSession: async () => session,
      userSessionProfile: async () => session.user,
    } as never,
    publicUrl: new URL(canonical),
  });
  const app = Fastify();
  registerHostApi(app, authenticator, {
    "commands.dispatch": dispatch,
  } as unknown as HostApiHandlers);
  try {
    const payload = { ...commands[0], idempotencyKey: "session-bound-test" };
    const headers = { cookie: "canonical=x", origin: canonical };
    const refused = await injectRpcRequest(app, "commands.dispatch", payload, {
      ...headers,
      [expectedMutationSessionHeader]: old.id,
    });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ ok: false, error: { reason: "session-changed" } });
    expect(dispatch).not.toHaveBeenCalled();
    const accepted = await injectRpcRequest(app, "commands.dispatch", payload, {
      ...headers,
      [expectedMutationSessionHeader]: session.id,
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

it.each([undefined, "computer-app-installation-invalid"])(
  "logs a refused command at info with reason %s",
  async (reason) => {
    const authenticator = new HostAuthenticator({
      identity: { requireSession: async () => session } as never,
      publicUrl: new URL(canonical),
    });
    const logs: string[] = [];
    const app = Fastify({ logger: { stream: { write: (line: string) => logs.push(line) } } });
    registerHostApi(app, authenticator, {
      "commands.dispatch": async () => {
        throw new OpensteerError({
          code: "bad_request",
          message: "Private refusal detail",
          ...(reason ? { reason } : {}),
        });
      },
    });
    try {
      const response = await injectRpcRequest(
        app,
        "commands.dispatch",
        { type: "tab.close", tabIds: ["tab-from-list"], idempotencyKey: "refusal-log" },
        { cookie: "canonical=x", origin: canonical },
      );
      expect(response.statusCode, response.body).toBe(400);
      expect(logs.map((line) => JSON.parse(line))).toContainEqual(
        expect.objectContaining({
          code: "bad_request",
          level: 30,
          msg: "rpc refused",
          reason: reason ?? null,
          rpc: "commands.dispatch",
        }),
      );
      expect(logs.join("")).not.toContain("Private refusal detail");
    } finally {
      await app.close();
    }
  },
);

it("registers no personal file, media or reference routes on a team Host", async () => {
  const app = Fastify();
  registerHostApi(
    app,
    {} as HostAuthenticator,
    {},
    {
      kind: "team",
      dispatch: async () => {
        throw Error("Unexpected dispatch");
      },
    },
  );
  try {
    for (const method of [
      "asset.urls",
      "file.open",
      "references.resolve",
      "tabs.get",
      "tabs.state",
      "apps.list",
      "apps.get",
      "plugins.installed.list",
      "plugins.get",
      "plugins.catalog.list",
      "plugins.account.review",
    ])
      expect(
        (await app.inject({ method: "POST", url: `/v1/rpc/${method}`, payload: {} })).statusCode,
      ).toBe(404);
    expect((await app.inject("/v1/rpc/file.content")).statusCode).toBe(404);
    expect((await app.inject("/media/token/image.png")).statusCode).toBe(404);
  } finally {
    await app.close();
  }
});
