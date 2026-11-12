import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { sql } from "kysely";
import { expect } from "vitest";
import { IntegrationPlatformStore } from "./integration-platform-store.js";
import { IntegrationStore } from "./integration-store.js";
import { describeStore } from "./store.integration.test-support.js";

describeStore("Personal integration account edits", (it) => {
  it("switches the default and disconnects accounts with ordered grant writes", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { userId } = await storeFixture.startRunFixture("default-account");
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    await sql`insert into integration_installations(id,name,title,description,source_kind,trust,manifest,provenance,status,revision)
      values(${installationId},'records','Records','','remote-mcp','administrator-approved','{}','{}','active',1)`.execute(
      database,
    );
    await sql`insert into integration_servers(id,installation_id,name,transport,connection_requirement,status,tool_generation)
      values(${serverId},${installationId},'records','{"type":"streamable-http","url":"https://records.example/mcp","headers":{}}',
      '{"kind":"provider","definitionId":"records","provider":"records","providerApplicationRequired":false}','active',1)`.execute(
      database,
    );
    const accounts = [createIntegrationId("connection"), createIntegrationId("connection")];
    const platform = new IntegrationPlatformStore(database);
    for (const connectionId of accounts) {
      await sql`insert into integration_connections(id,owner_user_id,connection_kind,provider,connection_method,status,display_name,capabilities,granted_scopes,integration_definition_id)
        values(${connectionId},${userId},'provider-account','records','api-key','connected','Records','[]','[]','records')`.execute(
        database,
      );
      await platform.createGrant({
        access: "read",
        alias: "Records",
        connectionId,
        createdBy: userId,
        installationId,
        isDefault: false,
        ownerUserId: userId,
        providerAuthorizations: {},
      });
    }
    for (const connectionId of accounts) {
      await platform.createGrant({
        access: "read",
        alias: "Records",
        connectionId,
        createdBy: userId,
        installationId,
        isDefault: true,
        ownerUserId: userId,
        providerAuthorizations: {},
      });
      expect(
        (await platform.listGrants({ ownerUserId: userId }))
          .filter((grant) => grant.isDefault)
          .map((grant) => grant.connectionId),
      ).toEqual([connectionId]);
    }
    const credentialId = createId("credential");
    const connectionId = accounts[0]!;
    await sql`insert into credentials(id,owner_id,name,provider,encrypted_payload,encryption_key_version,metadata)
      values(${credentialId},${userId},'Records','records',${Buffer.from("sealed")},1,'{}')`.execute(
      database,
    );
    await database
      .updateTable("integrationConnections")
      .set({ credentialId })
      .where("id", "=", connectionId)
      .execute();
    await new IntegrationStore(database).revokeConnection({
      connectionId,
      credential: { envelope: Buffer.from("revoked"), keyVersion: 1 },
      ownerUserId: userId,
      requestId: "disconnect-with-grant",
    });
    expect(
      await database
        .selectFrom("integrationGrants")
        .select(["status", "isDefault"])
        .where("connectionId", "=", connectionId)
        .execute(),
    ).toEqual([{ status: "revoked", isDefault: false }]);
  });
});
