import { sql } from "kysely";
import { expect } from "vitest";
import { AgentConnectionStore } from "./agent-connection-store.js";
import { migrateToLatest } from "./migrations.js";
import { removePlatformVerificationMigrationName } from "./platform-verification-removal-migration.js";
import { describeStore } from "./store.integration.test-support.js";

const recordedAt = "2026-11-20T12:00:00.000Z";
const issuer = "https://accounts.example.test";

describeStore("a connection verified through a platform reads as verified by its origin", (it) => {
  it("keeps the origin it was verified by, and forgets the embedder, its keys and its claims", async ({
    storeFixture,
  }) => {
    const { database } = storeFixture;
    const { fixture } = await storeFixture.createChannelDeliveryFixture("former-platform");
    // The release before this one: the claims table, a consent verified through a platform, and a
    // cached directory whose entries carry keys and pairings.
    await sql`
      create table agent_embedder_assertion_claims (
        issuer text not null,
        statement_id text not null,
        expires_at timestamptz not null,
        primary key (issuer, statement_id)
      );
      insert into agent_embedder_assertion_claims values ('https://errand.example', 'jti-1', now());
    `.execute(database);
    await sql`delete from kysely_migration where name = ${removePlatformVerificationMigrationName}`.execute(
      database,
    );
    const connections = new AgentConnectionStore(database);
    const agent = await connections.create({
      userId: fixture.userId,
      label: "Errand",
      clientName: "Errand",
      accessMode: "approval-required",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    const direct = await connections.create({
      userId: fixture.userId,
      label: "AgentPay",
      clientName: "AgentPay",
      accessMode: "approval-required",
      resource: "http://localhost/mcp",
      expiresAt: new Date(Date.now() + 60 * 60_000),
      grant: { scope: "selected", tasks: false, resources: [] },
    });
    await sql`
      update agent_connections set identity_at_consent = ${JSON.stringify({
        kind: "platform-and-embedder",
        platformOrigin: "https://agentpay.example",
        platformDirectoryId: "agentpay",
        platformName: "AgentPay",
        embedderOrigin: "https://errand.example",
        embedderDirectoryId: "errand",
        embedderName: "Errand",
        keyThumbprint: "a".repeat(43),
        directoryRevision: 3,
        recordedAt,
      })}::jsonb where id = ${agent.id}
    `.execute(database);
    await sql`
      update agent_connections set identity_at_consent = ${JSON.stringify({
        kind: "platform",
        platformOrigin: "https://agentpay.example",
        platformDirectoryId: "agentpay",
        platformName: "AgentPay",
        directoryRevision: 3,
        recordedAt,
      })}::jsonb where id = ${direct.id}
    `.execute(database);
    await sql`
      insert into agent_directory_cache (issuer, document, accepted_at) values (${issuer}, ${JSON.stringify(
        {
          revision: 3,
          issuedAt: recordedAt,
          entries: [
            { id: "agentpay", displayName: "AgentPay", origins: ["https://agentpay.example"] },
            {
              id: "errand",
              displayName: "Errand",
              origins: ["https://errand.example"],
              keys: { keys: [{ kty: "OKP", crv: "Ed25519", x: "a".repeat(43), kid: "k" }] },
              embedsVia: ["agentpay"],
            },
          ],
        },
      )}::jsonb, now())
    `.execute(database);

    await migrateToLatest(database);

    const { rows } = await sql<{ table: string | null }>`
      select to_regclass('agent_embedder_assertion_claims')::text as table`.execute(database);
    expect(rows[0]?.table).toBeNull();
    const listed = await connections.list(fixture.userId);
    const byId = new Map(listed.map((connection) => [connection.id, connection]));
    const expected = {
      kind: "verified",
      origin: "https://agentpay.example",
      directoryId: "agentpay",
      displayName: "AgentPay",
      directoryRevision: 3,
      recordedAt,
    };
    expect(byId.get(agent.id)?.identityAtConsent).toEqual(expected);
    expect(byId.get(direct.id)?.identityAtConsent).toEqual(expected);
    // The cached directory reads again, each entry a name and its origins.
    expect(await connections.loadDirectory(issuer)).toEqual({
      revision: 3,
      issuedAt: recordedAt,
      entries: [
        { id: "agentpay", displayName: "AgentPay", origins: ["https://agentpay.example"] },
        { id: "errand", displayName: "Errand", origins: ["https://errand.example"] },
      ],
    });
  });
});
