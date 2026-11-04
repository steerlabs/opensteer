import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { once } from "node:events";
import { registerPersonalRemoteExecutor } from "./personal-remote-administration-routes.js";
import type { PersonalRemoteAdministration } from "./personal-remote-administration.js";
import { LocalBootstrapService } from "../runtime/local-bootstrap.js";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, afterAll, expect, it, vi } from "vitest";
import { OpensteerError, createId, type AuthenticatedSession } from "@opensteer/core";
import { createDatabase, migrateToLatest, PersonalDesktopUpdateStore } from "@opensteer/database";
import { hostApiVersion } from "@opensteer/deployment-authority";
import type { DesktopUpdateState } from "@opensteer/protocol/maintenance";
import type { DesktopUpdateProgress } from "@opensteer/protocol/desktop-supervisor";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { HostAuthenticator } from "../identity/auth.js";
import { PersonalDesktopUpdate } from "./personal-desktop-update.js";
import { registerDesktopUpdateMaintenance } from "./personal-desktop-update-routes.js";

const url = process.env.OPENSTEER_TEST_DATABASE_URL;
if (!url) throw new Error("Run through pnpm test:integration for an isolated database");
const database = createDatabase({ connectionString: url, maxConnections: 4 });
const userId = createId("user");
const session: AuthenticatedSession = {
  id: createId("authSession"),
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3600000).toISOString(),
  user: {
    id: userId,
    displayName: "Owner",
    email: "desktop-owner@example.test",
    emailVerified: true,
    image: null,
    instanceRole: "administrator",
    disabledAt: null,
  },
};
const state: DesktopUpdateState = {
  status: "idle",
  channel: "stable",
  currentVersion: "1.0.0",
  availableVersion: null,
  latestVersion: null,
  downloadPercent: null,
  failed: null,
};
const store = new PersonalDesktopUpdateStore(database);
const makeService = () => new PersonalDesktopUpdate(store);
const request = { idempotencyKey: "update-once", intent: { action: "update" as const } };
beforeAll(async () => {
  await migrateToLatest(database);
  await database.insertInto("users").values(session.user).execute();
});
beforeEach(async () => {
  await database.deleteFrom("personalDesktopUpdate").execute();
  await database.deleteFrom("authSessions").execute();
  await database
    .insertInto("authSessions")
    .values({
      id: session.id,
      userId,
      token: randomUUID(),
      expiresAt: new Date(session.expiresAt),
      absoluteExpiresAt: new Date(session.absoluteExpiresAt),
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      deviceLabel: "Owner device",
      ipAddress: null,
      userAgent: null,
    })
    .execute();
});
afterAll(async () => {
  await database.destroy();
});

it("persists before acknowledgement, replays exactly, refuses conflicting keys and serializes competing requests", async () => {
  const updates = makeService();
  const operation = await updates.request(session, request);
  expect(await store.latest()).toEqual(operation);
  expect(await updates.request(session, request)).toEqual(operation);
  await expect(
    updates.request(session, { ...request, intent: { action: "channel", channel: "beta" } }),
  ).rejects.toMatchObject({ code: "conflict" });
  const [other, competing] = await Promise.allSettled([
    updates.request(session, { ...request, idempotencyKey: "other" }),
    makeService().request(session, { ...request, idempotencyKey: "competing" }),
  ]);
  expect(other).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
  expect(competing).toMatchObject({ status: "rejected", reason: { code: "conflict" } });
  await expect(
    updates.request({ ...session, user: { ...session.user, instanceRole: "user" } }, request),
  ).rejects.toMatchObject({ code: "forbidden" });
  await database
    .updateTable("authSessions")
    .set({ createdAt: new Date(0), expiresAt: new Date(1) })
    .execute();
  await expect(updates.request(session, request)).rejects.toMatchObject({ code: "unauthorized" });
});

it.each(["1.0.1", "1.0.0"])(
  "reconciles only a new desktop incarnation against its persisted target (%s)",
  async (version) => {
    const updates = makeService();
    const executor = {};
    const incarnationId = randomUUID();
    let detach = await updates.attachExecutor(executor, incarnationId, state);
    const operation = await updates.request(session, request);
    const progress = (phase: DesktopUpdateProgress["state"], targetVersion: string | null) => ({
      type: "desktop-update.progress" as const,
      messageId: randomUUID(),
      operationId: operation.id,
      state: phase,
      fromVersion: "1.0.0",
      targetVersion,
      detail: null,
    });
    await expect(updates.progress(executor, progress("installing", "1.0.1"))).rejects.toMatchObject(
      { code: "conflict" },
    );
    await updates.progress(executor, progress("running", null));
    await updates.progress(executor, progress("running", null));
    await updates.progress(executor, progress("staged", "1.0.1"));
    expect(await store.latest()).toMatchObject({ state: "staged", targetVersion: "1.0.1" });
    detach();
    const restartedHost = makeService();
    detach = await restartedHost.attachExecutor(executor, incarnationId, state);
    expect(await restartedHost.next(executor)).toMatchObject({ state: "staged" });
    await restartedHost.progress(executor, progress("staged", "1.0.1"));
    await expect(
      restartedHost.progress(executor, progress("installing", "1.0.2")),
    ).rejects.toMatchObject({ code: "conflict" });
    await restartedHost.progress(executor, progress("installing", "1.0.1"));
    detach();
    const reconnected = makeService();
    detach = await reconnected.attachExecutor(executor, incarnationId, state);
    expect(await reconnected.next(executor)).toMatchObject({
      state: "installing",
      targetVersion: "1.0.1",
    });
    await reconnected.progress(executor, progress("installing", "1.0.1"));
    detach();
    const relaunched = makeService();
    detach = await relaunched.attachExecutor(executor, randomUUID(), {
      ...state,
      currentVersion: version,
    });
    expect(await relaunched.next(executor)).toMatchObject({ state: "installing" });
    await expect(
      relaunched.progress(executor, progress("installing", "1.0.1")),
    ).rejects.toMatchObject({ code: "conflict" });
    const settled = progress(version === "1.0.1" ? "succeeded" : "failed", "1.0.1");
    await relaunched.progress(executor, {
      ...settled,
      detail: version === "1.0.1" ? null : "not-applied",
    });
    expect(await relaunched.next(executor)).toBeNull();
    expect(await store.latest()).toMatchObject({
      state: version === "1.0.1" ? "succeeded" : "failed",
      detail: version === "1.0.1" ? null : "not-applied",
    });
    detach();
  },
);

async function fixture(updates: PersonalDesktopUpdate | null) {
  const app = Fastify();
  const authenticator = new HostAuthenticator({
    publicUrl: new URL("http://127.0.0.1:4310"),
    identity: {
      authenticateNativeAccessToken: async (token: string) => {
        const row = await database
          .selectFrom("authSessions")
          .selectAll()
          .where("id", "=", session.id)
          .where("expiresAt", ">", new Date())
          .executeTakeFirst();
        if (!row || !["owner", "member"].includes(token))
          throw new OpensteerError({ code: "unauthorized", message: "Invalid session" });
        return {
          sessionId: row.id,
          subject: userId,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          absoluteExpiresAt: row.absoluteExpiresAt,
        };
      },
      userSessionProfile: async () => ({
        ...session.user,
        instanceRole: (
          await database
            .selectFrom("users")
            .select("instanceRole")
            .where("id", "=", userId)
            .executeTakeFirstOrThrow()
        ).instanceRole,
      }),
      requireSession: async (headers: Headers) => {
        if (headers.get("cookie") !== "session=owner")
          throw new OpensteerError({ code: "unauthorized", message: "No session" });
        return session;
      },
    } as never,
  });
  app.setErrorHandler((error, _request, reply) => {
    const code = error instanceof OpensteerError ? error.code : "invalid_request";
    void reply
      .code(
        code === "unauthorized"
          ? 401
          : code === "forbidden"
            ? 403
            : code === "conflict"
              ? 409
              : 400,
      )
      .send({ error: code });
  });
  registerDesktopUpdateMaintenance(app, authenticator, updates);
  return app;
}

it("maintenance ignores the client epoch but retains authentication, current owner authority and server refusal", async () => {
  const app = await fixture(makeService());
  const server = await fixture(null);
  try {
    const path = `/maintenance/v1/desktop-update?apiVersion=${hostApiVersion + 1}`;
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: path, headers: { authorization: "Bearer expired" } })).statusCode,
    ).toBe(401);
    const headers = {
      authorization: "Bearer owner",
      "x-opensteer-api-version": String(hostApiVersion + 1),
    };
    expect((await app.inject({ url: path, headers })).json()).toMatchObject({ supported: true });
    expect(
      (await app.inject({ url: path, headers, method: "POST", payload: request })).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: path,
          method: "POST",
          payload: request,
          headers: { cookie: "session=owner", origin: "https://untrusted.test" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: path,
          method: "POST",
          payload: request,
          headers: { cookie: "session=owner" },
        })
      ).statusCode,
    ).toBe(403);
    expect((await server.inject({ url: path, headers })).json()).toMatchObject({
      supported: false,
    });
    expect(
      (await server.inject({ url: path, headers, method: "POST", payload: request })).statusCode,
    ).toBe(409);
    await database
      .updateTable("users")
      .set({ instanceRole: "user" })
      .where("id", "=", userId)
      .execute();
    expect((await app.inject({ url: path, headers })).statusCode).toBe(403);
    const member = { ...session, user: { ...session.user, instanceRole: "user" as const } };
    await expect(makeService().request(member, request)).rejects.toMatchObject({
      code: "forbidden",
    });
  } finally {
    await database
      .updateTable("users")
      .set({ instanceRole: "administrator" })
      .where("id", "=", userId)
      .execute();
    await app.close();
    await server.close();
  }
});

it("long-poll wakes on change and rechecks an expired session before delivering a delayed response", async () => {
  const updates = makeService();
  const app = await fixture(updates);
  const headers = { authorization: "Bearer owner" };
  const waiting = vi.spyOn(updates, "wait");
  try {
    const initial = (await app.inject({ url: "/maintenance/v1/desktop-update", headers })).json<{
      revision: string;
    }>();
    const response = app.inject({
      url: `/maintenance/v1/desktop-update?after=${encodeURIComponent(initial.revision)}`,
      headers,
    });
    void response.then(() => {});
    await vi.waitFor(
      () => expect(waiting).toHaveBeenCalledWith(initial.revision, expect.any(AbortSignal)),
      { timeout: 1000 },
    );
    await database
      .updateTable("authSessions")
      .set({ createdAt: new Date(0), expiresAt: new Date(1) })
      .where("id", "=", session.id)
      .execute();
    updates.changed();
    expect(
      (
        await withTimeout(Promise.resolve(response), 1000, {
          timeoutError: () => new Error("Expired maintenance wait never completed"),
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    updates.close();
    await app.close();
  }
});

it("acknowledges supervisor phases only after persistence and retains pushed state in memory", async () => {
  const updates = makeService();
  const app = await fixture(updates);
  await app.register(websocket);
  const capability = "test-desktop-supervisor-capability".padEnd(43, "x");
  registerPersonalRemoteExecutor(
    app,
    new LocalBootstrapService({
      publicUrl: new URL("http://127.0.0.1:4310"),
      requireSetupCredential: true,
      setupToken: capability,
      store: {} as never,
      runners: {} as never,
    }),
    {
      close: () => {},
      attachExecutor: () => () => {},
      subscribe: () => () => {},
      next: async () => null,
    } as unknown as PersonalRemoteAdministration,
    updates,
  );
  let socket: WebSocket | undefined;
  try {
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    socket = new WebSocket(
      `${address.replace("http:", "ws:")}/v1/desktop-supervisor?apiVersion=${hostApiVersion}`,
      { headers: { authorization: `Bearer ${capability}` } },
    );
    await withTimeout(once(socket, "open"), 1000, {
      timeoutError: () => new Error("Desktop supervisor never connected"),
    });
    const ack = (messageId: string) =>
      withTimeout(
        new Promise<void>((resolve) => {
          const receive = (data: WebSocket.RawData) => {
            const message = JSON.parse(data.toString()) as {
              type: string;
              messageId?: string;
              accepted?: boolean;
            };
            if (message.type === "ack" && message.messageId === messageId) {
              socket!.off("message", receive);
              expect(message.accepted).toBe(true);
              resolve();
            }
          };
          socket!.on("message", receive);
        }),
        1000,
        { timeoutError: () => new Error("Supervisor never acknowledged the persisted phase") },
      );
    const helloId = randomUUID();
    const hello = ack(helloId);
    socket.send(
      JSON.stringify({ type: "hello", messageId: helloId, incarnationId: randomUUID(), state }),
    );
    await hello;
    expect(await updates.status(session)).toMatchObject({ state });
    const operation = await updates.request(session, request);
    for (const phase of ["running", "staged", "installing"] as const) {
      const messageId = randomUUID();
      const acknowledged = ack(messageId);
      socket.send(
        JSON.stringify({
          type: "desktop-update.progress",
          messageId,
          operationId: operation.id,
          state: phase,
          fromVersion: state.currentVersion,
          targetVersion: phase === "running" ? null : "1.0.1",
          detail: null,
        }),
      );
      await acknowledged;
      expect(await store.latest()).toMatchObject({
        state: phase,
        targetVersion: phase === "running" ? null : "1.0.1",
      });
    }
  } finally {
    socket?.terminate();
    updates.close();
    await app.close();
  }
});
