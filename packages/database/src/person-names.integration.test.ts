import { createId, type PersonName } from "@opensteer/core";
import { sql } from "kysely";
import { afterEach, expect, it } from "vitest";
import { createDatabase } from "./connection.js";
import { OwnerProfileStore } from "./owner-profile-store.js";
import { seedPersonalFixture } from "./personal-fixture.test-support.js";
import { TeamAccessStore } from "./team-access-store.js";
import { createTeamFixture } from "./team-fixture.test-support.js";
import { TeamMembersStore } from "./team-members-store.js";
import { cloneTestDatabase, ownTestDatabaseProducer } from "./test-database.test-support.js";

const drops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const drop of drops.splice(0)) await drop();
});

async function personal() {
  const clone = await cloneTestDatabase("host");
  drops.push(clone.drop);
  const { database } = await ownTestDatabaseProducer(clone.url, async () => {
    const database = createDatabase({ connectionString: clone.url });
    return { database, close: () => database.destroy() };
  });
  const fixture = await seedPersonalFixture(database, "/opensteer-names-test");
  const store = new OwnerProfileStore(database);
  // An owner who signed up starts with the name they gave.
  expect((await store.read())?.name).toBe("Alex");
  // The desktop's implicit owner has none until anyone sets one.
  await database
    .updateTable("personalSettings")
    .set({ ownerName: null, ownerNameSetAt: null })
    .execute();
  return { database, store, userId: fixture.userId };
}

async function shownNames(
  database: Awaited<ReturnType<typeof personal>>["database"],
  userId: string,
) {
  const user = await database
    .selectFrom("users")
    .select("displayName")
    .where("id", "=", userId as never)
    .executeTakeFirstOrThrow();
  const principal = await database
    .selectFrom("principals")
    .select("displayName")
    .where("kind", "=", "user")
    .where("userId", "=", userId as never)
    .executeTakeFirstOrThrow();
  return [user.displayName, principal.displayName];
}

const name = (value: string) => value as PersonName;
const accountA = {
  issuer: "https://accounts.example.invalid",
  subject: "acct_a",
  linkGeneration: "generation-a",
};
const accountB = { ...accountA, subject: "acct_b", linkGeneration: "generation-b" };

/** The Host's Account link as remote access keeps it; null unlinks. */
async function link(
  database: Awaited<ReturnType<typeof personal>>["database"],
  account: typeof accountA | null,
) {
  await database.deleteFrom("personalRemoteAccountLink").execute();
  if (account)
    await sql`insert into personal_remote_account_link(singleton_key,challenge_id,grant_id,issuer,host_credential,link_generation,state,subject) values('opensteer-account','challenge','grant',${account.issuer},'credential',${account.linkGeneration},'active',${account.subject})`.execute(
      database,
    );
}

it("takes the computer's name once and never renames someone who chose or cleared theirs", async () => {
  const { database, store, userId } = await personal();
  expect(await store.seed("  Ada\tLovelace ")).toBe(true);
  expect((await store.read())?.name).toBe("Ada Lovelace");
  // Older readers (input authors, sign-in sessions) see the same name in the same transaction.
  expect(await shownNames(database, userId)).toEqual(["Ada Lovelace", "Ada Lovelace"]);

  await store.setLocal({ userId, name: null });
  expect(await store.read()).toMatchObject({ name: null, account: null });
  expect(await shownNames(database, userId)).toEqual(["You", "You"]);
  expect(await store.seed("Ada Lovelace")).toBe(false);
  expect((await store.read())?.name).toBeNull();
  await expect(store.setLocal({ userId: createId("user"), name: name("Mallory") })).rejects.toThrow(
    /personal owner/,
  );
});

it("follows the live link's Account forward only, and keeps the last name when it ends", async () => {
  const { database, store, userId } = await personal();
  const apply = (account: typeof accountA, value: string, revision: number) =>
    store.applyAccount({ account, name: name(value), revision });
  // An answer read through a link that is not live applies nothing.
  expect(await apply(accountA, "Ada", 3)).toMatchObject({ stale: true, profile: { name: null } });
  await link(database, accountA);
  expect(await apply(accountA, "Ada", 3)).toMatchObject({
    changed: true,
    profile: { name: "Ada", account: { subject: "acct_a", revision: 3 } },
  });
  // A late or repeated answer never moves the name backwards.
  expect(await apply(accountA, "Old Ada", 2)).toMatchObject({
    changed: false,
    stale: false,
    profile: { name: "Ada" },
  });
  // While an Account owns the name, only the Account can change it.
  await expect(store.setLocal({ userId, name: name("Local") })).rejects.toThrow(/Account/);
  // Relinked to another Account: the old link's late answers no longer apply, and the new
  // Account's name wins whatever its revision.
  await link(database, accountB);
  expect(await apply(accountA, "Ada late", 9)).toMatchObject({
    stale: true,
    profile: { name: "Ada" },
  });
  expect(await apply(accountB, "Bea", 1)).toMatchObject({
    changed: true,
    profile: { name: "Bea", account: { subject: "acct_b", revision: 1 } },
  });
  expect(await shownNames(database, userId)).toEqual(["Bea", "Bea"]);

  // Detaching waits for the link to end, so a late "unlinked" answer cannot unbind a relink.
  expect(await store.detachAccount()).toBe(false);
  await link(database, null);
  expect(await store.detachAccount()).toBe(true);
  expect(await store.read()).toMatchObject({ name: "Bea", account: null });
  expect(await store.detachAccount()).toBe(false);
  await store.setLocal({ userId, name: name("Bea Local") });
  expect((await store.read())?.name).toBe("Bea Local");
  // An adopted name counts as chosen: the computer's name never replaces it.
  expect(await store.seed("Someone Else")).toBe(false);
});

it("applies a member's Account name only to that Account's user, only forward, without an access change", async () => {
  const fixture = await createTeamFixture();
  drops.push(fixture.close);
  const { database, userId } = fixture;
  const issuer = "https://accounts.example.invalid";
  await sql`insert into account_directory_provider(singleton_key,provider_id,issuer) values('opensteer-account','oidc.account',${issuer})`.execute(
    database,
  );
  await sql`insert into auth_accounts(id,account_id,provider_id,user_id) values(${createId("authAccount")},'acct_maya','oidc.account',${userId})`.execute(
    database,
  );
  const access = new TeamAccessStore(database);
  const members = new TeamMembersStore(access);
  const accessRevision = async () =>
    await database
      .selectFrom("teamAccessState")
      .select(["revision", "directoryRevision"])
      .executeTakeFirstOrThrow();
  const before = await accessRevision();

  const apply = (subject: string, revision: number, value: string, iss = issuer) =>
    members.applyAccountName({ userId, issuer: iss, subject, name: name(value), revision });
  expect(await apply("acct_someone_else", 5, "Mallory")).toBeNull();
  expect(await apply("acct_maya", 5, "Mallory", "https://evil.example.invalid")).toBeNull();
  expect(await apply("acct_maya", 2, "Maya Chen")).toMatchObject({
    member: { userId, displayName: "Maya Chen", handle: "maya", nameRevision: 2 },
  });
  expect(await apply("acct_maya", 2, "Again")).toBeNull();
  expect(await apply("acct_maya", 1, "Maya")).toBeNull();
  expect(await members.get({ kind: "human", userId })).toMatchObject({
    displayName: "Maya Chen",
    handle: "maya",
    nameRevision: 2,
  });
  expect(await accessRevision()).toEqual(before);
});
