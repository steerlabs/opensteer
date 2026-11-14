import type { AccountProfile } from "@opensteer/control-plane-protocol";
import { createId, type PersonName, type UserId } from "@opensteer/core";
import type { OwnerNameAccount, OwnerProfile, OwnerProfileStore } from "@opensteer/database";
import { expect, it } from "vitest";
import { OwnerProfileService, type OwnerProfileAccount } from "./owner-profile.js";

const ownerId = createId("user") as UserId;
const name = (value: string) => value as PersonName;
const account = { issuer: "https://account.example", subject: "acct_ada" };

/** The store's rules (forward only, new Account wins) are its own integration test's subject. */
function memoryStore(initial: OwnerProfile) {
  let profile = initial;
  const store = {
    read: async () => profile,
    setLocal: async (input: { name: PersonName | null }) => {
      if (profile.account) throw new Error("bound to an Account");
      profile = { ...profile, name: input.name };
      return profile;
    },
    applyAccount: async (input: {
      account: OwnerNameAccount;
      name: PersonName;
      revision: number;
    }) => {
      const same = profile.account?.subject === input.account.subject;
      if (same && profile.account!.revision >= input.revision) return { changed: false, profile };
      profile = {
        ...profile,
        name: input.name,
        account: { ...input.account, revision: input.revision },
      };
      return { changed: true, profile };
    },
    detachAccount: async () => {
      const had = profile.account !== null;
      profile = { ...profile, account: null };
      return had;
    },
    seed: async () => false,
  };
  return { store: store as unknown as OwnerProfileStore, current: () => profile };
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
  const memory = memoryStore({ ownerId, name: name("Ada"), account: null });
  const { owner, changes } = service(memory.store, null);
  expect(await owner.update(ownerId, null)).toEqual({
    applied: true,
    profile: { name: null, accountBacked: false },
  });
  expect(changes()).toBe(1);
  await expect(owner.update(createId("user") as UserId, name("Mallory"))).rejects.toThrow(
    /personal owner/,
  );
});

it("saves to the linked Account first, reading its revision when this Host has none", async () => {
  const memory = memoryStore({ ownerId, name: name("Ada"), account: null });
  const requests: unknown[] = [];
  const linked: OwnerProfileAccount = {
    readOwnerProfile: async () => ({ account, profile: accountProfile("Ada Lovelace", 3) }),
    updateOwnerProfile: async (request) => {
      requests.push(request);
      return { account, applied: true, profile: accountProfile(request.name, 4) };
    },
  };
  const { owner } = service(memory.store, linked);
  expect(await owner.update(ownerId, name("Ada L."))).toEqual({
    applied: true,
    profile: { name: "Ada L.", accountBacked: true },
  });
  expect(requests).toEqual([{ name: "Ada L.", expectedRevision: 3 }]);
  // An Account always has a name: clearing it is refused rather than half-applied.
  await expect(owner.update(ownerId, null)).rejects.toMatchObject({ code: "bad_request" });
  expect(memory.current().name).toBe("Ada L.");
});

it("shows a newer name saved elsewhere instead of overwriting it", async () => {
  const memory = memoryStore({ ownerId, name: name("Ada"), account: { ...account, revision: 3 } });
  const linked: OwnerProfileAccount = {
    readOwnerProfile: async () => null,
    updateOwnerProfile: async () => ({
      account,
      applied: false,
      profile: accountProfile("Ada from phone", 5),
    }),
  };
  const { owner } = service(memory.store, linked);
  expect(await owner.update(ownerId, name("Ada from Mac"))).toEqual({
    applied: false,
    profile: { name: "Ada from phone", accountBacked: true },
  });
});

it("returns the name to this computer when the link ended, then saves it here", async () => {
  const memory = memoryStore({ ownerId, name: name("Ada"), account: { ...account, revision: 3 } });
  const linked: OwnerProfileAccount = {
    readOwnerProfile: async () => null,
    updateOwnerProfile: async () => null,
  };
  const { owner } = service(memory.store, linked);
  expect(await owner.update(ownerId, name("Ada Local"))).toEqual({
    applied: true,
    profile: { name: "Ada Local", accountBacked: false },
  });
});

it("catches up with a rename made elsewhere, and only announces a real change", async () => {
  const memory = memoryStore({ ownerId, name: name("Ada"), account: { ...account, revision: 3 } });
  let remote: AccountProfile | null = accountProfile("Ada", 3);
  const linked: OwnerProfileAccount = {
    readOwnerProfile: async () => (remote ? { account, profile: remote } : null),
    updateOwnerProfile: async () => null,
  };
  const { owner, changes } = service(memory.store, linked);
  await owner.refresh();
  expect(changes()).toBe(0);
  remote = accountProfile("Ada Lovelace", 4);
  await owner.refresh();
  expect(memory.current().name).toBe("Ada Lovelace");
  expect(changes()).toBe(1);
  remote = null;
  await owner.refresh();
  expect(memory.current()).toMatchObject({ name: "Ada Lovelace", account: null });
  expect(changes()).toBe(2);
});
