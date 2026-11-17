import { expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { createId, type RunnerId, type UserId } from "@opensteer/core";
import type { DatabaseSchema } from "./schema.js";
import {
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core/adapter";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import type { PreparedIntegrationInstallFulfillment } from "./integration-request-store.js";
import { describeStore } from "./store.integration.test-support.js";

async function calendarDevice(database: Kysely<DatabaseSchema>, runnerId: RunnerId, owner: UserId) {
  const computer = await database
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", runnerId)
    .executeTakeFirstOrThrow();
  const id = createId("device");
  await database
    .insertInto("devices")
    .values({ ...computer, id, kind: "computer", ownerKind: "user", ownerUserId: owner })
    .execute();
  return id;
}

function preparedDevice(): PreparedIntegrationInstallFulfillment {
  const definition = IntegrationDefinitionSchema.parse({
    id: "apple-calendar",
    name: "Calendar",
    provider: "apple-calendar",
    description: "Calendar on a computer",
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This computer" }],
    config: {
      accessLabels: { read: "Read", readWrite: "Read and write" },
      accessSummaries: { read: "Read events", readWrite: "Change events" },
      platforms: ["darwin"],
      operations: [
        {
          name: "list_events",
          title: "List events",
          description: "Read events",
          effect: "read",
          inputSchema: {},
          outputSchema: null,
        },
      ],
    },
  });
  const digest = integrationDefinitionDigest(definition);
  const summary = integrationDefinitionSummary(definition);
  return {
    approvalManifest: { kind: "catalog", definition: summary, digest },
    material: {
      installation: {
        id: createIntegrationId("installation"),
        name: definition.id,
        title: definition.name,
        description: definition.description,
        sourceKind: "built-in",
        trust: "built-in",
        status: "active",
        manifest: { definition: summary },
        provenance: {
          definitionId: definition.id,
          definitionDigest: digest,
          maintainedBy: "opensteer",
        },
        version: digest,
      },
      servers: [
        {
          id: createIntegrationId("server"),
          name: definition.id,
          status: "active",
          statusDetail: null,
          connectionRequirement: { kind: "computer", definitionId: definition.id },
          transport: { type: "computer", definitionId: definition.id },
          catalog: { definitions: {}, tools: [] },
        },
      ],
    },
  };
}

describeStore("Device and local-server access settlement", (it) => {
  it("refuses prepared device material whose digest differs from the reviewed manifest", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.startRunFixture("device-digest");
    const platform = new IntegrationPlatformStore(storeFixture.database);
    const reviewed = preparedDevice();
    const opened = await platform.integrationRequests.createIntegrationAccessRequest({
      originatingRunId: fixture.runId,
      originatingThreadId: fixture.threadId,
      requestedBy: fixture.userId,
      callId: "device-digest",
      access: "read",
      installationId: null,
      manifest: reviewed.approvalManifest,
      reason: "Read Calendar",
      requestedConnectionId: null,
      requestedServerId: null,
    });
    const changed = structuredClone(reviewed);
    changed.material.installation.provenance = {
      ...changed.material.installation.provenance,
      definitionDigest: "x".repeat(43),
    };
    await expect(
      platform.integrationRequests.installForIntegrationAccessRequest({
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        preparedFulfillment: changed,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await platform.requests.get(opened.request.id)).toMatchObject({ status: "pending" });
    expect(await platform.listInstallations()).toEqual([]);
    const installed = await platform.integrationRequests.installForIntegrationAccessRequest({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      preparedFulfillment: reviewed,
    });
    expect(installed.request).toMatchObject({
      status: "pending",
      payload: { installationId: reviewed.material.installation.id },
    });
    expect(await platform.listGrants({ ownerUserId: fixture.userId })).toEqual([]);
    expect(
      await storeFixture.database
        .selectFrom("requestContinuations")
        .selectAll()
        .where("requestId", "=", opened.request.id)
        .execute(),
    ).toEqual([]);
  });

  it("declines an uninstalled device app without installing it", async ({ storeFixture }) => {
    const fixture = await storeFixture.startRunFixture("decline-uninstalled-device");
    const platform = new IntegrationPlatformStore(storeFixture.database);
    const opened = await platform.integrationRequests.createIntegrationAccessRequest({
      originatingRunId: fixture.runId,
      originatingThreadId: fixture.threadId,
      requestedBy: fixture.userId,
      callId: "decline-uninstalled-device",
      access: "read",
      installationId: null,
      manifest: preparedDevice().approvalManifest,
      reason: "Read Calendar",
      requestedConnectionId: null,
      requestedServerId: null,
    });
    await platform.integrationRequests.resolveIntegrationAccessRequest({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: { kind: "external", value: { decision: "declined" } },
    });
    expect(await platform.requests.get(opened.request.id)).toMatchObject({ status: "declined" });
    expect(await platform.listInstallations()).toEqual([]);
  });

  it("binds an already installed exact device definition without installing it again", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.startRunFixture("bind-installed-device");
    const platform = new IntegrationPlatformStore(storeFixture.database);
    const prepared = preparedDevice();
    await platform.install({
      ...prepared.material,
      actorUserId: fixture.userId,
      requestId: "device-first-install",
    });
    const opened = await platform.integrationRequests.createIntegrationAccessRequest({
      originatingRunId: fixture.runId,
      originatingThreadId: fixture.threadId,
      requestedBy: fixture.userId,
      callId: "bind-installed-device",
      access: "read",
      installationId: null,
      manifest: prepared.approvalManifest,
      reason: "Read Calendar",
      requestedConnectionId: null,
      requestedServerId: null,
    });
    const bound = await platform.integrationRequests.tryBindExistingIntegrationAccessInstallation({
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
    });
    expect(bound?.request).toMatchObject({
      status: "pending",
      payload: { installationId: prepared.material.installation.id },
    });
    expect(await platform.listInstallations()).toHaveLength(1);
    expect(await platform.listGrants({ ownerUserId: fixture.userId })).toEqual([]);
  });

  for (const local of [false, true]) {
    it(`settles concurrent ${local ? "local-server" : "device app"} fulfilments exactly once`, async ({
      storeFixture,
    }) => {
      const fixture = await storeFixture.startRunFixture(`access-race-${local}`);
      const { database } = storeFixture;
      const platform = new IntegrationPlatformStore(database);
      const deviceMaterial = preparedDevice().material;
      const server = local
        ? {
            ...deviceMaterial.servers[0]!,
            connectionRequirement: { kind: "none" as const },
            transport: {
              type: "runner" as const,
              runnerId: null,
              launch: { type: "stdio" as const, command: "node", args: [], env: {}, cwd: "/tmp" },
            },
          }
        : deviceMaterial.servers[0]!;
      const otherServer = { ...server, id: createIntegrationId("server"), name: "other" };
      const material = {
        ...deviceMaterial,
        installation: local
          ? { ...deviceMaterial.installation, manifest: {}, provenance: {} }
          : deviceMaterial.installation,
        servers: local ? [server, otherServer] : [server],
      };
      await platform.install({
        ...material,
        actorUserId: fixture.userId,
        requestId: "race-install",
      });
      const connectionId = local ? null : createIntegrationId("connection");
      const otherConnectionId = local ? null : createIntegrationId("connection");
      for (const candidate of [connectionId, otherConnectionId])
        if (candidate)
          await sql`insert into integration_connections
        (id,owner_user_id,connection_kind,provider,connection_method,status,display_name,capabilities,integration_definition_id,integration_server_id,device_id,computer_access)
        values(${candidate},${fixture.userId},'computer','apple-calendar','computer','connected','Calendar','[]','apple-calendar',${server.id},${await calendarDevice(database, fixture.runnerId, fixture.userId)},'read-write')`.execute(
            database,
          );
      const opened = await platform.integrationRequests.createIntegrationAccessRequest({
        originatingRunId: fixture.runId,
        originatingThreadId: fixture.threadId,
        requestedBy: fixture.userId,
        callId: "access-race",
        access: "read",
        installationId: material.installation.id,
        reason: "Read records",
        requestedConnectionId: connectionId,
        requestedServerId: server.id,
      });
      const other = await platform.integrationRequests.createIntegrationAccessRequest({
        originatingRunId: fixture.runId,
        originatingThreadId: fixture.threadId,
        requestedBy: fixture.userId,
        callId: "other-access",
        access: "read",
        installationId: material.installation.id,
        reason: "Read another source",
        requestedConnectionId: otherConnectionId,
        requestedServerId: local ? otherServer.id : server.id,
      });
      if (!local)
        await expect(
          platform.integrationRequests.resolveIntegrationAccessRequest({
            requestId: opened.request.id,
            resolvedBy: fixture.userId,
            response: {
              kind: "external",
              value: {
                decision: "fulfilled",
                connectionId: otherConnectionId,
                access: "read-write",
                alias: "Wrong computer",
                isDefault: false,
              },
            },
          }),
        ).rejects.toMatchObject({
          code: "forbidden",
          message: "Integration access requires the requested account",
        });
      const resolve = () =>
        platform.integrationRequests.resolveIntegrationAccessRequest({
          requestId: opened.request.id,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: {
              decision: "fulfilled",
              connectionId,
              access: "read-write",
              alias: "Records",
              isDefault: false,
            },
          },
        });
      const results = await Promise.allSettled([resolve(), resolve()]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ reason: { code: "conflict" } });
      expect(await platform.requests.get(opened.request.id)).toMatchObject({ status: "fulfilled" });
      expect(await platform.requests.get(other.request.id)).toMatchObject({ status: "pending" });
      if (local)
        await storeFixture.database
          .updateTable("integrationServers")
          .set({ status: "disabled" })
          .where("id", "=", otherServer.id)
          .execute();
      else
        await storeFixture.database
          .updateTable("integrationConnections")
          .set({ status: "paused" })
          .where("id", "=", otherConnectionId!)
          .execute();
      await platform.integrationRequests.resolveIntegrationAccessRequest({
        requestId: other.request.id,
        resolvedBy: fixture.userId,
        response: { kind: "external", value: { decision: "declined" } },
      });
      expect(await platform.requests.get(other.request.id)).toMatchObject({ status: "declined" });

      expect(await platform.listGrants({ ownerUserId: fixture.userId })).toHaveLength(1);
      expect(
        await database
          .selectFrom("requestContinuations")
          .selectAll()
          .where("requestId", "=", opened.request.id)
          .execute(),
      ).toHaveLength(1);
    });
  }

  it("switches a device app's default grant without leaving two defaults", async ({
    storeFixture,
  }) => {
    const fixture = await storeFixture.startRunFixture("device-default");
    const { database } = storeFixture;
    const platform = new IntegrationPlatformStore(database);
    const material = preparedDevice().material;
    await platform.install({
      ...material,
      actorUserId: fixture.userId,
      requestId: "default-install",
    });
    const connections = [createIntegrationId("connection"), createIntegrationId("connection")];
    for (const connectionId of connections) {
      await sql`insert into integration_connections
        (id,owner_user_id,connection_kind,provider,connection_method,status,display_name,capabilities,integration_definition_id,integration_server_id,device_id,computer_access)
        values(${connectionId},${fixture.userId},'computer','apple-calendar','computer','connected','Calendar','[]','apple-calendar',${material.servers[0]!.id},${await calendarDevice(database, fixture.runnerId, fixture.userId)},'read-write')`.execute(
        database,
      );
      await platform.createGrant({
        access: "read",
        alias: "Calendar",
        connectionId,
        createdBy: fixture.userId,
        ownerUserId: fixture.userId,
        installationId: material.installation.id,
        isDefault: false,
      });
    }
    for (const connectionId of connections) {
      await platform.createGrant({
        access: "read",
        alias: "Calendar",
        connectionId,
        createdBy: fixture.userId,
        ownerUserId: fixture.userId,
        installationId: material.installation.id,
        isDefault: true,
      });
      expect(
        (await platform.listGrants({ ownerUserId: fixture.userId }))
          .filter(({ isDefault }) => isDefault)
          .map(({ connectionId }) => connectionId),
      ).toEqual([connectionId]);
    }
  });
});
