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
  return { database, store: new OwnerProfileStore(database), userId: fixture.userId };
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
const accountA = { issuer: "https://accounts.example.invalid", subject: "acct_a" };
const accountB = { issuer: "https://accounts.example.invalid", subject: "acct_b" };

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

it("follows a linked Account forward only, and keeps the last name when the link ends", async () => {
  const { database, store, userId } = await personal();
  expect(
    await store.applyAccount({ account: accountA, name: name("Ada"), revision: 3 }),
  ).toMatchObject({
    changed: true,
    profile: { name: "Ada", account: { ...accountA, revision: 3 } },
  });
  // A late or repeated answer never moves the name backwards.
  expect(
    await store.applyAccount({ account: accountA, name: name("Old Ada"), revision: 2 }),
  ).toMatchObject({ changed: false, profile: { name: "Ada" } });
  // While an Account owns the name, only the Account can change it.
  await expect(store.setLocal({ userId, name: name("Local") })).rejects.toThrow(/Account/);
  // A different Account is a new link: its name wins whatever its revision.
  expect(
    await store.applyAccount({ account: accountB, name: name("Bea"), revision: 1 }),
  ).toMatchObject({
    changed: true,
    profile: { name: "Bea", account: { ...accountB, revision: 1 } },
  });
  expect(await shownNames(database, userId)).toEqual(["Bea", "Bea"]);

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
