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
it("never defaults unreadable consent to empty", () => {
  expect(migrateConnection({ ...legacy(), stoppedSites: "broken" })).toBeNull();
  expect(migrateConnection({ ...legacy(), newShares: null })).toBeNull();
});
