import type { AccountProfile } from "@opensteer/control-plane-protocol";
import type { PersonName } from "@opensteer/core";
import { expect, it } from "vitest";
import { AccountProfileRelay } from "./account-profile-relay.js";

const profile = (revision: number, name = "Ada"): AccountProfile => ({
  name: name as PersonName,
  revision,
  receipt: `receipt-${revision}` as AccountProfile["receipt"],
});

it("reads once for every team, relays only to older copies, and never to teams without names", async () => {
  let reads = 0;
  const relay = new AccountProfileRelay({
    profile: async () => (reads++, profile(3)),
    updateProfile: async () => {
      throw new Error("unused");
    },
  });
  const applied: string[] = [];
  const team = (nameRevision: number | undefined) => ({
    nameRevision,
    apply: async (receipt: string) => void applied.push(receipt),
  });
  await Promise.all([relay.relay(team(2)), relay.relay(team(3)), relay.relay(team(undefined))]);
  await relay.relay(team(0));
  expect(applied).toEqual(["receipt-3", "receipt-3"]);
  expect(reads).toBe(1);
});

it("rereads after a change and holds the newest name, never one read before the change", async () => {
  let release: (value: AccountProfile) => void = () => undefined;
  const pending: AccountProfile[] = [];
  const relay = new AccountProfileRelay({
    profile: () =>
      pending.length > 0
        ? Promise.resolve(pending.shift()!)
        : new Promise((resolve) => {
            release = resolve;
          }),
    updateProfile: async (request) => ({
      applied: true,
      profile: profile(request.expectedRevision + 1, request.name),
    }),
  });
  let notified = 0;
  relay.subscribe(() => notified++);
  const stale = relay.current();
  // Another Account signed in, or the name changed, while that read was in flight.
  relay.changed();
  release(profile(9, "Someone else"));
  await stale;
  pending.push(profile(4, "Ada"));
  expect(await relay.current()).toEqual(profile(4, "Ada"));

  const saved = await relay.update({ name: "Ada Lovelace" as PersonName, expectedRevision: 4 });
  expect(saved.profile.revision).toBe(5);
  expect(await relay.current()).toEqual(profile(5, "Ada Lovelace"));
  expect(notified).toBe(2);

  // A save that finishes after another Account signed in never becomes that Account's name.
  const late = relay.update({ name: "Old Account" as PersonName, expectedRevision: 5 });
  relay.changed(profile(1, "New Account"));
  await late;
  expect(await relay.current()).toEqual(profile(1, "New Account"));
});

it("keeps relaying the last name it read while the Account is unreachable, and never throws", async () => {
  let up = true;
  let now = 0;
  const relay = new AccountProfileRelay(
    {
      profile: async () => {
        if (!up) throw new Error("offline");
        return profile(2);
      },
      updateProfile: async () => {
        throw new Error("unused");
      },
    },
    () => now,
  );
  expect(await relay.current()).toEqual(profile(2));
  up = false;
  now = 60 * 60 * 1_000;
  expect(await relay.current()).toEqual(profile(2));
});
