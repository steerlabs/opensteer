import type { AccountProfile } from "@opensteer/control-plane-protocol";
import { createId, type PersonName, type UserId } from "@opensteer/core";
import type { OwnerNameLink, OwnerProfile, OwnerProfileStore } from "@opensteer/database";
import { expect, it } from "vitest";
import { OwnerProfileService, type OwnerProfileAccount } from "./owner-profile.js";

const ownerId = createId("user") as UserId;
const name = (value: string) => value as PersonName;
const linkA: OwnerNameLink = {
  issuer: "https://account.example",
  subject: "acct_ada",
  linkGeneration: "a",
};
const linkB: OwnerNameLink = { ...linkA, subject: "acct_bea", linkGeneration: "b" };

/**
 * The store's own rules (forward only, a new Account wins, answers apply only through the live
 * link) are its integration test's subject; this keeps just enough of them to drive the service.
 */
function memoryStore(initial: OwnerProfile, link: OwnerNameLink | null) {
  let profile = initial;
  const state = { link };
  const store = {
    read: async () => profile,
    setLocal: async (input: { name: PersonName | null }) => {
      if (profile.account) throw new Error("bound to an Account");
      profile = { ...profile, name: input.name };
      return profile;
    },
    applyAccount: async (input: { account: OwnerNameLink; name: PersonName; revision: number }) => {
      if (input.account.linkGeneration !== state.link?.linkGeneration)
        return { changed: false, stale: true, profile };
      const same = profile.account?.subject === input.account.subject;
      if (same && profile.account!.revision >= input.revision)
        return { changed: false, stale: false, profile };
      profile = {
        ...profile,
        name: input.name,
        account: { ...input.account, revision: input.revision },
      };
      return { changed: true, stale: false, profile };
    },
    detachAccount: async () => {
      if (state.link) return false;
      const had = profile.account !== null;
      profile = { ...profile, account: null };
      return had;
    },
    seed: async () => false,
  };
  return { store: store as unknown as OwnerProfileStore, current: () => profile, state };
}

function accountProfile(value: string, revision: number): AccountProfile {
  return { name: name(value), revision, receipt: "receipt" as AccountProfile["receipt"] };
}

function service(store: OwnerProfileStore, linked: OwnerProfileAccount | null) {
  let changes = 0;
  const owner = new OwnerProfileService({
    store,
    account: linked,
    changed: () => changes++,
    report: () => undefined,
  });
  return { owner, changes: () => changes };
}

it("keeps a name on this computer while no Account is linked, including clearing it", async () => {
  const memory = memoryStore({ ownerId, name: name("Ada"), account: null }, null);
  const { owner, changes } = service(memory.store, null);
  expect(await owner.update(ownerId, null, null)).toEqual({
    applied: true,
    profile: { name: null, accountBacked: false, revision: null },
  });
  expect(changes()).toBe(1);
  await expect(owner.update(createId("user") as UserId, name("Mallory"), null)).rejects.toThrow(
    /personal owner/,
  );
});

it("saves to the linked Account first, against the version the person was editing", async () => {
  const memory = memoryStore({ ownerId, name: name("Ada"), account: null }, linkA);
  const requests: unknown[] = [];
  let remote = accountProfile("Ada", 3);
  const linked: OwnerProfileAccount = {
    readOwnerProfile: async () => ({ account: linkA, profile: remote }),
    updateOwnerProfile: async (request) => {
      requests.push(request);
      const applied = request.expectedRevision === remote.revision;
      if (applied) remote = accountProfile(request.name, remote.revision + 1);
      return { account: linkA, applied, profile: remote };
    },
  };
  const { owner } = service(memory.store, linked);
  // The person edited their own name, and the Host has linked since: start from the Account's.
  expect(await owner.update(ownerId, name("Ada L."), null)).toEqual({
    applied: true,
    profile: { name: "Ada L.", accountBacked: true, revision: 4 },
  });
  // They began editing at revision 4; another device saved 5 meanwhile, and this Host caught up.
  remote = accountProfile("Ada from phone", 5);
  await owner.refresh();
  expect(await owner.update(ownerId, name("Stale draft"), 4)).toEqual({
    applied: false,
    profile: { name: "Ada from phone", accountBacked: true, revision: 5 },
  });
  expect(requests).toEqual([
    { name: "Ada L.", expectedRevision: 3 },
    { name: "Stale draft", expectedRevision: 4 },
  ]);
  // An Account always has a name: clearing it is refused rather than half-applied.
  await expect(owner.update(ownerId, null, 5)).rejects.toMatchObject({ code: "bad_request" });
});

it("never lets an answer read through an old link change the name", async () => {
  const memory = memoryStore(
    { ownerId, name: name("Ada"), account: { ...linkA, revision: 3 } },
    linkA,
  );
  let answer: (value: { account: OwnerNameLink; profile: AccountProfile } | null) => void = () =>
    undefined;
  let reads = 0;
  const linked: OwnerProfileAccount = {
    readOwnerProfile: () => {
      reads++;
      return reads === 1
        ? new Promise((resolve) => {
            answer = resolve;
          })
        : Promise.resolve(
            memory.state.link
              ? { account: memory.state.link, profile: accountProfile("Bea", 1) }
              : null,
          );
    },
    updateOwnerProfile: async () => ({
      account: linkA,
      applied: true,
      profile: accountProfile("Ada saved late", 4),
    }),
  };
  const { owner } = service(memory.store, linked);
  const reading = owner.refresh();
  // The link moves to another Account while that read is in flight.
  memory.state.link = linkB;
  const relinked = owner.refresh();
  answer({ account: linkA, profile: accountProfile("Ada late", 9) });
  await Promise.all([reading, relinked]);
  expect(reads).toBe(2);
  expect(memory.current()).toMatchObject({ name: "Bea", account: { subject: "acct_bea" } });
  // A save answered by the old link is refused, never applied over the new Account's name.
  await expect(owner.update(ownerId, name("Ada"), 1)).rejects.toMatchObject({ code: "conflict" });
  expect(memory.current().name).toBe("Bea");
});

it("keeps the name and drops the Account when the link ends, then saves it here", async () => {
  const memory = memoryStore(
    { ownerId, name: name("Ada"), account: { ...linkA, revision: 3 } },
    null,
  );
  const linked: OwnerProfileAccount = {
    readOwnerProfile: async () => null,
    updateOwnerProfile: async () => null,
  };
  const { owner, changes } = service(memory.store, linked);
  await owner.refresh();
  expect(memory.current()).toMatchObject({ name: "Ada", account: null });
  expect(changes()).toBe(1);
  expect(await owner.update(ownerId, name("Ada Local"), null)).toEqual({
    applied: true,
    profile: { name: "Ada Local", accountBacked: false, revision: null },
  });
});
