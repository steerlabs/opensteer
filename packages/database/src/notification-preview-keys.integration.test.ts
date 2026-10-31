import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { NotificationPreviewKeyStore } from "./notification-preview-key-store.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";
import { createDatabase } from "./connection.js";
import { OpensteerStore } from "./store.js";
import { AccountDirectoryStore } from "./account-directory-store.js";

// Skip outside the integration launcher, which supplies an isolated PostgreSQL clone.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;
integration("session-bound notification preview keys", () => {
  async function fixture() {
    const clone = await cloneTestDatabase("host");
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url, maxConnections: 4 });
      return { database, close: () => database.destroy() };
    });
    const store = new OpensteerStore(database);
    const userId = await store.createUser("Person");
    const issuer = "https://accounts.preview.invalid";
    await new AccountDirectoryStore(database).configureProvider({
      issuer,
      providerId: "preview-account",
    });
    const accountId = `acct_${crypto.randomUUID()}`;
    let now = new Date();
    await database
      .insertInto("authAccounts")
      .values({
        id: createId("authAccount"),
        userId,
        accountId,
        providerId: "preview-account",
        password: null,
        accessToken: null,
        refreshToken: null,
        idToken: null,
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        scope: null,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    async function session() {
      const id = createId("authSession");
      await database
        .insertInto("authSessions")
        .values({
          id,
          userId,
          token: randomBytes(32).toString("base64url"),
          createdAt: now,
          updatedAt: now,
          lastSeenAt: now,
          deviceLabel: "Test",
          ipAddress: null,
          userAgent: null,
          expiresAt: new Date(now.getTime() + 3600000),
          absoluteExpiresAt: new Date(now.getTime() + 7200000),
        })
        .execute();
      return id;
    }
    const authSessionId = await session();
    const keyStore = new NotificationPreviewKeyStore(database, () => now);
    async function register(
      input: {
        userId: typeof userId;
        authSessionId: typeof authSessionId;
        accountId: string;
        installationId: string;
        keyId: string;
        key: string;
      },
      configuredIssuer = issuer,
    ) {
      await keyStore.register({
        ...input,
        issuer: configuredIssuer,
        encryptedKey: Buffer.from(input.key),
        encryptionKeyVersion: 1,
        matchesExisting: async (row) => row.encryptedKey.equals(Buffer.from(input.key)),
      });
    }
    const input = {
      userId,
      authSessionId,
      accountId,
      installationId: randomBytes(18).toString("base64url"),
      keyId: randomBytes(16).toString("base64url"),
      key: randomBytes(32).toString("base64url"),
    };
    return {
      database,
      keyStore,
      register,
      input,
      session,
      issuer,
      advance: (milliseconds: number) => {
        now = new Date(now.getTime() + milliseconds);
      },
    };
  }

  it("is idempotent and fences stale unregister and other logins", async () => {
    const f = await fixture();
    await f.register(f.input);
    await f.register(f.input);
    const row = await f.database
      .selectFrom("notificationPreviewKeys")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(row.authSessionId).toBe(f.input.authSessionId);
    expect(await f.keyStore.eligible(f.input.userId, [f.input.accountId])).toHaveLength(1);
    await expect(
      f.register({ ...f.input, key: randomBytes(32).toString("base64url") }),
    ).rejects.toMatchObject({ code: "conflict", reason: "notification-preview-key-conflict" });
    const second = await f.session();
    await expect(f.register({ ...f.input, authSessionId: second })).rejects.toMatchObject({
      code: "conflict",
    });
    const fresh = {
      ...f.input,
      authSessionId: second,
      keyId: randomBytes(16).toString("base64url"),
    };
    await f.register(fresh);
    await f.keyStore.unregister(f.input);
    await f.database.deleteFrom("authSessions").where("id", "=", f.input.authSessionId).execute();
    expect(await f.keyStore.eligible(f.input.userId, [f.input.accountId])).toHaveLength(1);
    await f.database.deleteFrom("authSessions").where("id", "=", second).execute();
    expect(await f.database.selectFrom("notificationPreviewKeys").selectAll().execute()).toEqual(
      [],
    );
  });

  it("checks issuer and subject without Workspace membership and rolls back refusals", async () => {
    const f = await fixture();
    await expect(
      f.register({ ...f.input, accountId: `acct_${crypto.randomUUID()}` }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(f.register(f.input, "https://other.invalid")).rejects.toMatchObject({
      code: "forbidden",
    });
    expect(await f.database.selectFrom("notificationPreviewKeys").selectAll().execute()).toEqual(
      [],
    );
    await f.register(f.input);
    expect(await f.keyStore.eligible(f.input.userId, [f.input.accountId])).toHaveLength(1);
    expect(await f.keyStore.eligible(f.input.userId, [`acct_${crypto.randomUUID()}`])).toEqual([]);
  });

  it("bounds concurrent installations and prunes expired sessions before counting", async () => {
    const f = await fixture();
    for (let i = 0; i < 15; i++)
      await f.register({
        ...f.input,
        installationId: `installation-${String(i).padStart(4, "0")}`,
      });
    const contenders = await Promise.allSettled(
      ["installation-0015", "installation-0016"].map((installationId) =>
        f.register({ ...f.input, installationId }),
      ),
    );
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = contenders.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "conflict", reason: "notification-preview-device-limit" },
    });
    f.advance(3600000);
    const second = await f.session();
    await f.register({ ...f.input, authSessionId: second });
    expect(
      await f.database.selectFrom("notificationPreviewKeys").selectAll().execute(),
    ).toHaveLength(1);
  });

  it("serializes registration against session deletion without retaining a key", async () => {
    const f = await fixture();
    await f.register(f.input);
    const outcomes = await Promise.allSettled([
      f.register({ ...f.input, keyId: randomBytes(16).toString("base64url") }),
      f.database.deleteFrom("authSessions").where("id", "=", f.input.authSessionId).execute(),
    ]);
    expect(outcomes[1]!.status).toBe("fulfilled");
    if (outcomes[0]!.status === "rejected")
      expect(outcomes[0]).toMatchObject({ reason: { code: "forbidden" } });
    expect(await f.database.selectFrom("notificationPreviewKeys").selectAll().execute()).toEqual(
      [],
    );
  });

  it("refuses disabled and expired sessions", async () => {
    const f = await fixture();
    await f.register(f.input);
    await f.database
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", f.input.userId)
      .execute();
    expect(await f.keyStore.eligible(f.input.userId, [f.input.accountId])).toEqual([]);
    await expect(f.register(f.input)).rejects.toMatchObject({ code: "forbidden" });
    await f.database
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", f.input.userId)
      .execute();
    f.advance(7200000);
    expect(await f.keyStore.eligible(f.input.userId, [f.input.accountId])).toEqual([]);
    await expect(f.register(f.input)).rejects.toMatchObject({ code: "forbidden" });
  });
});
