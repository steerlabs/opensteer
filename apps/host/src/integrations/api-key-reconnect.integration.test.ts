/**
 * Real Host RPC, integration MCP, PostgreSQL and a local HTTP upstream prove
 * the no-health-check API-key incident and its repair. No service/store mocks.
 *
 * Failure cases: an unchecked key cannot connect; a 401 leaves it usable;
 * reconnect loses the requested account, rotates no credential, fails to settle
 * the pinned Request or queue its continuation, or keeps sending the old key;
 * fresh discovery confuses duplicate account names, a continuation borrows another
 * account's readiness, a stored grant leaks other accounts, or describe loses identity;
 * omitting the account unexpectedly repairs it; another owner's, revoked or
 * different-definition account can be overwritten; a health-checked identity
 * can change underneath existing access or collide with another connection.
 * Writes a timestamped, credential-redacted result.json outside the checkout.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createId, RequestIdSchema, type RequestId } from "@opensteer/core";
import { integrationAccountDetail } from "@opensteer/client/integrations";
import { notionIntegration } from "@opensteer/integration-catalog";
import {
  IntegrationConnectionIdSchema,
  IntegrationDefinitionSummarySchema,
  createIntegrationId,
  integrationProviderIdentityAlreadyConnectedDetail,
  type ConnectIntegrationApiKey,
  type IntegrationConnectionId,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import {
  ignoreForeignTestRequest,
  probeTestServer,
} from "@opensteer/shared/test-support/serverProbes";
import {
  integrationGateway,
  operation,
  operations,
  toolText,
} from "../runtime/computer-apps.test-support.js";
import {
  connectCallerMachine,
  createMachineAccessDatabase,
  dispatchCallerRun,
  enrollmentToken,
  resetMachineAccessDatabase,
  signUpUser,
  startMachineAccessHost,
  type MachineAccessHost,
} from "../runtime/machine-access.test-support.js";
import { testRpcData, testRpcRequest } from "../server/test-host-api-request.js";

const baseDatabaseUrl = process.env.OPENSTEER_TEST_DATABASE_URL;
const integration = baseDatabaseUrl ? describe : describe.skip;
const upstreamOrigin = "https://vapi.example.test";
const badKey = "vapi-incident-rejected-1001";
const goodKey = "vapi-incident-correct-2002";
const notionKey = "notion-original-3003";
const otherNotionKey = "notion-different-account-4004";

integration("API-key reconnect incident", () => {
  let database: Awaited<ReturnType<typeof createMachineAccessDatabase>>;
  const closers: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    database = await createMachineAccessDatabase(baseDatabaseUrl ?? "");
    await resetMachineAccessDatabase(database.url);
  }, 120_000);
  afterEach(async () => {
    for (const close of closers) await close();
  }, 60_000);
  afterAll(async () => database?.drop(), 120_000);

  it("repairs the exact pinned account, resumes its thread and preserves account boundaries", async ({
    task,
  }) => {
    const startedAt = new Date().toISOString();
    const artifactDirectory = await mkdtemp(join(tmpdir(), "opensteer-api-key-reconnect-e2e-"));
    const steps: { readonly at: string; readonly observed: unknown; readonly step: string }[] = [];
    const record = (step: string, observed: unknown) =>
      steps.push({ at: new Date().toISOString(), observed, step });
    let failure: unknown = null;
    const upstream = await startApiKeyUpstream();
    closers.push(() => upstream.close());
    try {
      const host = await startMachineAccessHost(database.url, {
        integrationFetch: upstream.fetch,
        signupPolicy: "open",
      });
      closers.unshift(() => host.close());
      const caller = await connectCallerMachine(host, {
        name: "API-key incident agent",
        token: await enrollmentToken(host, {
          allowedModules: ["agents"],
          idempotencyKey: "api-key-reconnect-caller",
          name: "API-key incident agent",
        }),
      });
      closers.unshift(() => caller.close());
      const bootstrap = await testRpcData(
        host.origin,
        "bootstrap.get",
        {},
        { headers: host.ownerHeaders },
      );
      const main = bootstrap.homeWorkspace;
      if (!main) throw new Error("The owner has no Main Workspace");
      const run = await dispatchCallerRun(host, caller, {
        key: "api-key-reconnect-run",
        title: "Connect Vapi API and list assistants",
        workspaceId: main.id,
      });
      closers.unshift(() => run.complete());
      const gateway = await integrationGateway(run.integrationTools);
      closers.unshift(() => gateway.close());
      const connect = (key: string, input: ConnectIntegrationApiKey, headers = host.ownerHeaders) =>
        testRpcData(
          host.origin,
          "commands.dispatch",
          {
            idempotencyKey: key,
            input,
            type: "integration.apiKey.connect",
          },
          { headers },
        );
      const requestRecord = async (requestId: RequestId) => ({
        request: await host.store.requests.get(requestId),
        detail: await host.store.database
          .selectFrom("integrationRequestDetails")
          .selectAll()
          .where("requestId", "=", requestId)
          .executeTakeFirstOrThrow(),
      });
      const continuation = (requestId: RequestId) =>
        host.store.database
          .selectFrom("requestContinuations")
          .selectAll()
          .where("requestId", "=", requestId)
          .executeTakeFirst();

      // The agent proposes the API with an unpinned access Request. Installing
      // it leaves that same Request pending until the owner connects a key.
      const proposed = await gateway.call("integration_propose", {
        access: "read",
        description: "Voice AI agents that answer and place phone calls.",
        kind: "openapi",
        reason: "List this account's voice assistants",
        source: `${upstreamOrigin}/openapi.json`,
      });
      const originalRequestId = RequestIdSchema.parse(proposed.requestId);
      expect(proposed).toMatchObject({ status: "pending" });
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "api-key-reconnect-install",
          requestId: originalRequestId,
          response: { kind: "choice", optionId: "installed" },
          type: "request.respond",
        },
        { headers: host.ownerHeaders },
      );
      const installation = await host.store.database
        .selectFrom("integrationInstallations")
        .selectAll()
        .where("sourceKind", "=", "proposed")
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      const definition = IntegrationDefinitionSummarySchema.parse(installation.manifest.definition);
      const method = definition.authMethods.find(({ kind }) => kind === "api-key");
      if (!method || method.kind !== "api-key") throw new Error("Proposal has no API-key method");
      expect(method.placements).toContainEqual({
        carrier: "header",
        name: "Authorization",
        prefix: "Bearer ",
        variable: "apiKey",
      });
      expect(installation.adapterSnapshot?.config).not.toHaveProperty("healthCheck");
      expect(await requestRecord(originalRequestId)).toMatchObject({
        request: { kind: "integration.access", status: "pending" },
        detail: { requestedConnectionId: null },
      });
      const keyInput = (
        apiKey: string,
        connectionId?: IntegrationConnectionId,
      ): ConnectIntegrationApiKey => ({
        authMethodId: method.id,
        ...(connectionId === undefined ? {} : { connectionId }),
        definitionId: definition.id,
        displayName: "Vapi API",
        values: { apiKey },
      });
      const beforeConnect = upstream.received.length;
      await upstream.probe();
      await connect("api-key-reconnect-initial", keyInput(badKey));
      const a = await host.store.database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("integrationDefinitionId", "=", definition.id)
        .where("ownerUserId", "=", host.ownerId)
        .executeTakeFirstOrThrow();
      const aId = IntegrationConnectionIdSchema.parse(a.id);
      expect(a).toMatchObject({
        status: "connected",
        credentialGeneration: 1,
        externalIdentityId: null,
      });
      // Connected means accepted locally: with no health check, no credential
      // was sent to the provider and no provider identity was verified.
      expect(upstream.received.slice(beforeConnect)).toEqual([]);
      expect(await requestRecord(originalRequestId)).toMatchObject({
        request: {
          status: "fulfilled",
          response: { kind: "external", value: { connectionId: aId, decision: "fulfilled" } },
        },
      });
      record("unchecked key connects and fulfills the unpinned request", {
        connection: connectionEvidence(a),
        request: await requestRecord(originalRequestId),
        upstreamCredentialCalls: upstream.received.length - beforeConnect,
      });

      const searched = await gateway.call("integration_search", { query: "Vapi API" });
      const assistant = operation(searched, "assistants.listAssistants");
      expect(assistant.connectionId).toBe(aId);
      expect(assistant).not.toHaveProperty("readiness");
      const refused = await gateway.callRaw("integration_call", {
        arguments: {},
        toolRef: assistant.toolRef,
      });
      expect(refused.isError).toBe(true);
      expect(toolText(refused)).toBe(
        '"Vapi API" account authorization is required. Search again for current readiness and call integration_request if this task still needs access.',
      );
      expect(upstream.received.at(-1)).toMatchObject({
        authorization: "Bearer …1001",
        path: "/assistant",
        status: 401,
      });
      const needsAttention = await connectionRow(host, aId);
      expect(needsAttention).toMatchObject({ status: "needs-attention", credentialGeneration: 1 });
      record("upstream 401 requires renewed authorization", {
        agentResponse: toolText(refused),
        connection: connectionEvidence(needsAttention),
        upstream: upstream.received.at(-1),
      });

      const requested = await gateway.call("integration_request", {
        access: "read",
        account: aId,
        integration: installation.id,
        reason: "Reconnect the account whose key Vapi rejected",
      });
      const reconnectRequestId = RequestIdSchema.parse(requested.requestId);
      const pinned = await requestRecord(reconnectRequestId);
      expect(pinned).toMatchObject({
        request: { kind: "integration.access", status: "pending" },
        detail: { requestedConnectionId: aId, installationId: installation.id },
      });
      expect(await continuation(reconnectRequestId)).toBeUndefined();
      const pending = await testRpcData(
        host.origin,
        "thread.requests.list",
        { threadId: run.threadId },
        { headers: host.ownerHeaders },
      );
      expect(pending.requests).toContainEqual(
        expect.objectContaining({ id: reconnectRequestId, status: "pending" }),
      );
      record("agent request pins the failed connection", pinned);

      // Replay the old web-card command first. A working second key becomes B;
      // it cannot answer a Request explicitly pinned to A.
      await connect("api-key-reconnect-old-card", keyInput(goodKey));
      const oldBehaviorRows = await host.store.database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("integrationDefinitionId", "=", definition.id)
        .where("ownerUserId", "=", host.ownerId)
        .execute();
      expect(oldBehaviorRows).toHaveLength(2);
      const b = oldBehaviorRows.find(({ id }) => id !== aId);
      if (!b) throw new Error("The unpinned key did not create connection B");
      expect(b.status).toBe("connected");
      expect(await connectionRow(host, aId)).toMatchObject({
        status: "needs-attention",
        credentialGeneration: 1,
      });
      expect(await requestRecord(reconnectRequestId)).toMatchObject({
        request: { status: "pending" },
        detail: { requestedConnectionId: aId },
      });
      expect(await continuation(reconnectRequestId)).toBeUndefined();
      record("old command creates B and strands the request pinned to A", {
        connections: oldBehaviorRows.map(connectionEvidence),
        request: await requestRecord(reconnectRequestId),
        continuation: null,
      });

      const bId = IntegrationConnectionIdSchema.parse(b.id);
      const addedTimes = ["2026-09-17T09:12:03.000Z", "2026-09-17T09:12:49.000Z"];
      for (const [index, id] of [aId, bId].entries()) {
        await host.store.database
          .updateTable("integrationConnections")
          .set({ createdAt: new Date(addedTimes[index]!) })
          .where("id", "=", id)
          .execute();
      }
      const accountFacts = await Promise.all(
        [aId, bId].map(async (id) => {
          const row = await connectionRow(host, id);
          return {
            id,
            displayName: row.displayName,
            accountIdentifier: row.accountIdentifier,
            createdAt: row.createdAt.toISOString(),
          };
        }),
      );
      const labels = accountFacts.map((account) =>
        integrationAccountDetail(account, accountFacts, new Date("2026-09-17T12:00:00Z")),
      );
      expect(new Set(labels).size).toBe(2);
      expect(labels[0]).toContain(":03");
      expect(labels[1]).toContain(":49");
      record("same-named accounts in one minute show seconds", { accounts: accountFacts, labels });
      const attentionSearch = await gateway.call("integration_search", { query: "Vapi API" });
      expect(operations(attentionSearch).map(({ connectionId }) => connectionId)).toEqual([bId]);
      record("needs-attention A is absent while B remains callable", attentionSearch);
      const sharedTools = await host.store.database
        .selectFrom("integrationTools")
        .innerJoin("integrationServers", "integrationServers.id", "integrationTools.serverId")
        .selectAll("integrationTools")
        .where("integrationServers.installationId", "=", installation.id)
        .execute();
      expect(sharedTools).toHaveLength(1);
      expect(sharedTools[0]?.connectionId).toBeNull();
      expect(
        await host.store.database
          .selectFrom("integrationGrants")
          .selectAll()
          .where("workspaceId", "=", main.id)
          .execute(),
      ).toEqual([]);

      const credentialBefore = await credentialRow(host, aId);
      const connectionIdsBefore = oldBehaviorRows.map(({ id }) => id).sort();
      // This is the updated command sent by both the web card and mobile sheet.
      await connect("api-key-reconnect-fixed-card", keyInput(goodKey, aId));
      const repaired = await connectionRow(host, aId);
      const credentialAfter = await credentialRow(host, aId);
      expect.soft(repaired).toMatchObject({
        id: aId,
        status: "connected",
        statusDetail: null,
        displayName: "Vapi API",
        credentialGeneration: a.credentialGeneration + 1,
        credentialId: a.credentialId,
      });
      expect(credentialAfter.encryptedPayload).not.toEqual(credentialBefore.encryptedPayload);
      const repairedIds = await host.store.database
        .selectFrom("integrationConnections")
        .select("id")
        .where("integrationDefinitionId", "=", definition.id)
        .where("ownerUserId", "=", host.ownerId)
        .execute();
      expect(repairedIds.map(({ id }) => id).sort()).toEqual(connectionIdsBefore);
      expect(await requestRecord(reconnectRequestId)).toMatchObject({
        request: {
          status: "fulfilled",
          response: { kind: "external", value: { connectionId: aId, decision: "fulfilled" } },
        },
        detail: { requestedConnectionId: aId },
      });
      await expect
        .poll(async () => (await continuation(reconnectRequestId))?.status)
        .toBe("queued");
      const queuedInput = await host.store.database
        .selectFrom("threadInputs")
        .selectAll()
        .where("idempotencyKey", "=", `request-continuation:${reconnectRequestId}`)
        .executeTakeFirstOrThrow();
      expect(queuedInput).toMatchObject({
        threadId: run.threadId,
        state: "pending",
        policy: "queue",
      });
      const after = await gateway.call("integration_search", { query: "Vapi API" });
      expect(operations(after)).toHaveLength(2);
      expect(
        operations(after)
          .map(({ connectionId }) => connectionId)
          .sort(),
      ).toEqual([aId, bId].sort());
      for (const candidate of operations(after)) {
        expect(candidate.account).toBe("Vapi API");
        expect(candidate).not.toHaveProperty("readiness");
      }
      const aggregate = after.results as readonly {
        readonly tools: readonly Record<string, unknown>[];
      }[];
      for (const result of aggregate)
        for (const tool of result.tools) {
          expect(tool).not.toHaveProperty("toolRef");
          expect(tool).not.toHaveProperty("account");
        }
      const repairedAssistant = operations(after).find(({ connectionId }) => connectionId === aId);
      if (!repairedAssistant) throw new Error("The repaired connection's operation was not found");
      const queuedMessage = await host.store.database
        .selectFrom("messages")
        .select("content")
        .where("id", "=", queuedInput.messageId)
        .executeTakeFirstOrThrow();
      const continuationText = JSON.stringify(queuedMessage.content);
      expect(continuationText).toContain(aId);
      expect(continuationText).toContain("Vapi API");
      expect(continuationText).toContain("read access is active");
      expect(continuationText).not.toContain("Call integration_search");
      const described = await gateway.callRaw("integration_describe", {
        toolRef: repairedAssistant.toolRef,
      });
      expect(JSON.parse(toolText(described).split("\n")[0]!)).toMatchObject({
        account: { alias: "Vapi API", connectionId: aId },
      });
      const accessedBefore = await host.store.database
        .selectFrom("securityAudit")
        .select("id")
        .where("action", "=", "integration.connection.accessed")
        .execute();
      const succeeded = await gateway.callRaw("integration_call", {
        arguments: {},
        toolRef: repairedAssistant.toolRef,
      });
      expect(succeeded.isError).toBeFalsy();
      expect(succeeded.structuredContent).toEqual({
        assistants: [{ id: "assistant_1", name: "Riley" }],
      });
      expect(upstream.received.at(-1)).toMatchObject({
        authorization: "Bearer …2002",
        path: "/assistant",
        status: 200,
      });
      const accessedAfter = await host.store.database
        .selectFrom("securityAudit")
        .selectAll()
        .where("action", "=", "integration.connection.accessed")
        .execute();
      const accessed = accessedAfter.filter(
        ({ id }) => !accessedBefore.some((row) => row.id === id),
      );
      expect(accessed.map(({ targetId }) => targetId)).toEqual([aId]);
      record("fresh discovery and describe identify the repaired account; audit proves execution", {
        search: after,
        describeHeader: JSON.parse(toolText(described).split("\n")[0]!),
        accessed,
        continuation: queuedMessage.content,
      });
      record(
        "fixed command repairs A, fulfills the request, queues continuation and sends the new key",
        {
          connection: connectionEvidence(repaired),
          connectionIdsBefore,
          connectionIdsAfter: repairedIds.map(({ id }) => id).sort(),
          request: await requestRecord(reconnectRequestId),
          continuation: await continuation(reconnectRequestId),
          threadInput: {
            idempotencyKey: queuedInput.idempotencyKey,
            state: queuedInput.state,
            threadId: queuedInput.threadId,
          },
          result: succeeded.structuredContent,
          upstream: upstream.received.at(-1),
        },
      );

      await connect("generation-fence-old-key", keyInput(badKey, aId));
      const heldRejection = upstream.holdNextRejection();
      const oldCall = gateway.callRaw("integration_call", {
        arguments: {},
        toolRef: repairedAssistant.toolRef,
      });
      await heldRejection.arrived;
      let repairedGeneration: number;
      try {
        await connect("generation-fence-repair", keyInput(goodKey, aId));
        repairedGeneration = (await connectionRow(host, aId)).credentialGeneration;
      } finally {
        heldRejection.release();
      }
      expect((await oldCall).isError).toBe(true);
      const afterOldRejection = await connectionRow(host, aId);
      expect(afterOldRejection).toMatchObject({
        status: "connected",
        statusDetail: null,
        credentialGeneration: repairedGeneration,
      });
      record("held old-generation 401 cannot re-flag a repaired connection", {
        connection: connectionEvidence(afterOldRejection),
      });

      const specialized = await dispatchCallerRun(host, caller, {
        key: "api-key-specialized",
        title: "Use only the approved Vapi account",
      });
      closers.unshift(() => specialized.complete());
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "integration.grant.create",
          idempotencyKey: "api-key-specialized-grant",
          input: {
            access: "read",
            alias: "Vapi API",
            connectionId: aId,
            installationId: installation.id,
            isDefault: true,
            workspaceId: specialized.workspaceId,
          },
        },
        { headers: host.ownerHeaders },
      );
      const specializedGateway = await integrationGateway(specialized.integrationTools);
      closers.unshift(() => specializedGateway.close());
      const specializedSearch = await specializedGateway.call("integration_search", {
        query: "Vapi API",
      });
      expect(operations(specializedSearch).map(({ connectionId }) => connectionId)).toEqual([aId]);
      record("stored grant exposes only A in a specialized Workspace", specializedSearch);

      // A fulfilled target can fail before outbox delivery. Seed an undelivered
      // copy of the real fulfilled Request after A fails, while B still works;
      // the running Host must evaluate and deliver its continuation itself.
      await connect("api-key-expired-again", keyInput(badKey, aId));
      expect(
        (
          await gateway.callRaw("integration_call", {
            arguments: {},
            toolRef: repairedAssistant.toolRef,
          })
        ).isError,
      ).toBe(true);
      const delayedRequestId = createId("request");
      const seedFulfilledContinuation = async (requestId: RequestId, callId: string) =>
        host.store.database.transaction().execute(async (transaction) => {
          const fulfilled = await transaction
            .selectFrom("requests")
            .selectAll()
            .where("id", "=", reconnectRequestId)
            .executeTakeFirstOrThrow();
          const detail = await transaction
            .selectFrom("integrationRequestDetails")
            .selectAll()
            .where("requestId", "=", reconnectRequestId)
            .executeTakeFirstOrThrow();
          await transaction
            .insertInto("requests")
            .values({
              ...fulfilled,
              id: requestId,
              callId,
            })
            .execute();
          await transaction
            .insertInto("integrationRequestDetails")
            .values({
              ...detail,
              requestId,
            })
            .execute();
          await transaction
            .insertInto("requestContinuations")
            .values({
              requestId,
              status: "waiting",
              attemptedAt: null,
              reason: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            })
            .execute();
        });
      await seedFulfilledContinuation(delayedRequestId, "delayed-fulfillment-state");
      await expect
        .poll(async () => (await continuation(delayedRequestId))?.status, { timeout: 15_000 })
        .toBe("queued");
      const delayedMessage = await host.store.database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select("messages.content")
        .where("threadInputs.idempotencyKey", "=", `request-continuation:${delayedRequestId}`)
        .executeTakeFirstOrThrow();
      const unusable = JSON.stringify(delayedMessage.content);
      expect(unusable).toContain(aId);
      expect(unusable).toContain("not usable");
      expect(unusable).not.toContain("access is active");
      expect(
        operations(await gateway.call("integration_search", { query: "Vapi API" })).map(
          ({ connectionId }) => connectionId,
        ),
      ).toEqual([bId]);
      record("fulfilled A cannot borrow healthy B's state", { message: unusable });
      await connect("api-key-repair-again", keyInput(goodKey, aId));

      const serverX = await host.store.database
        .selectFrom("integrationServers")
        .selectAll()
        .where("installationId", "=", installation.id)
        .executeTakeFirstOrThrow();
      const serverYId = createIntegrationId("server");
      const toolX = sharedTools[0]!;
      await host.store.database.transaction().execute(async (transaction) => {
        await transaction
          .insertInto("integrationServers")
          .values({ ...serverX, id: serverYId, name: "secondary" })
          .execute();
        await transaction
          .insertInto("integrationTools")
          .values({ ...toolX, id: createIntegrationId("tool"), serverId: serverYId })
          .execute();
        await transaction
          .insertInto("integrationToolDefinitions")
          .values({
            serverId: serverYId,
            connectionId: null,
            definitions: {},
            updatedAt: new Date(),
          })
          .execute();
        await transaction
          .updateTable("integrationServers")
          .set({ status: "needs-attention", statusDetail: "Target server unavailable" })
          .where("id", "=", serverX.id)
          .execute();
      });
      const secondaryOperations = operations(
        await gateway.call("integration_search", { query: "Vapi API" }),
      );
      const secondary = secondaryOperations.find(({ connectionId }) => connectionId === aId);
      if (!secondary) throw new Error("Secondary server is not callable");
      expect(
        (await gateway.callRaw("integration_call", { arguments: {}, toolRef: secondary.toolRef }))
          .isError,
      ).toBeFalsy();
      const mixedServerRequestId = createId("request");
      await seedFulfilledContinuation(mixedServerRequestId, "mixed-server-fulfillment");
      await expect
        .poll(async () => (await continuation(mixedServerRequestId))?.status, { timeout: 15_000 })
        .toBe("queued");
      const mixedMessage = await host.store.database
        .selectFrom("threadInputs")
        .innerJoin("messages", "messages.id", "threadInputs.messageId")
        .select("messages.content")
        .where("threadInputs.idempotencyKey", "=", `request-continuation:${mixedServerRequestId}`)
        .executeTakeFirstOrThrow();
      const mixedText = JSON.stringify(mixedMessage.content);
      expect(mixedText).toContain("not usable");
      expect(mixedText).not.toContain("access is active");
      record("fulfilled server X cannot borrow working server Y readiness", {
        serverX: serverX.id,
        serverY: serverYId,
        message: mixedMessage.content,
      });
      await host.store.database
        .updateTable("integrationServers")
        .set({ status: "active", statusDetail: null })
        .where("id", "=", serverX.id)
        .execute();
      await host.store.database.transaction().execute(async (transaction) => {
        await transaction
          .selectFrom("integrationServers")
          .select("id")
          .where("id", "=", serverYId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        await transaction
          .deleteFrom("integrationTools")
          .where("serverId", "=", serverYId)
          .execute();
        await transaction
          .deleteFrom("integrationToolDefinitions")
          .where("serverId", "=", serverYId)
          .execute();
        await transaction.deleteFrom("integrationServers").where("id", "=", serverYId).execute();
      });

      // Every refusal goes through authenticated Host RPC, with the actual
      // connection/credential rows compared before and after the attempt.
      const refuse = async (
        key: string,
        input: ConnectIntegrationApiKey,
        connectionId: IntegrationConnectionId,
        code: string,
        message: string,
      ) => {
        const before = await connectionRow(host, connectionId);
        const credential = await credentialRow(host, connectionId);
        const response = await testRpcRequest(
          host.origin,
          "commands.dispatch",
          { idempotencyKey: key, input, type: "integration.apiKey.connect" },
          { headers: host.ownerHeaders },
        );
        const result: unknown = await response.json();
        expect(response.ok).toBe(false);
        expect(result).toMatchObject({ ok: false, error: { code, message } });
        expect(await connectionRow(host, connectionId)).toEqual(before);
        expect(await credentialRow(host, connectionId)).toEqual(credential);
        record(key, {
          connection: connectionEvidence(before),
          credentialUnchanged: true,
          httpStatus: response.status,
          refusal: result,
        });
      };
      const unavailable = "This connection is no longer available to reconnect";
      const otherOwner = await signUpUser(host, {
        email: "other-api-key-owner@example.test",
        password: "other-owner-password-123",
      });
      await connect("api-key-other-owner-connect", keyInput(goodKey), otherOwner.headers);
      const otherConnection = await host.store.database
        .selectFrom("integrationConnections")
        .select("id")
        .where("ownerUserId", "=", otherOwner.userId)
        .where("integrationDefinitionId", "=", definition.id)
        .executeTakeFirstOrThrow();
      const otherId = IntegrationConnectionIdSchema.parse(otherConnection.id);
      await refuse(
        "other-owner-connection-refused",
        keyInput(goodKey, otherId),
        otherId,
        "not_found",
        unavailable,
      );
      await testRpcData(
        host.origin,
        "commands.dispatch",
        { connectionId: bId, idempotencyKey: "api-key-revoke-b", type: "integration.disconnect" },
        { headers: host.ownerHeaders },
      );
      expect((await connectionRow(host, bId)).status).toBe("revoked");
      const revokedSearch = await gateway.call("integration_search", { query: "Vapi API" });
      expect(operations(revokedSearch).map(({ connectionId }) => connectionId)).toEqual([aId]);
      record("revoked B is absent while A remains callable", revokedSearch);
      await refuse(
        "revoked-connection-refused",
        keyInput(goodKey, bId),
        bId,
        "not_found",
        unavailable,
      );

      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "api-key-notion-install",
          input: { definitionId: "notion", digest: integrationDefinitionDigest(notionIntegration) },
          type: "integration.catalog.install",
        },
        { headers: host.ownerHeaders },
      );
      const notionInput = (
        apiKey: string,
        connectionId?: IntegrationConnectionId,
      ): ConnectIntegrationApiKey => ({
        authMethodId: "api-key",
        ...(connectionId === undefined ? {} : { connectionId }),
        definitionId: "notion",
        values: { apiKey },
      });
      await connect("api-key-notion-connect", notionInput(notionKey));
      const notion = await host.store.database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("integrationDefinitionId", "=", "notion")
        .where("ownerUserId", "=", host.ownerId)
        .executeTakeFirstOrThrow();
      const notionId = IntegrationConnectionIdSchema.parse(notion.id);
      expect(notion).toMatchObject({
        externalIdentityId: "notion-account-1",
        status: "connected",
        credentialGeneration: 1,
      });
      await refuse(
        "different-definition-refused",
        keyInput(goodKey, notionId),
        notionId,
        "not_found",
        unavailable,
      );
      await refuse(
        "different-provider-identity-refused",
        notionInput(otherNotionKey, notionId),
        notionId,
        "conflict",
        "This key belongs to a different account than the connection it reconnects",
      );

      // Also preserve the existing guard against an identity another owner holds.
      await connect("api-key-notion-other-owner", notionInput(otherNotionKey), otherOwner.headers);
      await refuse(
        "identity-held-by-another-connection-refused",
        notionInput(otherNotionKey),
        notionId,
        "conflict",
        integrationProviderIdentityAlreadyConnectedDetail,
      );
      const notionSearch = await gateway.call("integration_search", { query: "Notion REST" });
      const me = operations(notionSearch).find(
        ({ name }) => name.includes("retrieve") && name.includes("user"),
      );
      if (!me) throw new Error("Notion identity operation was not discoverable");
      const unchangedIdentity = await gateway.callRaw("integration_call", {
        arguments: {},
        toolRef: me.toolRef,
      });
      expect(unchangedIdentity.isError).toBeFalsy();
      expect(unchangedIdentity.structuredContent).toMatchObject({ id: "notion-account-1" });
      expect(upstream.received.at(-1)).toMatchObject({
        authorization: "Bearer …3003",
        path: "/v1/users/me",
        status: 200,
      });
      record("refused identity replacement keeps the old working credential", {
        connection: connectionEvidence(await connectionRow(host, notionId)),
        result: unchangedIdentity.structuredContent,
        upstream: upstream.received.at(-1),
      });

      const missingId = createIntegrationId("connection");
      const missingResponse = await testRpcRequest(
        host.origin,
        "commands.dispatch",
        {
          idempotencyKey: "missing-connection-refused",
          input: keyInput(goodKey, missingId),
          type: "integration.apiKey.connect",
        },
        { headers: host.ownerHeaders },
      );
      const missingResult: unknown = await missingResponse.json();
      expect.soft(missingResponse.ok).toBe(false);
      expect.soft(missingResult).toMatchObject({ ok: false, error: { code: "not_found" } });
      const missingRow = await host.store.database
        .selectFrom("integrationConnections")
        .selectAll()
        .where("id", "=", missingId)
        .executeTakeFirst();
      expect.soft(missingRow).toBeUndefined();
      record("an explicitly named missing connection cannot create an account", {
        requestedConnectionId: missingId,
        httpStatus: missingResponse.status,
        response: missingResult,
        connection: missingRow ? connectionEvidence(missingRow) : null,
      });
      for (const status of ["disabled", "needs-attention"] as const) {
        await connect(`disconnect-${status}-setup`, keyInput(goodKey));
        const account = (
          await host.store.database
            .selectFrom("integrationConnections")
            .selectAll()
            .where("integrationDefinitionId", "=", definition.id)
            .where("ownerUserId", "=", host.ownerId)
            .where("status", "=", "connected")
            .orderBy("createdAt", "desc")
            .execute()
        )[0]!;
        const id = IntegrationConnectionIdSchema.parse(account.id);
        const before = await credentialRow(host, id);
        await host.store.database
          .updateTable("integrationInstallations")
          .set({ status })
          .where("id", "=", installation.id)
          .execute();
        await refuse(
          `reconnect-${status}-refused`,
          keyInput(goodKey, id),
          id,
          "conflict",
          "Installed integration is unavailable",
        );
        const providerCalls = upstream.received.length;
        const outcome = await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            connectionId: id,
            idempotencyKey: `disconnect-${status}`,
            type: "integration.disconnect",
          },
          { headers: host.ownerHeaders },
        );
        expect((await connectionRow(host, id)).status).toBe("revoked");
        expect((await credentialRow(host, id)).encryptedPayload).not.toEqual(
          before.encryptedPayload,
        );
        expect(upstream.received.length).toBe(providerCalls);
        record(`unavailable ${status} installation permits local Disconnect`, {
          outcome,
          credentialReplaced: true,
          providerCalls: 0,
        });
        await host.store.database
          .updateTable("integrationInstallations")
          .set({ status: "active" })
          .where("id", "=", installation.id)
          .execute();
      }
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      const artifact = join(artifactDirectory, "result.json");
      const result = {
        startedAt,
        repeat:
          "OPENSTEER_TEST_DATABASE_URL=postgres://opensteer:opensteer@127.0.0.1:54348/opensteer OPENSTEER_CONTROL_PLANE_TEST_DATABASE_URL=postgres://opensteer:opensteer@127.0.0.1:54348/opensteer_control_plane pnpm test:integration apps/host/src/integrations/api-key-reconnect.integration.test.ts",
        finishedAt: new Date().toISOString(),
        passed: failure === null && (task.result?.errors?.length ?? 0) === 0,
        failure: failure instanceof Error ? failure.message : failure,
        assertionFailures: task.result?.errors?.map(({ message }) => message) ?? [],
        steps,
        upstream: upstream.received,
      };
      await writeFile(artifact, `${JSON.stringify(result, null, 2)}\n`);
      console.info(`API-key reconnect E2E artifact: ${artifact}`);
    }
  }, 180_000);
});

function connectionRow(host: MachineAccessHost, connectionId: IntegrationConnectionId) {
  return host.store.database
    .selectFrom("integrationConnections")
    .selectAll()
    .where("id", "=", connectionId)
    .executeTakeFirstOrThrow();
}

async function credentialRow(host: MachineAccessHost, connectionId: IntegrationConnectionId) {
  const connection = await connectionRow(host, connectionId);
  if (!connection.credentialId) throw new Error("The connection has no credential");
  return host.store.database
    .selectFrom("credentials")
    .selectAll()
    .where("id", "=", connection.credentialId)
    .executeTakeFirstOrThrow();
}

function connectionEvidence(connection: Awaited<ReturnType<typeof connectionRow>>) {
  return {
    id: connection.id,
    ownerUserId: connection.ownerUserId,
    definitionId: connection.integrationDefinitionId,
    credentialId: connection.credentialId,
    credentialGeneration: connection.credentialGeneration,
    displayName: connection.displayName,
    externalIdentityId: connection.externalIdentityId,
    status: connection.status,
    statusDetail: connection.statusDetail,
    updatedAt: connection.updatedAt,
  };
}

async function startApiKeyUpstream() {
  const received: {
    readonly at: string;
    readonly authorization: string | null;
    readonly path: string;
    readonly status: number;
  }[] = [];
  const document = {
    openapi: "3.1.0",
    info: { title: "Vapi API", version: "1.0.0" },
    components: { securitySchemes: { bearer: { type: "http", scheme: "Bearer" } } },
    security: [{ bearer: [] }],
    servers: [{ url: upstreamOrigin }],
    paths: {
      "/assistant": {
        get: {
          operationId: "listAssistants",
          tags: ["Assistants"],
          responses: {
            "200": {
              description: "Voice assistants",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
  let held: {
    readonly arrived: PromiseWithResolvers<void>;
    readonly release: PromiseWithResolvers<void>;
  } | null = null;
  const callerHeader = "x-opensteer-test-upstream";
  const server = createServer((request, response) => {
    if (
      ignoreForeignTestRequest(
        request,
        response,
        (path) =>
          request.headers[callerHeader] === "api-key-reconnect" ||
          ["/openapi.json", "/assistant", "/v1/users/me"].includes(path),
      )
    )
      return;
    const path = request.url ?? "/";
    const auth = request.headers.authorization ?? null;
    const respond = (status: number, body: unknown) => {
      if (path !== "/openapi.json")
        received.push({
          at: new Date().toISOString(),
          authorization: auth === null ? null : `Bearer …${auth.slice(-4)}`,
          path,
          status,
        });
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (path === "/openapi.json") respond(200, document);
    else if (request.method === "GET" && path === "/assistant") {
      if (auth === `Bearer ${goodKey}`)
        respond(200, { assistants: [{ id: "assistant_1", name: "Riley" }] });
      else if (held) {
        const waiting = held;
        held = null;
        waiting.arrived.resolve();
        void waiting.release.promise.then(() =>
          respond(401, { message: "Unauthorized", statusCode: 401 }),
        );
      } else respond(401, { message: "Unauthorized", statusCode: 401 });
    } else if (
      request.method === "GET" &&
      path === "/v1/users/me" &&
      (auth === `Bearer ${notionKey}` || auth === `Bearer ${otherNotionKey}`)
    ) {
      respond(200, {
        id: auth === `Bearer ${notionKey}` ? "notion-account-1" : "notion-account-2",
        name: "Notion workspace",
      });
    } else respond(404, { message: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Upstream has no TCP port");
  const fetchUpstream: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== upstreamOrigin && url.origin !== "https://api.notion.com")
      throw new Error(`Unexpected provider origin ${url.origin}`);
    // Count every forwarded provider call, including missing credentials or wrong paths.
    request.headers.set(callerHeader, "api-key-reconnect");
    return fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
      headers: request.headers,
      method: request.method,
      redirect: "manual",
      signal: request.signal,
    });
  };
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
    fetch: fetchUpstream,
    probe: () => probeTestServer(server),
    received,
    holdNextRejection() {
      const waiting = {
        arrived: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      held = waiting;
      return { arrived: waiting.arrived.promise, release: () => waiting.release.resolve() };
    },
  };
}
