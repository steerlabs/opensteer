import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { once } from "node:events";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { rpcSuccess, type HostApiHandlers } from "@opensteer/protocol";
import { HostAuthenticator } from "../identity/auth.js";
import { LocalBootstrapService } from "../runtime/local-bootstrap.js";
import { registerHostApi } from "../server/host-api-registration.js";
import { testRpcRequest } from "../server/test-host-api-request.js";
import { registerPersonalRemoteExecutor } from "./personal-remote-administration-routes.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { generateKeyPairSync } from "node:crypto";
import { createId, type AuthenticatedSession } from "@opensteer/core";
import { createDatabase, migrateToLatest } from "@opensteer/database";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { PersonalRemoteAccessService } from "./personal-remote-access-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Run this file through pnpm test:integration so it receives an isolated database.",
  );
const database = createDatabase({
  applicationName: "remote-administration-test",
  connectionString: databaseUrl,
  maxConnections: 4,
});
const keys = generateKeyPairSync("ed25519");
const userId = createId("user");
const session: AuthenticatedSession = {
  id: createId("authSession"),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  user: {
    id: userId,
    displayName: "Owner",
    email: "remote-admin@example.test",
    emailVerified: true,
    image: null,
    instanceRole: "administrator",
    disabledAt: null,
  },
};
const authority = {
  canonicalOrigin: "http://127.0.0.1:4310",
  deploymentId: createId("deployment"),
  hostInstanceId: createId("hostInstance"),
  hostKey: { algorithm: "Ed25519" as const },
  deploymentShape: {
    kind: "personal" as const,
    defaultWorkspaceBacking: "local-directory" as const,
  },
};
function service() {
  return new PersonalRemoteAccessService({
    authority,
    database,
    keys,
    grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
    identity: { announceSessionsEnded: () => {} } as never,
  });
}

describe("Personal remote administration intents", () => {
  beforeAll(async () => {
    await migrateToLatest(database);
    await database
      .insertInto("users")
      .values({
        id: userId,
        displayName: session.user.displayName,
        email: session.user.email,
        emailVerified: true,
        image: null,
        instanceRole: "administrator",
        disabledAt: null,
      })
      .execute();
  });
  beforeEach(async () => {
    await database.deleteFrom("personalRemoteAdministration").execute();
  });
  afterAll(async () => {
    await database.destroy();
  });

  it("persists an owner's intent without an executor, gates execution until the reply, and resumes after restart", async () => {
    const access = service();
    const operation = await access.administration.request(
      session,
      { action: "configure", mode: "off", privateOrigin: null },
      "disable-remote-access",
    );
    expect(await access.administration.status(session)).toMatchObject({
      executorConnected: false,
      operation: {
        id: operation.id,
        state: "pending",
        detail: "Waiting for the Opensteer desktop app to run on this computer.",
      },
    });
    const executor = {};
    const detach = access.administration.attachExecutor(executor);
    try {
      expect(await access.administration.next(executor)).toBeNull();
      access.administration.release(operation.id);
      expect(await access.administration.next(executor)).toMatchObject({ id: operation.id });
    } finally {
      detach();
    }
    const restarted = service().administration;
    const remove = restarted.attachExecutor(executor);
    try {
      expect(await restarted.next(executor)).toMatchObject({ id: operation.id });
      await restarted.progress(executor, {
        operationId: operation.id,
        state: "running",
        detail: "Disabling Connect",
      });
      await restarted.progress(executor, {
        operationId: operation.id,
        state: "succeeded",
        detail: null,
      });
      expect(await restarted.next(executor)).toBeNull();
      expect(await restarted.status(session)).toMatchObject({ operation: { state: "succeeded" } });
    } finally {
      remove();
    }
  });

  it("keeps idempotent retries identical and serializes simultaneous devices", async () => {
    const administration = service().administration;
    const intent = {
      action: "configure" as const,
      mode: "private" as const,
      privateOrigin: "https://private.example",
    };
    const operation = await administration.request(session, intent, "same-action");
    expect(await administration.request(session, intent, "same-action")).toEqual(operation);
    await expect(
      administration.request(session, { action: "unlink" }, "same-action"),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      administration.request(session, { action: "rotate" }, "another-device"),
    ).rejects.toMatchObject({ code: "conflict" });
    const off = await administration.request(
      session,
      { action: "configure", mode: "off", privateOrigin: null },
      "cancel-connection",
    );
    expect(off.id).not.toBe(operation.id);
    const executor = {};
    const detach = administration.attachExecutor(executor);
    try {
      await administration.progress(executor, {
        operationId: operation.id,
        state: "succeeded",
        detail: null,
      });
      expect(await administration.status(session)).toMatchObject({
        operation: { id: off.id, state: "pending" },
      });
    } finally {
      detach();
    }
  });

  it("recovers the failed action with its original external idempotency identity", async () => {
    const administration = service().administration;
    const executor = {};
    const detach = administration.attachExecutor(executor);
    try {
      const original = await administration.request(session, { action: "rotate" }, "rotate-once");
      administration.release(original.id);
      await administration.progress(executor, {
        operationId: original.id,
        state: "failed",
        detail: "Connection lost",
      });
      const recovered = await administration.request(
        session,
        { action: "recover" },
        "recover-rotation",
      );
      expect(recovered).toMatchObject({
        intent: { action: "rotate" },
        executionId: original.executionId,
      });
      expect(recovered.id).not.toBe(original.id);
      await administration
        .progress({}, { operationId: recovered.id, state: "succeeded", detail: null })
        .then(
          () => {
            throw new Error("Detached executor was accepted");
          },
          (error: unknown) => expect(error).toMatchObject({ code: "forbidden" }),
        );
    } finally {
      detach();
    }
  });

  it("delivers accepted intent over the executor wire only after the requesting response finishes", async () => {
    const access = service();
    const app = Fastify();
    await app.register(websocket);
    const authenticator = new HostAuthenticator({
      publicUrl: new URL(authority.canonicalOrigin),
      identity: {
        authenticateNativeAccessToken: async () => ({
          sessionId: session.id,
          subject: userId,
          createdAt: new Date(session.createdAt),
          expiresAt: new Date(session.expiresAt),
          absoluteExpiresAt: new Date(session.absoluteExpiresAt),
        }),
        userSessionProfile: async () => session.user,
      } as never,
    });
    const capability = "desktop-process-capability".padEnd(43, "x");
    registerPersonalRemoteExecutor(
      app,
      new LocalBootstrapService({
        publicUrl: new URL(authority.canonicalOrigin),
        requireSetupCredential: true,
        setupToken: capability,
        store: {} as never,
        runners: {} as never,
      }),
      access.administration,
    );
    let finishSend!: () => void;
    let sending!: () => void;
    const held = new Promise<void>((resolve) => {
      finishSend = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      sending = resolve;
    });
    app.addHook("onSend", async (request, _reply, payload) => {
      if (request.method === "POST") {
        sending();
        await withTimeout(held, 2000, {
          timeoutError: () => new Error("The test never released the administration response"),
        });
      }
      return payload;
    });
    registerHostApi(app, authenticator, {
      "commands.dispatch": async (
        command: import("@opensteer/protocol").HostApiCommand,
        context: import("@opensteer/protocol").HostApiServerContext,
      ) => {
        if (command.type !== "personal.remoteAccess.request" || !context.session)
          throw new Error("Unexpected command");
        const operation = await access.administration.request(
          context.session,
          command.intent,
          command.idempotencyKey,
        );
        context.afterResponse!(() => access.administration.release(operation.id));
        return rpcSuccess({ type: command.type, operation });
      },
    } as unknown as HostApiHandlers);
    const changed = vi.fn();
    const unsubscribe = access.administration.subscribe(changed);
    let socket: WebSocket | undefined;
    try {
      const address = await app.listen({ host: "127.0.0.1", port: 0 });
      socket = new WebSocket(
        `${address.replace("http:", "ws:")}/v1/personal-remote-access/executor?apiVersion=${hostApiVersion}`,
        { headers: { authorization: `Bearer ${capability}` } },
      );
      await withTimeout(once(socket, "open"), 1000, {
        timeoutError: () => new Error("Executor socket never opened"),
      });
      await vi.waitFor(
        async () =>
          expect((await access.administration.status(session)).executorConnected).toBe(true),
        { timeout: 1000 },
      );
      changed.mockClear();
      const delivered = withTimeout(once(socket, "message"), 2000, {
        timeoutError: () => new Error("Accepted intent never reached the desktop executor"),
      });
      const request = testRpcRequest(
        address,
        "commands.dispatch",
        {
          type: "personal.remoteAccess.request",
          idempotencyKey: "wire-disable",
          intent: { action: "configure", mode: "off", privateOrigin: null },
        },
        {
          headers: { authorization: "Bearer requester-session" },
          signal: AbortSignal.timeout(3000),
        },
      );
      await withTimeout(entered, 1000, {
        timeoutError: () => new Error("Administration response never reached the send boundary"),
      });
      expect(changed).not.toHaveBeenCalled();
      finishSend();
      const response = await request;
      expect(response.status).toBe(200);
      await response.json();
      const [frame] = await delivered;
      const operation = JSON.parse(String(frame)) as { id: string };
      socket.send(JSON.stringify({ operationId: operation.id, state: "succeeded", detail: null }));
      await vi.waitFor(
        async () =>
          expect((await access.administration.status(session)).operation?.state).toBe("succeeded"),
        { timeout: 1000 },
      );
    } finally {
      finishSend();
      unsubscribe();
      socket?.terminate();
      await app.close();
    }
  });

  it("refuses non-administrators without writing an intent", async () => {
    const administration = service().administration;
    const member = { ...session, user: { ...session.user, instanceRole: "user" as const } };
    await expect(
      administration.request(member, { action: "unlink" }, "unauthorized"),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await database.selectFrom("personalRemoteAdministration").selectAll().execute()).toEqual(
      [],
    );
  });
});
