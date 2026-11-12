import { sealOAuthBrokerPayload } from "@opensteer/integration-auth";
import {
  PersonalHostAccountLinkCompletionGrantClaimsSchema,
  CompletePersonalHostAccountLinkResponseSchema,
  IssuePersonalHostAccountLinkChallengeResponseSchema,
  personalHostAccountLinkCompletionContext,
} from "@opensteer/control-plane-protocol";
import { signHostDiscovery, signPersonalHostAccessRoute } from "../identity/host-keys.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket from "ws";
import { once } from "node:events";
import { sql, type Selectable } from "kysely";
import { hostApiVersion } from "@opensteer/deployment-authority";
import {
  rpcSuccess,
  type HostApiHandlers,
  type PersonalRemoteAdministrationIntent,
} from "@opensteer/protocol";
import { HostAuthenticator } from "../identity/auth.js";
import { LocalBootstrapService } from "../runtime/local-bootstrap.js";
import { registerHostApi } from "../server/host-api-registration.js";
import { testRpcRequest } from "../server/test-host-api-request.js";
import { registerPersonalRemoteExecutor } from "./personal-remote-administration-routes.js";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { generateKeyPairSync } from "node:crypto";
import { createId, type AuthenticatedSession } from "@opensteer/core";
import { createDatabase, type DatabaseSchema } from "@opensteer/database";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { PersonalRemoteAccessService } from "./personal-remote-access-service.js";

const databaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    "Run this file through pnpm test:integration so it receives an isolated database.",
  );
let database: ReturnType<typeof createDatabase>;
let clone: Awaited<ReturnType<typeof cloneTestDatabase>> | undefined;
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
  },
};
function service(
  options: Partial<ConstructorParameters<typeof PersonalRemoteAccessService>[0]> = {},
) {
  return new PersonalRemoteAccessService({
    authority,
    database,
    keys,
    grantVerifier: { issuer: "https://accounts.opensteer.test" } as never,
    identity: { announceSessionsEnded: () => {} } as never,
    ...options,
  });
}

describe("Personal remote administration intents", () => {
  beforeAll(async () => {
    clone = await cloneTestDatabase("host", { serverUrl: databaseUrl });
    database = createDatabase({
      applicationName: "remote-administration-test",
      connectionString: clone.url,
      maxConnections: 4,
    });
    await database
      .insertInto("users")
      .values({
        id: userId,
        displayName: session.user.displayName,
        email: session.user.email,
        emailVerified: true,
        image: null,
        disabledAt: null,
      })
      .execute();
    const deployment = await new (await import("@opensteer/database")).OpensteerStore(
      database,
    ).ensureDeployment({
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      deploymentShape: { kind: "personal" },
    });
    await (
      await import("@opensteer/database/test-support/personal")
    ).seedPersonalOwnerResources(database, {
      deploymentId: deployment.id,
      userId,
      path: "/tmp/remote-administration-personal-home",
    });
  });
  beforeEach(async () => {
    await database.deleteFrom("personalRemoteAdministration").execute();
    await database.deleteFrom("authSessions").execute();
    await database.deleteFrom("personalRemoteAccountLink").execute();
    await database.deleteFrom("personalAccountLinkKeys").execute();
    await database
      .updateTable("personalRemoteAccess")
      .set({ mode: "off", routeOrigin: null, generation: 1 })
      .execute();
    const now = new Date();
    await database
      .insertInto("authSessions")
      .values({
        id: session.id,
        userId,
        token: crypto.randomUUID(),
        expiresAt: new Date(session.expiresAt),
        absoluteExpiresAt: new Date(session.absoluteExpiresAt),
        ipAddress: null,
        userAgent: null,
        deviceLabel: "Owner device",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
  });
  afterAll(async () => {
    try {
      await database?.destroy();
    } finally {
      await clone?.drop();
    }
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
      await database.deleteFrom("authSessions").where("id", "=", session.id).execute();
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

  it.each([
    "intent",
    "approve",
    "approve-replay",
    "complete",
    "complete-replay",
    "configure",
    "configure-noop",
    "pairing",
    "resume",
    "revoke-sessions",
    "unlink",
    "projection",
    "revoke-connect",
  ] as const)(
    "refuses %s when its session is revoked while waiting on the access lock",
    async (mutation) => {
      const fixture = await sealedLinkCompletion();
      const access = fixture.access;
      await access.configure(
        { session },
        { mode: "private", routeOrigin: "https://private.test", schemaVersion: 1 },
      );
      if (
        ["complete-replay", "resume", "unlink", "projection", "revoke-connect"].includes(mutation)
      ) {
        await access.consumeAccountLink({ session }, fixture.completion);
        fixture.fetch.mockClear();
      }
      const keysBefore = await database.selectFrom("personalAccountLinkKeys").selectAll().execute();
      const linksBefore = await database
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .execute();
      const accessBefore = await access.status();
      const mutations = {
        intent: () =>
          access.administration.request(session, { action: "unlink" }, "revoked-during-admission"),
        approve: () => access.approveAccountLink({ session }, linkChallenge()),
        "approve-replay": () => access.approveAccountLink({ session }, fixture.challenge),
        complete: () => access.consumeAccountLink({ session }, fixture.completion),
        "complete-replay": () => access.consumeAccountLink({ session }, fixture.completion),
        configure: () =>
          access.configure({ session }, { mode: "off", routeOrigin: null, schemaVersion: 1 }),
        "configure-noop": () =>
          access.configure(
            { session },
            { mode: "private", routeOrigin: "https://private.test", schemaVersion: 1 },
          ),
        pairing: () => access.issuePairingCode({ session }),
        resume: () => access.resumeAccountLink({ session }, { schemaVersion: 1 }),
        "revoke-sessions": () => access.revokeAccountSessions({ session }),
        unlink: () => access.removeAccountLink({ session }),
        projection: () =>
          access.publishConnectProjection(
            { session },
            { state: "disabled", expectedAccessRoute: null, schemaVersion: 2 },
          ),
        "revoke-connect": () =>
          access.revokeConnectResource(
            { session },
            {
              hostInstanceId: authority.hostInstanceId,
              operationId: `cop_${crypto.randomUUID()}`,
            },
          ),
      };
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocker = database.transaction().execute(async (transaction) => {
        await sql`select pg_advisory_xact_lock(hashtextextended('personal-remote-access', 0))`.execute(
          transaction,
        );
        await transaction
          .selectFrom("personalRemoteAccess")
          .select("singletonKey")
          .where("singletonKey", "=", "personal")
          .forNoKeyUpdate()
          .executeTakeFirstOrThrow();
        entered();
        await withTimeout(held, 5000, {
          timeoutError: () => new Error("Access lock was never released"),
        });
      });
      let admission: Promise<unknown> | undefined;
      try {
        await withTimeout(locked, 1000, {
          timeoutError: () => new Error("Access lock was never acquired"),
        });
        admission = mutations[mutation]().then(
          () => ({ accepted: true }),
          (error: unknown) => error,
        );
        await vi.waitFor(
          async () => {
            const waiting = await sql<{
              count: number;
            }>`select count(*)::integer as count from pg_stat_activity
          where datname=current_database() and application_name='remote-administration-test'
          and wait_event_type='Lock' and query ilike '%personal%remote%access%'`.execute(database);
            expect(waiting.rows[0]?.count, "Mutation never waited on the access lock").toBe(1);
          },
          { timeout: 2000 },
        );
        await database.deleteFrom("authSessions").where("id", "=", session.id).execute();
        release();
        await blocker;
        expect(await admission).toMatchObject({ code: "unauthorized" });
        expect(
          await database.selectFrom("personalRemoteAdministration").selectAll().execute(),
        ).toEqual([]);
        expect(await database.selectFrom("personalAccountLinkKeys").selectAll().execute()).toEqual(
          keysBefore,
        );
        expect(
          await database.selectFrom("personalRemoteAccountLink").selectAll().execute(),
        ).toEqual(linksBefore);
        expect(await access.status()).toEqual(accessBefore);
        expect(
          await database.selectFrom("personalRemotePairingCodes").selectAll().execute(),
        ).toEqual([]);
        expect(fixture.fetch).not.toHaveBeenCalled();
      } finally {
        release();
        await blocker;
        await admission;
      }
    },
  );

  it.each(["verification", "activation", "authority", "unlink", "projection", "revoke"] as const)(
    "releases database connections and access/session locks while Account %s is stalled",
    async (phase) => {
      const fixture = await sealedLinkCompletion();
      const access = fixture.access;
      if (phase !== "verification")
        await access.consumeAccountLink({ session }, fixture.completion);
      if (phase === "activation" || phase === "authority")
        await database
          .updateTable("personalRemoteAccountLink")
          .set({ state: "activating" })
          .execute();
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const originalFetch = fixture.fetch.getMockImplementation()!;
      const originalVerify = fixture.verifyLink.getMockImplementation()!;
      if (phase === "verification")
        fixture.verifyLink.mockImplementation(async () => {
          entered();
          await withTimeout(held, 5000, {
            timeoutError: () => new Error("Account verification was never released"),
          });
          return originalVerify();
        });
      else
        fixture.fetch.mockImplementation(async (input, init) => {
          if (phase !== "authority" || input.toString().endsWith("/authority")) {
            entered();
            await withTimeout(held, 5000, {
              timeoutError: () => new Error(`Account ${phase} was never released`),
            });
          }
          if (phase === "projection")
            return Response.json({
              accessRoute: null,
              generation: (await access.status()).generation,
              lastSeenAt: null,
              origin: null,
              state: "disabled",
            });
          if (phase === "revoke") return Response.json({ generation: 7, revoked: true });
          return originalFetch(input, init);
        });
      const pending = (
        phase === "unlink"
          ? access.removeAccountLink({ session })
          : phase === "projection"
            ? access.publishConnectProjection(
                { session },
                {
                  state: "disabled",
                  expectedAccessRoute: null,
                  schemaVersion: 2,
                },
              )
            : phase === "revoke"
              ? access.revokeConnectResource(
                  { session },
                  {
                    hostInstanceId: authority.hostInstanceId,
                    operationId: `cop_${crypto.randomUUID()}`,
                  },
                )
              : phase === "verification"
                ? access.consumeAccountLink({ session }, fixture.completion)
                : access.resumeAccountLink({ session }, { schemaVersion: 1 })
      ).then(
        () => null,
        (error: unknown) => error,
      );
      let probes: PromiseSettledResult<unknown>[] = [];
      let openTransactions = -1;
      try {
        await withTimeout(
          Promise.race([
            started,
            pending.then((error) => {
              if (error) throw error;
            }),
          ]),
          2000,
          {
            timeoutError: () => new Error(`Account ${phase} never reached the held network call`),
          },
        );
        if (phase === "projection") {
          const off = await access.administration.request(
            session,
            { action: "configure", mode: "off", privateOrigin: null },
            "off-during-stalled-account",
          );
          access.administration.release(off.id);
          const executor = {};
          const detach = access.administration.attachExecutor(executor);
          try {
            expect(
              await withTimeout(access.administration.next(executor), 1000, {
                timeoutError: () =>
                  new Error(
                    "Stalled Account publication prevented delivery of Off to the executor",
                  ),
              }),
            ).toMatchObject({ id: off.id });
          } finally {
            detach();
          }
        }
        probes = await Promise.allSettled([
          database.transaction().execute(async (transaction) => {
            await sql`set local lock_timeout = '500ms'`.execute(transaction);
            await sql`select pg_advisory_xact_lock(hashtextextended('personal-remote-access', 0))`.execute(
              transaction,
            );
            await transaction
              .selectFrom("personalRemoteAccess")
              .select("singletonKey")
              .where("singletonKey", "=", "personal")
              .forNoKeyUpdate()
              .executeTakeFirstOrThrow();
            await transaction
              .selectFrom("personalRemoteAccountLink")
              .select("singletonKey")
              .where("singletonKey", "=", "opensteer-account")
              .forUpdate()
              .execute();
          }),
          database.transaction().execute(async (transaction) => {
            await sql`set local lock_timeout = '500ms'`.execute(transaction);
            await transaction.deleteFrom("authSessions").where("id", "=", session.id).execute();
          }),
          withTimeout(database.selectFrom("users").select("id").execute(), 1000, {
            timeoutError: () => new Error(`Account ${phase} exhausted the Host connection pool`),
          }),
        ]);
        const activity = await sql<{
          count: number;
        }>`select count(*)::integer as count from pg_stat_activity
          where datname=current_database() and application_name='remote-administration-test'
          and state='idle in transaction'`.execute(database);
        openTransactions = activity.rows[0]!.count;
      } finally {
        release();
        await pending;
      }
      expect(
        openTransactions,
        `Account ${phase} retained a database connection in a transaction`,
      ).toBe(0);
      expect(
        probes.map((probe) => probe.status),
        `Stalled Account ${phase} must not block access/link locks, session revocation or unrelated queries`,
      ).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      if (phase === "verification") {
        expect(await pending).toMatchObject({ code: "unauthorized" });
        expect(
          await database.selectFrom("personalRemoteAccountLink").selectAll().execute(),
        ).toEqual([]);
      } else expect(await pending).toBeNull();
    },
  );

  it.each(["activate", "unlink", "projection", "revoke"] as const)(
    "recovers an ambiguously acknowledged Account %s step after restart without the requesting session",
    async (kind) => {
      const fixture = await sealedLinkCompletion();
      if (kind !== "activate")
        await fixture.access.consumeAccountLink({ session }, fixture.completion);
      const request = {
        hostInstanceId: authority.hostInstanceId,
        operationId: `cop_${crypto.randomUUID()}`,
      };
      const originalFetch = fixture.fetch.getMockImplementation()!;
      let lost = false;
      const calls: unknown[] = [];
      fixture.fetch.mockImplementation(async (input, init) => {
        let acknowledgement: Response;
        if (kind === "projection" && !input.toString().endsWith("/authority")) {
          const projection = JSON.parse(String(init?.body));
          acknowledgement = Response.json({
            accessRoute: projection.accessRoute,
            generation: projection.generation,
            origin: projection.origin,
            state: projection.state,
            lastSeenAt: null,
          });
        } else if (kind === "revoke" && init?.method === "DELETE")
          acknowledgement = Response.json({ generation: 7, revoked: true });
        else acknowledgement = await originalFetch(input, init);
        if (kind === "activate" || !input.toString().endsWith("/authority")) {
          calls.push(JSON.parse(String(init?.body)));
          if (!lost) {
            lost = true;
            throw new Error("Account acknowledged the step but its response was lost");
          }
        }
        return acknowledgement;
      });
      const invoke = () =>
        kind === "activate"
          ? fixture.access.consumeAccountLink({ session }, fixture.completion)
          : kind === "unlink"
            ? fixture.access.removeAccountLink({ session })
            : kind === "projection"
              ? fixture.access.publishConnectProjection(
                  { session },
                  {
                    state: "disabled",
                    expectedAccessRoute: null,
                    schemaVersion: 2,
                  },
                )
              : fixture.access.revokeConnectResource({ session }, request);
      await expect(invoke()).rejects.toThrow(accountUnreachable);
      expect(lost, "The test never dropped an Account acknowledgement").toBe(true);
      const stored = await database
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(stored).toMatchObject({
        hostCredential: fixture.hostCredential,
        accountOperation: { kind },
      });
      const recovering = service({
        fetch: fixture.fetch,
        grantVerifier: {
          issuer: fixture.challenge.account.issuer,
          verifyLink: fixture.verifyLink,
        } as never,
      });
      let accepted: Awaited<ReturnType<typeof recovering.administration.request>> | undefined;
      if (kind === "projection" || kind === "revoke") {
        accepted = await recovering.administration.request(
          session,
          {
            action: "recover",
            operationId: await seedFailedOperation(
              kind === "revoke"
                ? { action: "rotate" }
                : { action: "configure", mode: "off", privateOrigin: null },
            ),
          },
          `recover-${kind}`,
        );
        recovering.administration.release(accepted.id);
      }
      await database.deleteFrom("authSessions").where("id", "=", session.id).execute();
      if (accepted) {
        const executor = {};
        const detach = recovering.administration.attachExecutor(executor);
        try {
          expect(await recovering.administration.next(executor)).toMatchObject({ id: accepted.id });
        } finally {
          detach();
        }
      } else await recovering.publishAccountAuthority();
      expect(calls[1]).toEqual(calls[0]);
      const finished = await database
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .executeTakeFirst();
      if (kind === "unlink") expect(finished).toBeUndefined();
      else
        expect(finished).toMatchObject({
          state: "active",
          linkGeneration: stored.linkGeneration,
          accountOperation: null,
        });
    },
  );

  it.each(["none", "operation", "link"] as const)(
    "reconciles a completed, superseded revocation after restart against the exact journal (%s replacement)",
    async (replacement) => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      const originalFetch = fixture.fetch.getMockImplementation()!;
      const operationId = `cop_${crypto.randomUUID()}`;
      let attempts = 0;
      let expected: Selectable<DatabaseSchema["personalRemoteAccountLink"]> | undefined;
      fixture.fetch.mockImplementation(async (input, init) => {
        if (!input.toString().endsWith("/connect") || init?.method !== "DELETE")
          return originalFetch(input, init);
        expect(JSON.parse(String(init.body)).operationId).toBe(operationId);
        attempts += 1;
        if (attempts === 1) throw new Error("Revocation committed but response lost");
        if (replacement !== "none") {
          const stored = await database
            .selectFrom("personalRemoteAccountLink")
            .selectAll()
            .executeTakeFirstOrThrow();
          expected = await database
            .updateTable("personalRemoteAccountLink")
            .set(
              replacement === "link"
                ? { linkGeneration: "r".repeat(43) }
                : { accountOperation: { ...stored.accountOperation!, id: crypto.randomUUID() } },
            )
            .returningAll()
            .executeTakeFirstOrThrow();
        }
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "Completed revocation superseded",
              reason: "connect-operation-completed-superseded",
              completedOperation: { operationId, operationKind: "revoke", generation: 7 },
            },
          },
          { status: 409 },
        );
      });
      await expect(
        fixture.access.revokeConnectResource(
          { session },
          {
            hostInstanceId: authority.hostInstanceId,
            operationId,
          },
        ),
      ).rejects.toThrow(accountUnreachable);
      expect(
        await database
          .selectFrom("personalRemoteAccountLink")
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ accountOperation: { kind: "revoke" } });
      const restarted = service({ fetch: fixture.fetch });
      if (replacement === "none") {
        await expect(restarted.publishAccountAuthority()).resolves.toBe("published");
        expect(
          await database
            .selectFrom("personalRemoteAccountLink")
            .selectAll()
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          accountOperation: null,
          state: "active",
          hostCredential: fixture.hostCredential,
        });
      } else {
        await expect(restarted.publishAccountAuthority()).rejects.toMatchObject({
          code: "conflict",
        });
        expect(
          await database
            .selectFrom("personalRemoteAccountLink")
            .selectAll()
            .executeTakeFirstOrThrow(),
        ).toEqual(expected);
      }
      expect(attempts).toBe(2);
    },
  );

  it("retires a refused disabled projection across restart so Connect can be revoked and the Account unlinked", async () => {
    const fixture = await sealedLinkCompletion();
    await fixture.access.consumeAccountLink({ session }, fixture.completion);
    const originalFetch = fixture.fetch.getMockImplementation()!;
    const projection = vi.fn(() =>
      Response.json(
        {
          error: {
            code: "conflict",
            message: "Revoke first",
            reason: "connect-revocation-required",
          },
        },
        { status: 409 },
      ),
    );
    fixture.fetch.mockImplementation(async (input, init) => {
      if (input.toString().endsWith("/connect"))
        return init?.method === "PUT"
          ? projection()
          : Response.json({ generation: 7, revoked: true });
      return originalFetch(input, init);
    });
    await expect(
      fixture.access.publishConnectProjection(
        { session },
        { state: "disabled", expectedAccessRoute: null, schemaVersion: 2 },
      ),
    ).rejects.toMatchObject(accountAnswered(409));
    const stored = await database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(stored).toMatchObject({
      accountOperation: null,
      hostCredential: fixture.hostCredential,
      state: "active",
    });

    const restarted = service({ fetch: fixture.fetch });
    await expect(restarted.publishAccountAuthority()).resolves.toBe("published");
    expect(projection).toHaveBeenCalledOnce();
    await expect(
      restarted.revokeConnectResource(
        { session },
        {
          hostInstanceId: authority.hostInstanceId,
          operationId: `cop_${crypto.randomUUID()}`,
        },
      ),
    ).resolves.toEqual({ generation: 7, revoked: true });
    await expect(restarted.removeAccountLink({ session })).resolves.toBeUndefined();
    expect(await database.selectFrom("personalRemoteAccountLink").selectAll().execute()).toEqual(
      [],
    );
  });

  describe("after the Account answers 401 to this Host", () => {
    const request = () => ({
      hostInstanceId: authority.hostInstanceId,
      operationId: `cop_${crypto.randomUUID()}`,
    });
    const refused = () =>
      Response.json(
        { error: { code: "unauthorized", message: "Host credential is invalid" } },
        { status: 401 },
      );
    const linkGone = (input: Parameters<typeof fetch>[0]) =>
      /(activate|personal-account-link)$/u.test(input.toString())
        ? Response.json(
            {
              error: {
                code: "not_found",
                message: "No link",
                reason: "personal-account-link-not-found",
              },
            },
            { status: 404 },
          )
        : refused();
    const stuckReadyProjection = () =>
      database
        .updateTable("personalRemoteAccountLink")
        .set({
          accountOperation: {
            id: crypto.randomUUID(),
            kind: "projection",
            projection: {
              accessRoute: signPersonalHostAccessRoute(keys, {
                authority,
                documentVersion: 2,
                purpose: "opensteer-personal-access-route",
                route: { generation: 1, kind: "connect", origin: "https://connect.test" },
              }),
              generation: 1,
              state: "ready",
            },
          },
        })
        .where("singletonKey", "=", "opensteer-account")
        .execute();

    it("finishes Connect off and unlink once the Account says the link is gone", async () => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      fixture.fetch.mockImplementation(async (input) => linkGone(input));
      await stuckReadyProjection();

      await expect(fixture.access.revokeConnectResource({ session }, request())).resolves.toEqual({
        generation: 0,
        revoked: true,
      });
      await expect(
        fixture.access.publishConnectProjection(
          { session },
          { state: "disabled", expectedAccessRoute: null, schemaVersion: 2 },
        ),
      ).resolves.toBeUndefined();
      await expect(fixture.access.removeAccountLink({ session })).resolves.toBeUndefined();
      expect(await database.selectFrom("personalRemoteAccountLink").selectAll().execute()).toEqual(
        [],
      );
    });

    it("keeps a live link, and never unlinks to find out", async () => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      const originalFetch = fixture.fetch.getMockImplementation()!;
      const paths: string[] = [];
      fixture.fetch.mockImplementation(async (input, init) => {
        paths.push(`${init?.method} ${new URL(input.toString()).pathname}`);
        return input.toString().endsWith("/activate") ? originalFetch(input, init) : refused();
      });

      await expect(
        fixture.access.revokeConnectResource({ session }, request()),
      ).rejects.toMatchObject(accountAnswered(401));
      expect(paths).toEqual([
        "DELETE /v1/host/connect",
        "POST /v1/host/personal-account-link/activate",
      ]);
      expect(
        await database
          .selectFrom("personalRemoteAccountLink")
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ accountOperation: { kind: "revoke" }, state: "active" });
    });

    it("does not report a deleted tunnel as ready", async () => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      fixture.fetch.mockImplementation(async (input) => linkGone(input));
      await stuckReadyProjection();
      await expect(fixture.access.publishAccountAuthority()).rejects.toMatchObject(
        accountAnswered(401),
      );
      expect(
        await database
          .selectFrom("personalRemoteAccountLink")
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toMatchObject({ accountOperation: { kind: "projection" } });
    });
  });

  it.each([400, 401, 404, 409, 422, 408, 425, 429, 500, 503])(
    "keeps a projection journal without an explicit refusal after Account HTTP %s",
    async (status) => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      fixture.fetch.mockResolvedValue(new Response(null, { status }));
      await expect(
        fixture.access.publishConnectProjection(
          { session },
          {
            state: "disabled",
            expectedAccessRoute: null,
            schemaVersion: 2,
          },
        ),
      ).rejects.toMatchObject(accountAnswered(status));
      expect(
        await database
          .selectFrom("personalRemoteAccountLink")
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toMatchObject({
        accountOperation: { kind: "projection" },
        hostCredential: fixture.hostCredential,
      });
    },
  );

  it.each(["operation", "link"] as const)(
    "does not retire a replacement %s when a delayed Account rejection arrives",
    async (replacement) => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      let reject!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        reject = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      fixture.fetch.mockImplementation(async () => {
        enter();
        await withTimeout(held, 5000, {
          timeoutError: () => new Error("Account rejection was never released"),
        });
        return Response.json(
          {
            error: {
              code: "conflict",
              message: "Revoke first",
              reason: "connect-revocation-required",
            },
          },
          { status: 409 },
        );
      });
      const pending = fixture.access
        .publishConnectProjection(
          { session },
          {
            state: "disabled",
            expectedAccessRoute: null,
            schemaVersion: 2,
          },
        )
        .catch((error: unknown) => error);
      let expected: Selectable<DatabaseSchema["personalRemoteAccountLink"]> | undefined;
      try {
        await withTimeout(entered, 1000, {
          timeoutError: () => new Error("Account publication never started"),
        });
        const stored = await database
          .selectFrom("personalRemoteAccountLink")
          .selectAll()
          .executeTakeFirstOrThrow();
        expected = await database
          .updateTable("personalRemoteAccountLink")
          .set(
            replacement === "link"
              ? { linkGeneration: "r".repeat(43) }
              : { accountOperation: { ...stored.accountOperation!, id: crypto.randomUUID() } },
          )
          .returningAll()
          .executeTakeFirstOrThrow();
      } finally {
        reject();
        await pending;
      }
      expect(await pending).toMatchObject(accountAnswered(409));
      expect(
        await database
          .selectFrom("personalRemoteAccountLink")
          .selectAll()
          .executeTakeFirstOrThrow(),
      ).toEqual(expected);
    },
  );

  it.each([
    "network",
    "HTTP 503",
    "older 409",
    "unknown 409",
    "malformed 409",
    "wrong-operation 409",
  ])(
    "fails Account recovery visibly after %s while keeping its journal and the executor connected for Recover and Unlink",
    async (failure) => {
      const fixture = await sealedLinkCompletion();
      await fixture.access.consumeAccountLink({ session }, fixture.completion);
      if (failure === "network")
        fixture.fetch.mockRejectedValue(new Error(`network failure ${fixture.hostCredential}`));
      else
        fixture.fetch.mockImplementation(async () => {
          if (failure === "HTTP 503") return new Response(fixture.hostCredential, { status: 503 });
          if (failure === "malformed 409") return new Response("{", { status: 409 });
          return Response.json(
            {
              error: {
                code: "conflict",
                message: fixture.hostCredential,
                ...(failure === "older 409"
                  ? {}
                  : {
                      reason: failure === "unknown 409" ? "unknown" : "connect-resource-active",
                    }),
              },
            },
            { status: 409 },
          );
        });
      await expect(
        fixture.access.publishConnectProjection(
          { session },
          {
            state: "disabled",
            expectedAccessRoute: null,
            schemaVersion: 2,
          },
        ),
      ).rejects.toMatchObject(
        failure === "network"
          ? { message: expect.stringMatching(accountUnreachable) }
          : accountAnswered(failure === "HTTP 503" ? 503 : 409),
      );
      const journal = await database
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .executeTakeFirstOrThrow();
      const administration = fixture.access.administration;
      const first = await administration.request(
        session,
        {
          action: "recover",
          operationId: await seedFailedOperation({
            action: "configure",
            mode: "off",
            privateOrigin: null,
          }),
        },
        "failed-recovery",
      );
      administration.release(first.id);
      const app = Fastify();
      await app.register(websocket);
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
        administration,
      );
      const changed = vi.fn();
      const unsubscribe = administration.subscribe(changed);
      let socket: WebSocket | undefined;
      try {
        const address = await app.listen({ host: "127.0.0.1", port: 0 });
        socket = new WebSocket(
          `${address.replace("http:", "ws:")}/v1/desktop-supervisor?apiVersion=${hostApiVersion}`,
          {
            headers: { authorization: `Bearer ${capability}` },
          },
        );
        const closed = vi.fn();
        socket.on("close", closed);
        await withTimeout(once(socket, "open"), 1000, {
          timeoutError: () => new Error("Executor never opened"),
        });
        const helloAck = withTimeout(once(socket, "message"), 1000, {
          timeoutError: () => new Error("Recovery supervisor hello was not acknowledged"),
        });
        socket.send(
          JSON.stringify({
            type: "hello",
            messageId: crypto.randomUUID(),
            incarnationId: crypto.randomUUID(),
            state: {
              status: "idle",
              currentVersion: "1.0.0",
              channel: "stable",
              availableVersion: null,
              latestVersion: null,
              failed: null,
              downloadPercent: null,
            },
          }),
        );
        await helloAck;
        // The failure is committed before its notification, so wait for both.
        await vi.waitFor(
          async () => {
            expect((await administration.status(session)).operation).toMatchObject({
              id: first.id,
              state: "failed",
              detail: expect.stringMatching(/Try again/u),
            });
            expect(changed).toHaveBeenCalledTimes(2); // Executor attachment and durable failure.
          },
          { timeout: 1000 },
        );
        expect(
          await database
            .selectFrom("personalRemoteAccountLink")
            .selectAll()
            .executeTakeFirstOrThrow(),
        ).toEqual(journal);
        const status = await administration.status(session);
        expect(status.executorConnected).toBe(true);
        expect(JSON.stringify(status)).not.toContain(fixture.hostCredential);
        const second = await administration.request(
          session,
          { action: "recover", operationId: first.id },
          "retry-recovery",
        );
        expect(second.executionId).toBe(first.executionId);
        administration.release(second.id);
        await vi.waitFor(
          async () =>
            expect((await administration.status(session)).operation).toMatchObject({
              id: second.id,
              state: "failed",
            }),
          { timeout: 1000 },
        );
        const delivered = withTimeout(once(socket, "message"), 1000, {
          timeoutError: () => new Error("Unlink never reached the connected executor"),
        });
        const unlink = await administration.request(
          session,
          { action: "unlink" },
          "unlink-after-recovery-failure",
        );
        administration.release(unlink.id);
        expect(JSON.parse(String((await delivered)[0]))).toMatchObject({
          type: "remote-access.operation",
          operation: { id: unlink.id, intent: { action: "unlink" } },
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(closed).not.toHaveBeenCalled();
      } finally {
        unsubscribe();
        socket?.terminate();
        await app.close();
      }
    },
  );

  it("does not re-enable Connect while unlink is awaiting Account acknowledgement and defers session teardown until the reply", async () => {
    const fixture = await sealedLinkCompletion();
    await fixture.access.consumeAccountLink({ session }, fixture.completion);
    const announce = vi.fn();
    const access = service({
      fetch: fixture.fetch,
      identity: { announceSessionsEnded: announce } as never,
    });
    await database
      .insertInto("personalRemoteSessions")
      .values({
        authSessionId: session.id,
        routeKind: "connect",
        routeOrigin: "https://connect.test",
        routeGeneration: "1",
        delivery: "header",
        createdAt: new Date(),
      })
      .execute();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fixture.fetch.getMockImplementation()!;
    fixture.fetch.mockImplementation(async (input, init) => {
      entered();
      await withTimeout(held, 5000, {
        timeoutError: () => new Error("Unlink acknowledgement was never released"),
      });
      return original(input, init);
    });
    const effects: (() => void)[] = [];
    const unlink = access.removeAccountLink({ session }, (effect) => effects.push(effect));
    try {
      await withTimeout(started, 1000, {
        timeoutError: () => new Error("Unlink did not reach Account"),
      });
      await expect(
        access.consumeAccountLink({ session }, fixture.completion),
      ).resolves.toMatchObject({ accountLink: { state: "active" } });
      expect(
        (
          await database
            .selectFrom("personalRemoteAccountLink")
            .select("accountOperation")
            .executeTakeFirstOrThrow()
        ).accountOperation,
      ).toMatchObject({ kind: "unlink" });
      await expect(
        access.configure(
          { session },
          { mode: "connect", routeOrigin: "https://connect.test", schemaVersion: 1 },
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(
        await database
          .selectFrom("authSessions")
          .select("id")
          .where("id", "=", session.id)
          .executeTakeFirst(),
      ).toBeDefined();
      expect(announce).not.toHaveBeenCalled();
    } finally {
      release();
      await unlink;
    }
    expect(
      await database
        .selectFrom("authSessions")
        .select("id")
        .where("id", "=", session.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    expect(announce).not.toHaveBeenCalled();
    expect(effects).toHaveLength(1);
    effects[0]!();
    expect(announce).toHaveBeenCalledWith([session.id]);
  });

  it("cannot consume a completion whose challenge was cancelled during JWKS verification", async () => {
    const fixture = await sealedLinkCompletion();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fixture.verifyLink.getMockImplementation()!;
    fixture.verifyLink.mockImplementation(async () => {
      entered();
      await withTimeout(held, 5000, {
        timeoutError: () => new Error("JWKS verification was never released"),
      });
      return original();
    });
    const pending = fixture.access.consumeAccountLink({ session }, fixture.completion).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await withTimeout(started, 1000, {
        timeoutError: () => new Error("Completion did not reach JWKS verification"),
      });
      await withTimeout(fixture.access.removeAccountLink({ session }), 1000, {
        timeoutError: () => new Error("Cancellation was blocked by JWKS verification"),
      });
    } finally {
      release();
      await pending;
    }
    expect(await pending).toMatchObject({ code: "forbidden" });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(await database.selectFrom("personalAccountLinkKeys").selectAll().execute()).toEqual([]);
    expect(await database.selectFrom("personalRemoteAccountLink").selectAll().execute()).toEqual(
      [],
    );
  });

  it("cannot finalize activation into a replacement link generation", async () => {
    const fixture = await sealedLinkCompletion();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fixture.fetch.getMockImplementation()!;
    fixture.fetch.mockImplementation(async (input, init) => {
      entered();
      await withTimeout(held, 5000, {
        timeoutError: () => new Error("Activation response was never released"),
      });
      return original(input, init);
    });
    const pending = fixture.access.consumeAccountLink({ session }, fixture.completion).then(
      () => null,
      (error: unknown) => error,
    );
    const replacement = "r".repeat(43);
    try {
      await withTimeout(started, 1000, {
        timeoutError: () => new Error("Activation did not reach Account"),
      });
      await database
        .updateTable("personalRemoteAccountLink")
        .set({ linkGeneration: replacement, accountOperation: null })
        .execute();
    } finally {
      release();
      await pending;
    }
    expect(await pending).toMatchObject({ code: "conflict" });
    expect(
      await database.selectFrom("personalRemoteAccountLink").selectAll().executeTakeFirstOrThrow(),
    ).toMatchObject({ state: "activating", linkGeneration: replacement, accountOperation: null });
  });

  it("refuses hosted OAuth repair from a revoked session", async () => {
    await database.deleteFrom("authSessions").where("id", "=", session.id).execute();
    await expect(service().markHostedOAuthConnectionsForRepair({ session })).rejects.toMatchObject({
      code: "unauthorized",
    });
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

  it("admits Connect and rotation only for an active link with no unlink pending, replays included", async () => {
    const administration = service().administration;
    const connect = { action: "configure", mode: "connect", privateOrigin: null } as const;
    const refused = {
      code: "conflict",
      message: "Add this computer to your Opensteer account first.",
    };
    await expect(administration.request(session, connect, "no-link")).rejects.toMatchObject(
      refused,
    );
    await seedAccountLink("activating");
    await expect(administration.request(session, connect, "activating")).rejects.toMatchObject(
      refused,
    );
    await database
      .updateTable("personalRemoteAccountLink")
      .set({ state: "active", accountOperation: { id: crypto.randomUUID(), kind: "unlink" } })
      .execute();
    await expect(
      administration.request(session, { action: "rotate" }, "unlinking"),
    ).rejects.toMatchObject(refused);
    await expect(
      database.selectFrom("personalRemoteAdministration").select("id").execute(),
    ).resolves.toEqual([]);
    await database
      .updateTable("personalRemoteAccountLink")
      .set({ accountOperation: null })
      .execute();
    const admitted = await administration.request(session, connect, "linked");
    // A retry of an admitted request is the same request, whatever the link did since.
    await database.deleteFrom("personalRemoteAccountLink").execute();
    expect(await administration.request(session, connect, "linked")).toEqual(admitted);
    // Recovering a failed Connect change is held to the same rule.
    const executor = {};
    const detach = administration.attachExecutor(executor);
    try {
      administration.release(admitted.id);
      await administration.progress(executor, {
        operationId: admitted.id,
        state: "failed",
        detail: "Couldn't reach Opensteer.",
      });
    } finally {
      detach();
    }
    await expect(
      administration.request(
        session,
        { action: "recover", operationId: admitted.id },
        "recover-unlinked",
      ),
    ).rejects.toMatchObject(refused);
  });

  it("recovers the failed action with its original external idempotency identity", async () => {
    await seedAccountLink("active");
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
        { action: "recover", operationId: original.id },
        "recover-rotation",
      );
      expect(recovered).toMatchObject({
        intent: { action: "rotate" },
        executionId: original.executionId,
      });
      expect(recovered.id).not.toBe(original.id);
      // A retry of an admitted recover is the same request, though the failure it named is no longer latest.
      expect(
        await administration.request(
          session,
          { action: "recover", operationId: original.id },
          "recover-rotation",
        ),
      ).toEqual(recovered);
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

  it("refuses to recover a failure another device's change replaced after it was seen", async () => {
    await seedAccountLink("active");
    const administration = service().administration;
    const executor = {};
    const detach = administration.attachExecutor(executor);
    const fail = async (operationId: string) => {
      administration.release(operationId);
      await administration.progress(executor, { operationId, state: "failed", detail: "Lost" });
    };
    try {
      const rotation = await administration.request(session, { action: "rotate" }, "rotate");
      await fail(rotation.id);
      // This device sees the failed rotation; another turns it off, and that fails too.
      const off = await administration.request(
        session,
        { action: "configure", mode: "off", privateOrigin: null },
        "other-device-off",
      );
      await fail(off.id);
      await expect(
        administration.request(
          session,
          { action: "recover", operationId: rotation.id },
          "stale-recover",
        ),
      ).rejects.toMatchObject({ code: "conflict", reason: "remote-access-changed" });
      expect((await administration.status(session)).operation).toMatchObject({ id: off.id });
      await expect(
        administration.request(session, { action: "recover", operationId: off.id }, "recover-off"),
      ).resolves.toMatchObject({ intent: { action: "configure", mode: "off" } });
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
        `${address.replace("http:", "ws:")}/v1/desktop-supervisor?apiVersion=${hostApiVersion}`,
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
      const helloAck = withTimeout(once(socket, "message"), 1000, {
        timeoutError: () => new Error("Supervisor hello was not acknowledged"),
      });
      socket.send(
        JSON.stringify({
          type: "hello",
          messageId: crypto.randomUUID(),
          incarnationId: crypto.randomUUID(),
          state: {
            status: "idle",
            currentVersion: "1.0.0",
            channel: "stable",
            availableVersion: null,
            latestVersion: null,
            failed: null,
            downloadPercent: null,
          },
        }),
      );
      await helloAck;
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
      const { operation } = JSON.parse(String(frame)) as { operation: { id: string } };
      socket.send(
        JSON.stringify({
          type: "remote-access.progress",
          messageId: crypto.randomUUID(),
          progress: { operationId: operation.id, state: "succeeded", detail: null },
        }),
      );
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

  it("opens a Host-sealed completion once across restart and fences generation changes and replay after unlink", async () => {
    const {
      completion,
      hostCredential,
      grant,
      verifyLink,
      access: restarted,
    } = await sealedLinkCompletion();
    expect(JSON.stringify(completion)).not.toContain(hostCredential);
    expect(JSON.stringify(completion)).not.toContain(grant);
    await expect(
      restarted.consumeAccountLink({ session }, { ...completion, linkGeneration: "x".repeat(43) }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(
      await database.selectFrom("personalAccountLinkKeys").select("challengeId").execute(),
    ).toHaveLength(1);
    await expect(restarted.consumeAccountLink({ session }, completion)).resolves.toMatchObject({
      accountLink: { state: "active" },
    });
    expect(await database.selectFrom("personalAccountLinkKeys").selectAll().execute()).toEqual([]);
    await restarted.consumeAccountLink({ session }, completion);
    expect(verifyLink).toHaveBeenCalledOnce();
    await restarted.removeAccountLink({ session });
    await expect(restarted.consumeAccountLink({ session }, completion)).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await database.selectFrom("personalRemoteAccountLink").selectAll().execute()).toEqual(
      [],
    );
  });

  it.each(["cancel", "expiry"] as const)("erases the Host private key on %s", async (reason) => {
    let now = new Date();
    const access = service({ now: () => now });
    const challenge = linkChallenge();
    await access.approveAccountLink({ session }, challenge);
    expect(await database.selectFrom("personalAccountLinkKeys").selectAll().execute()).toHaveLength(
      1,
    );
    if (reason === "cancel") await access.removeAccountLink({ session });
    else {
      now = new Date(Date.parse(challenge.expiresAt) + 24 * 60 * 60_000 + 1);
      await access.purgeExpiredAccountLinkKeys();
    }
    expect(await database.selectFrom("personalAccountLinkKeys").selectAll().execute()).toEqual([]);
  });

  it("refuses a non-owner without writing an intent", async () => {
    const other = { ...session, user: { ...session.user, id: createId("user") } };
    const administration = service().administration;
    await expect(
      administration.request(other, { action: "unlink" }, "unauthorized"),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(await database.selectFrom("personalRemoteAdministration").selectAll().execute()).toEqual(
      [],
    );
  });
});

async function seedAccountLink(state: "activating" | "active") {
  const now = new Date();
  await database
    .insertInto("personalRemoteAccountLink")
    .values({
      singletonKey: "opensteer-account",
      accountOperation: null,
      challengeId: `phc_${crypto.randomUUID()}`,
      grantId: `phg_${crypto.randomUUID()}`,
      issuer: "https://accounts.opensteer.test",
      hostCredential: `osc_${"a".repeat(43)}`,
      linkGeneration: "n".repeat(43),
      state,
      subject: `acct_${crypto.randomUUID()}`,
      linkedAt: now,
      updatedAt: now,
    })
    .execute();
}

/** A change the executor already failed, as an Account step it started leaves behind. */
async function seedFailedOperation(intent: PersonalRemoteAdministrationIntent): Promise<string> {
  const id = crypto.randomUUID();
  await database
    .insertInto("personalRemoteAdministration")
    .values({
      id,
      executionId: id,
      requestedIntent: intent,
      requestedBy: userId,
      idempotencyKey: `seeded-${id}`,
      intent,
      state: "failed",
      detail: "Couldn't reach Opensteer.",
    })
    .execute();
  return id;
}

function linkChallenge() {
  return IssuePersonalHostAccountLinkChallengeResponseSchema.parse({
    completionFormat: "sealed-v1",
    account: { issuer: "https://accounts.opensteer.test", subject: `acct_${crypto.randomUUID()}` },
    authorityEnvelope: signHostDiscovery(keys, authority),
    challengeId: `phc_${crypto.randomUUID()}`,
    challengeCredential: `olc_${"c".repeat(43)}`,
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
}

async function sealedLinkCompletion() {
  const access = service();
  const challenge = linkChallenge();
  const proof = await access.approveAccountLink({ session }, challenge);
  const generation = "g".repeat(43);
  const grant = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(24)}`;
  const hostCredential = `osc_${"h".repeat(43)}`;
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = PersonalHostAccountLinkCompletionGrantClaimsSchema.parse({
    account: challenge.account,
    aud: authority.canonicalOrigin,
    authority,
    challengeId: challenge.challengeId,
    exp: issuedAt + 300,
    iat: issuedAt,
    iss: challenge.account.issuer,
    jti: `phg_${crypto.randomUUID()}`,
    linkGeneration: generation,
    sub: challenge.account.subject,
    tokenUse: "opensteer-personal-host-account-link",
  });
  const verifyLink = vi.fn(async () => claims);
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${hostCredential}` });
    if (input.toString().endsWith("/authority"))
      return Response.json({ deploymentId: authority.deploymentId, published: true });
    return Response.json(
      input.toString().endsWith("/activate")
        ? {
            activated: true,
            deploymentId: authority.deploymentId,
            linkGeneration: generation,
          }
        : { deploymentId: authority.deploymentId, unlinked: true },
    );
  });
  const accessWithCompletion = service({
    fetch,
    grantVerifier: { issuer: challenge.account.issuer, verifyLink } as never,
  });
  const metadata = CompletePersonalHostAccountLinkResponseSchema.omit({
    sealedCompletion: true,
  }).parse({
    challengeId: challenge.challengeId,
    linkGeneration: generation,
    resultExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    schemaVersion: 2,
  });
  const completion = {
    ...metadata,
    sealedCompletion: sealOAuthBrokerPayload(
      {
        completionGrant: grant,
        hostCredential,
        linkGeneration: generation,
        resultExpiresAt: metadata.resultExpiresAt,
      },
      proof.document.completionPublicKey,
      personalHostAccountLinkCompletionContext(
        authority,
        metadata.challengeId,
        metadata.linkGeneration,
      ),
    ),
  };
  return {
    challenge,
    completion,
    hostCredential,
    grant,
    verifyLink,
    fetch,
    access: accessWithCompletion,
  };
}

const accountUnreachable = /Couldn't reach Opensteer/u;

/** The Account answered with this status; its technical line stays out of the message. */
function accountAnswered(status: number) {
  return { request: expect.stringContaining(`HTTP ${status}`), status };
}
