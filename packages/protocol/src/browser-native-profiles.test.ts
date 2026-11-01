import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { DeleteLocalProfileSchema, LocalProfileInventorySchema } from "./browser-relay.js";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserAttachTicketIdentitySchema,
  BrowserProfileStorageSchema,
  LocalProfileBindingSchema,
  createBrowserSessionId,
} from "./browser.js";
const uuid = "11111111-1111-4111-8111-111111111111";
const binding = LocalProfileBindingSchema.parse({
  version: 1,
  deploymentId: createId("deployment"),
  profileId: createId("browserProfile"),
  runnerId: createId("runner"),
  storageInstanceId: uuid,
  bindingId: uuid,
  engine: "electron",
});
const claims = {
  operationExpiresAt: new Date(Date.now() + 18_000).toISOString(),
  remainingBudgetMs: 18_000,
  wireVersion: 1,
  access: "full-control",
  audience: "opensteer-browser-runtime",
  expiresAt: "2026-10-31T12:01:00.000Z",
  identity: { kind: "fresh" },
  issuedAt: "2026-10-31T12:00:00.000Z",
  nonce: "a".repeat(32),
  runtimeId: "browser",
  sessionId: createBrowserSessionId(),
  subject: "owner",
};
it("admits only fresh or exact native authority and a durable initialized fact", () => {
  for (const initialized of [false, true]) {
    const identity = {
      kind: "profile-local",
      binding,
      initialized,
      readyUrl: "https://host.test/ready",
    };
    expect(BrowserAttachTicketIdentitySchema.parse(identity)).toEqual(identity);
    expect(BrowserProfileStorageSchema.parse({ kind: "local", binding, initialized })).toEqual({
      kind: "local",
      binding,
      initialized,
    });
  }
  expect(BrowserProfileStorageSchema.parse({ kind: "unbound" })).toEqual({ kind: "unbound" });
  for (const value of [
    { kind: "vault" },
    { kind: "initializing", binding },
    { kind: "local", binding },
    { kind: "local", binding, initialized: true, seed: { revision: 0, digest: "a".repeat(64) } },
  ])
    expect(BrowserProfileStorageSchema.safeParse(value).success).toBe(false);
  for (const value of [
    { kind: "profile", profileId: binding.profileId },
    { kind: "profile-local", binding, initialized: true },
    {
      kind: "profile-local",
      binding: { ...binding, directory: "/private/profile" },
      initialized: true,
      readyUrl: "https://host.test/ready",
    },
  ])
    expect(BrowserAttachTicketIdentitySchema.safeParse(value).success).toBe(false);
});
it("requires the current signed wire contract and safe initial navigation", () => {
  const initialNavigation = { operationKey: "open:1", url: "https://example.test/" };
  expect(BrowserAttachTicketClaimsSchema.parse({ ...claims, initialNavigation })).toEqual({
    ...claims,
    initialNavigation,
  });
  for (const value of [
    { ...claims, wireVersion: undefined },
    { ...claims, wireVersion: 2 },
    { ...claims, initialNavigation: { ...initialNavigation, url: "file:///private" } },
    {
      ...claims,
      initialNavigation: { ...initialNavigation, url: "https://user:secret@example.test" },
    },
  ])
    expect(BrowserAttachTicketClaimsSchema.safeParse(value).success).toBe(false);
});
it("keeps deletion and inventory authority exact under the single current contract", () => {
  const fence = {
    bootId: `rbt_${uuid}`,
    connectionGeneration: 1,
    connectionId: `rcn_${uuid}`,
    connectionLeaseId: `rls_${uuid}`,
    runnerId: binding.runnerId,
    auxiliaryStreamId: `rax_${uuid}`,
    module: "browser",
  };
  const deletion = {
    ...fence,
    type: "browser.profile.delete",
    requestId: `rar_${uuid}`,
    binding,
    deletionId: uuid,
    capability: { capabilityGeneration: 1, capabilityLeaseId: `bcl_${uuid}`, runtimeId: "browser" },
  };
  expect(DeleteLocalProfileSchema.parse(deletion)).toEqual(deletion);
  const inventory = {
    ...fence,
    type: "browser.profile.inventory",
    storageInstanceId: uuid,
    engine: "electron",
    profiles: [{ phase: "ready", binding }],
    complete: true,
  };
  expect(LocalProfileInventorySchema.parse(inventory)).toEqual(inventory);
  expect(
    LocalProfileInventorySchema.safeParse({
      ...inventory,
      profiles: [{ phase: "ready", binding, seed: { revision: 0, digest: "a".repeat(64) } }],
    }).success,
  ).toBe(false);
});
