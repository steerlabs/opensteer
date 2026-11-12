import { BrowserSourceIdSchema } from "@opensteer/browser-source-wire/frozen";
import { beforeEach, expect, it, vi } from "vitest";
import { addConnection, loadConnections, loadQuarantine, migrateConnection } from "./storage.js";

let stored: Record<string, unknown>;
beforeEach(() => {
  stored = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async () => structuredClone(stored),
        set: async (items: Record<string, unknown>) => {
          Object.assign(stored, structuredClone(items));
        },
      },
    },
  });
});
const legacy = () => ({
  authority: {
    publicKey: { spki: "A".repeat(59) },
    document: {
      deploymentId: "dep_11111111-1111-4111-8111-111111111111",
      canonicalOrigin: "http://localhost:3000",
      deploymentShape: { kind: "personal", backing: "local" },
    },
  },
  sourceId: "bsr_11111111-1111-4111-8111-111111111111",
  token: "B".repeat(43),
  origin: "http://localhost:3000",
  route: null,
  connectedAt: 1,
  deploymentName: "Home",
  name: "Browser",
  stoppedSites: ["https://stopped.test"],
  sharedSites: {},
  newShares: [Date.now()],
});
it("quarantines malformed top-level storage verbatim in the migration write", async () => {
  const raw = { broken: true, stoppedSites: ["https://stopped.test"] };
  stored.connections = raw;
  expect(await loadConnections()).toEqual([]);
  expect(stored.quarantined).toEqual([{ id: expect.any(String), raw }]);
  expect(await loadQuarantine()).toHaveLength(1);
});
it("preserves consent by deployment and key and unions pluckable quarantined stops", async () => {
  const old = legacy();
  stored.connections = [old, { stoppedSites: ["https://quarantined.test"] }];
  const migrated = (await loadConnections())[0]!;
  expect(migrated.token).toBe(old.token);
  expect(migrated.newShares).toEqual(old.newShares);
  const next = await addConnection(
    {
      ...migrated,
      sourceId: BrowserSourceIdSchema.parse("bsr_22222222-2222-4222-8222-222222222222"),
      newShares: [],
      stoppedSites: ["https://new.test"],
    },
    null,
  );
  expect(next.stoppedSites).toEqual([
    "https://new.test",
    "https://stopped.test",
    "https://quarantined.test",
  ]);
  expect(next.newShares).toEqual(old.newShares);
  expect(await loadConnections()).toHaveLength(1);
});
it("reconnecting after quarantine keeps that Deployment's spent budget once, and never a fresh day", async () => {
  const now = Date.now();
  const spent = Array.from({ length: 20 }, (_, index) => now - index * 1_000);
  const unreadable = { ...legacy(), name: 42, newShares: spent };
  const unreadableBudget = { ...legacy(), name: 42, newShares: "broken" };
  const otherDeployment = {
    ...legacy(),
    name: 42,
    authority: {
      ...legacy().authority,
      document: {
        ...legacy().authority.document,
        deploymentId: "dep_33333333-3333-4333-8333-333333333333",
      },
    },
  };
  stored.connections = [unreadable, otherDeployment];
  expect(await loadConnections()).toEqual([]);
  const fresh = migrateConnection(legacy())!;
  const reconnect = (sourceId: string) =>
    addConnection(
      {
        ...fresh,
        sourceId: BrowserSourceIdSchema.parse(sourceId),
        newShares: [],
        stoppedSites: [],
      },
      null,
    );
  const first = await reconnect("bsr_44444444-4444-4444-8444-444444444444");
  expect(first.stoppedSites).toEqual(["https://stopped.test"]);
  expect(first.newShares).toHaveLength(20);
  const second = await reconnect("bsr_55555555-5555-4555-8555-555555555555");
  expect(second.newShares).toHaveLength(20);
  expect(
    (stored.quarantined as { recovered?: true }[]).map((item) => item.recovered ?? false),
  ).toEqual([true, false]);

  stored = { connections: [unreadableBudget] };
  await loadConnections();
  expect((await reconnect("bsr_66666666-6666-4666-8666-666666666666")).newShares).toHaveLength(20);
});
it("never defaults unreadable consent to empty", () => {
  expect(migrateConnection({ ...legacy(), stoppedSites: "broken" })).toBeNull();
  expect(migrateConnection({ ...legacy(), newShares: null })).toBeNull();
});
