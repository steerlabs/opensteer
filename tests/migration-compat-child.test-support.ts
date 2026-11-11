import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
const [root, phase, , url] = z
  .tuple([
    z.string().min(1),
    z.enum(["seed", "migrate", "replay"]),
    z.literal("controlPlane"),
    z.url(),
  ])
  .parse(process.argv.slice(2));
const load = (name: string) => import(pathToFileURL(join(root, name)).href);
async function main(): Promise<void> {
  const {
    createControlPlaneDatabase,
  }: typeof import("../apps/control-plane/src/database/database.js") = await load(
    "apps/control-plane/src/database/database.ts",
  );
  const database = createControlPlaneDatabase({ connectionString: url!, maxConnections: 1 });
  try {
    if (phase === "migrate") {
      const {
        migrateControlPlaneToLatest,
      }: typeof import("../apps/control-plane/src/database/migrations.js") = await load(
        "apps/control-plane/src/database/migrations.ts",
      );
      await migrateControlPlaneToLatest(database);
    } else {
      const { ControlPlaneStore }: typeof import("../apps/control-plane/src/database/store.js") =
        await load("apps/control-plane/src/database/store.ts");
      // The fixture also runs the previous release against the migrated schema.
      const storeOptions = {
        portalOrigin: new URL("https://app.migration.invalid"),
        managedDeploymentDomain: "migration.invalid",
      };
      const store = new ControlPlaneStore(
        database,
        new URL("https://accounts.migration.invalid"),
        storeOptions,
      );
      const account: typeof import("../packages/control-plane-protocol/src/index.js") = await load(
        "packages/control-plane-protocol/src/index.ts",
      );
      const accountId = account.ControlPlaneAccountIdSchema.parse(
        "acct_00000000-0000-4000-8000-000000000001",
      );
      if (phase === "seed") {
        const now = new Date("2026-01-01T00:00:00Z");
        await database
          .insertInto("users")
          .values({
            id: accountId,
            displayName: "Migration Account",
            email: "owner@migration.invalid",
            emailVerified: true,
            image: null,
            createdAt: now,
            updatedAt: now,
          })
          .execute();
      } else {
        assert.equal(
          (
            await database
              .selectFrom("users")
              .select("id")
              .where("id", "=", accountId)
              .executeTakeFirstOrThrow()
          ).id,
          accountId,
        );
        await store.revokeAccountSessions(accountId);
      }
      // The previous store both inserts and updates its own persisted client.
      await store.ensureOfficialPortalClient({
        clientId: "migration-portal",
        redirectUri: "https://migration.invalid/callback",
        scopes: ["openid", "profile"],
      });
      const client = await database
        .selectFrom("oauthClients")
        .selectAll()
        .where("clientId", "=", "migration-portal")
        .executeTakeFirstOrThrow();
      assert.equal(client.clientId, "migration-portal");
      console.info("PREVIOUS_STORE_READ_WRITE_OK controlPlane");
    }
  } finally {
    await database.destroy();
  }
}
await main();
