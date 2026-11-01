import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  BrowserAttachTicketClaimsSchema,
  BrowserPreparationTicketClaimsSchema,
  BrowserAttachTicketIdentitySchema,
  BrowserProfileStorageSchema,
  CompleteProfileInitializationSchema,
  FrozenProfileSeedSchema,
  HostedBrowserBootstrapSchema,
  LocalProfileBindingSchema,
  ProfileInitializationSeedResponseSchema,
  createBrowserSessionId,
} from "./browser.js";
import {
  DeleteLocalProfileSchema,
  LocalProfileDeletionResultSchema,
  LocalProfileInventorySchema,
  createBrowserRelayToHostMessageSchema,
  createHostToBrowserRelayMessageSchema,
} from "./browser-relay.js";
import { RunnerAuxiliaryWelcomeSchema } from "./runner-auxiliary.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const binding = {
  version: 1,
  deploymentId: createId("deployment"),
  profileId: createId("browserProfile"),
  runnerId: createId("runner"),
  storageInstanceId: uuid,
  bindingId: uuid,
  engine: "electron",
};
const seed = { revision: 0, digest: "a".repeat(64) };
const initialization = {
  seed,
  initializationUrl: "https://host.test/v1/profile-initialization",
  initializationToken: "a".repeat(43),
};
const fence = {
  bootId: `rbt_${uuid}`,
  connectionGeneration: 1,
  connectionId: `rcn_${uuid}`,
  connectionLeaseId: `rls_${uuid}`,
  runnerId: binding.runnerId,
  auxiliaryStreamId: `rax_${uuid}`,
  module: "browser",
};
const capability = {
  capabilityGeneration: 1,
  capabilityLeaseId: `bcl_${uuid}`,
  runtimeId: "browser",
};
const claims = {
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

describe("native profile contracts", () => {
  it("negotiates preparation independently and grants no page or session authority", () => {
    const identity = { kind: "profile-local", binding, initialization };
    const preparation = {
      audience: claims.audience,
      purpose: "profile-prepare",
      identity,
      runtimeId: claims.runtimeId,
      subject: claims.subject,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      nonce: claims.nonce,
    };
    expect(BrowserPreparationTicketClaimsSchema.parse(preparation)).toEqual(preparation);
    expect(BrowserAttachTicketClaimsSchema.safeParse(preparation).success).toBe(false);
    for (const extra of [
      { sessionId: claims.sessionId },
      { access: "full-control" },
      { initialNavigation: { operationKey: "x" } },
    ])
      expect(
        BrowserPreparationTicketClaimsSchema.safeParse({ ...preparation, ...extra }).success,
      ).toBe(false);
    const message = {
      ...fence,
      capability,
      requestId: "prepare",
      type: "browser.profile.prepare",
      channelId: `bch_${uuid}`,
      preparationTicket: "abc.def.ghi",
    };
    expect(createHostToBrowserRelayMessageSchema().safeParse(message).success).toBe(false);
    expect(
      createHostToBrowserRelayMessageSchema({ localProfiles: 1 }).safeParse(message).success,
    ).toBe(false);
    expect(
      createHostToBrowserRelayMessageSchema({ profilePrepare: 1 }).safeParse(message).success,
    ).toBe(false);
    expect(
      createHostToBrowserRelayMessageSchema({ localProfiles: 1, profilePrepare: 1 }).parse(message),
    ).toEqual(message);
  });
  it("keeps released fresh and profile identities exact", () => {
    for (const identity of [
      { kind: "fresh" },
      {
        kind: "profile",
        profileId: binding.profileId,
        profileLeaseToken: "a".repeat(43),
        profileStateUrl: "https://host.test/state",
      },
    ]) {
      expect(BrowserAttachTicketIdentitySchema.parse(identity)).toEqual(identity);
      expect(BrowserAttachTicketClaimsSchema.parse({ ...claims, identity })).toEqual({
        ...claims,
        identity,
      });
      expect(BrowserAttachTicketIdentitySchema.safeParse({ ...identity, binding }).success).toBe(
        false,
      );
    }
  });

  it("accepts only an exact local binding and optional frozen initialization", () => {
    for (const identity of [
      { kind: "profile-local", binding },
      { kind: "profile-local", binding, initialization },
    ])
      expect(BrowserAttachTicketIdentitySchema.parse(identity)).toEqual(identity);
    for (const identity of [
      { kind: "profile-initialize", binding, ...initialization },
      { kind: "profile-local", binding, profileStateUrl: "https://host.test/state" },
      { kind: "profile-local", binding: { ...binding, directory: "/private/profile" } },
      { kind: "profile-local", binding, initialization: { ...initialization, extra: true } },
      { kind: "profile-local", binding, initialization: { seed } },
    ])
      expect(BrowserAttachTicketIdentitySchema.safeParse(identity).success).toBe(false);
    expect(LocalProfileBindingSchema.safeParse({ ...binding, version: 2 }).success).toBe(false);
    expect(
      LocalProfileBindingSchema.safeParse({ ...binding, storageInstanceId: "boot" }).success,
    ).toBe(false);
    for (const invalid of [
      { ...seed, revision: -1 },
      { ...seed, digest: "A".repeat(64) },
      { ...seed, extra: true },
    ]) {
      expect(FrozenProfileSeedSchema.safeParse(invalid).success).toBe(false);
    }
    for (const kind of ["initializing", "local"]) {
      expect(BrowserProfileStorageSchema.parse({ kind, binding, seed })).toEqual({
        kind,
        binding,
        seed,
      });
    }
    expect(BrowserProfileStorageSchema.parse({ kind: "vault" })).toEqual({ kind: "vault" });
  });

  it("requires both initial-navigation fields and safe signed addresses", () => {
    const initialNavigation = { operationKey: "open:1", url: "https://example.test/" };
    expect(
      BrowserAttachTicketClaimsSchema.parse({
        ...claims,
        initialNavigationVersion: 1,
        initialNavigation,
      }),
    ).toMatchObject({ initialNavigationVersion: 1, initialNavigation });
    expect(
      BrowserAttachTicketClaimsSchema.parse({
        ...claims,
        initialNavigationVersion: 1,
        initialNavigation: { operationKey: "blank" },
      }),
    ).toBeTruthy();
    for (const extra of [
      { initialNavigationVersion: 1 },
      { initialNavigation },
      { initialNavigationVersion: 2, initialNavigation },
      {
        initialNavigationVersion: 1,
        initialNavigation: { ...initialNavigation, url: "file:///secret" },
      },
      {
        initialNavigationVersion: 1,
        initialNavigation: { ...initialNavigation, url: "https://user:pass@example.test/" },
      },
    ])
      expect(BrowserAttachTicketClaimsSchema.safeParse({ ...claims, ...extra }).success).toBe(
        false,
      );
  });

  it("keeps released welcome exact and independently acknowledges new features", () => {
    const welcome = {
      ...fence,
      type: "host.auxiliary.welcome",
      heartbeatIntervalMs: 10_000,
      serverTime: claims.issuedAt,
      streamLeaseExpiresAt: claims.expiresAt,
    };
    expect(RunnerAuxiliaryWelcomeSchema.parse(welcome)).toEqual(welcome);
    expect(RunnerAuxiliaryWelcomeSchema.parse({ ...welcome, localProfiles: 1 })).toEqual({
      ...welcome,
      localProfiles: 1,
    });
    expect(RunnerAuxiliaryWelcomeSchema.parse({ ...welcome, initialNavigationVersion: 1 })).toEqual(
      { ...welcome, initialNavigationVersion: 1 },
    );
    expect(RunnerAuxiliaryWelcomeSchema.safeParse({ ...welcome, localProfiles: 2 }).success).toBe(
      false,
    );
  });

  it("makes conversion inputs strict and seed responses tolerant", () => {
    expect(CompleteProfileInitializationSchema.parse({ binding, seed })).toEqual({ binding, seed });
    expect(
      CompleteProfileInitializationSchema.safeParse({ binding, seed, snapshot: {} }).success,
    ).toBe(false);
    expect(
      ProfileInitializationSeedResponseSchema.parse({
        binding,
        seed,
        snapshot: { cookies: [], origins: [] },
        future: true,
      }),
    ).not.toHaveProperty("future");
  });

  it("accepts bounded fenced inventory and deletion only after negotiation", () => {
    const inventory = {
      ...fence,
      type: "browser.profile.inventory",
      storageInstanceId: uuid,
      engine: "electron",
      profiles: [
        { phase: "initializing", binding, seed },
        { phase: "ready", binding, seed },
        { phase: "deleted", binding, deletionId: uuid, erasure: "pending-restart" },
      ],
      complete: true,
    };
    const deletion = {
      ...fence,
      capability,
      type: "browser.profile.delete",
      requestId: "delete:1",
      binding,
      deletionId: uuid,
    };
    const result = { ...deletion, type: "browser.profile.delete.result", state: "pending-restart" };
    expect(LocalProfileInventorySchema.parse(inventory)).toEqual(inventory);
    expect(DeleteLocalProfileSchema.parse(deletion)).toEqual(deletion);
    expect(LocalProfileDeletionResultSchema.parse(result)).toEqual(result);
    for (const [schema, value] of [
      [LocalProfileInventorySchema, inventory],
      [DeleteLocalProfileSchema, deletion],
      [LocalProfileDeletionResultSchema, result],
    ] as const) {
      expect(schema.safeParse({ ...value, extra: true }).success).toBe(false);
      expect(schema.safeParse({ ...value, module: "shell" }).success).toBe(false);
    }
    expect(
      LocalProfileInventorySchema.safeParse({
        ...inventory,
        profiles: [{ phase: "ready", binding, seed, path: "/private" }],
      }).success,
    ).toBe(false);
    expect(
      LocalProfileDeletionResultSchema.safeParse({ ...result, state: "pending-computer" }).success,
    ).toBe(false);
    expect(createHostToBrowserRelayMessageSchema().safeParse(deletion).success).toBe(false);
    expect(createBrowserRelayToHostMessageSchema().safeParse(inventory).success).toBe(false);
    expect(createBrowserRelayToHostMessageSchema().safeParse(result).success).toBe(false);
    expect(createHostToBrowserRelayMessageSchema({ localProfiles: 1 }).parse(deletion)).toEqual(
      deletion,
    );
    expect(createBrowserRelayToHostMessageSchema({ localProfiles: 1 }).parse(inventory)).toEqual(
      inventory,
    );
    expect(createBrowserRelayToHostMessageSchema({ localProfiles: 1 }).parse(result)).toEqual(
      result,
    );
    const attached = {
      ...fence,
      capability,
      requestId: "attach:1",
      channelId: `bch_${uuid}`,
      type: "browser.attached",
    };
    expect(createBrowserRelayToHostMessageSchema().parse(attached)).toEqual(attached);
    const readiness = {
      ...attached,
      initialPage: { operationKey: "open:1", surfaceId: "surface-1", navigation: "submitted" },
    };
    expect(createBrowserRelayToHostMessageSchema().safeParse(readiness).success).toBe(false);
    expect(
      createBrowserRelayToHostMessageSchema({ initialNavigationVersion: 1 }).parse(readiness),
    ).toEqual(readiness);
  });

  it("keeps deletion status optional and tolerant in owner projections", () => {
    const baseline = {
      available: false,
      placements: [],
      profiles: [],
      profileGrants: [],
      sessions: [],
    };
    expect(HostedBrowserBootstrapSchema.parse(baseline)).toEqual(baseline);
    const pending = {
      profileId: binding.profileId,
      computerId: binding.runnerId,
      state: "pending-computer",
    };
    expect(
      HostedBrowserBootstrapSchema.parse({
        ...baseline,
        profileDeletions: [
          { ...pending, future: true },
          { ...pending, state: "future" },
        ],
      }).profileDeletions,
    ).toEqual([pending]);
  });
});
