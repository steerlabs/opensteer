import { utf8ByteLength } from "@opensteer/core";
import {
  MachineSummarySchema,
  machineInventoryEntryMaxBytes,
  personalMachineLimit,
  type MachineListSummary,
} from "@opensteer/protocol";
import { personalInventoryBound } from "@opensteer/protocol/resources";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { sql } from "kysely";
import { expect, it } from "vitest";
import type { HostServerDependencies } from "../server.js";
import {
  startPrivateMachineHost,
  type PrivateMachineHost,
} from "../runtime/private-machine-host.test-support.js";
import { PersonalResources } from "./personal-resources.js";

/** Every app at its limit: 64 apps of 64 operations, each with a 1,000-character detail. */
const apps = Array.from({ length: 64 }, (_, app) => ({
  definitionId: `app-${app}`,
  operations: Array.from({ length: 64 }, (_, operation) => ({
    detail: "d".repeat(1_000),
    operation: `operation-${operation}-${"o".repeat(400)}`,
    remedy: null,
    state: "ready" as const,
  })),
}));

/** A computer at its largest: long names and details, and a full apps section. */
function largest(id: string): MachineListSummary {
  const module = {
    checkedAt: new Date().toISOString(),
    detail: "m".repeat(500),
    readiness: "ready",
  };
  return {
    ...MachineSummarySchema.parse({
      access: null,
      allowedModules: ["agents", "browser", "integrations", "messaging", "shell"],
      apps,
      computerUse: null,
      detail: "x".repeat(1_000),
      device: null,
      enrollmentId: null,
      expiresAt: null,
      fullDiskAccess: null,
      id,
      kind: "computer",
      lastSeenAt: new Date().toISOString(),
      modules: {
        agents: module,
        browser: module,
        integrations: module,
        messaging: module,
        shell: module,
      },
      name: "n".repeat(120),
      ownership: "mine",
      revocable: true,
      runtimeVersion: "v".repeat(120),
      status: "online",
    }),
    pinnedThreads: 0,
  };
}

it("lists every computer at its largest within the client's bound, and serves each one whole on its own", async () => {
  const database = await cloneTestDatabase("host");
  let host: PrivateMachineHost | undefined;
  try {
    host = await startPrivateMachineHost(database.url, { logger: false });
    const { store } = host;
    // Fill the Deployment to its computer limit.
    const [template] = await sql<{
      id: string;
    }>`select id from devices where removed_at is null limit 1`
      .execute(store.database)
      .then(({ rows }) => rows);
    const held = Number(
      (
        await sql<{
          count: string;
        }>`select count(*) as count from devices where removed_at is null`.execute(store.database)
      ).rows[0]!.count,
    );
    await sql`insert into devices
      select (jsonb_populate_record(null::devices, to_jsonb(d)
        || jsonb_build_object('id', 'dev_' || gen_random_uuid()))).*
      from devices d, generate_series(1, ${personalMachineLimit - held})
      where d.id = ${template!.id}`.execute(store.database);
    const resources = new PersonalResources(
      { store, resourceRevisions: { get: () => "1" } } as unknown as HostServerDependencies,
      async (_session, page) => [...page.deviceIds, ...page.pendingIds].map((id) => largest(id)),
    );
    const session = { user: { id: host.ownerId } } as Parameters<PersonalResources["detail"]>[0];
    // The client's read: every page, measured as the client measures it.
    let cursor: string | undefined;
    let bytes = 0;
    const entries = [];
    for (;;) {
      const page = await resources.detail(session, {
        kind: "machine",
        ...(cursor ? { cursor } : {}),
      });
      bytes += utf8ByteLength(JSON.stringify(page.data));
      if (page.data.kind !== "machine") throw new Error("Expected machines");
      entries.push(...page.data.machines);
      if (!page.next) break;
      cursor = page.next;
    }
    expect(entries).toHaveLength(personalMachineLimit);
    expect(bytes).toBeLessThanOrEqual(personalInventoryBound("machine"));
    for (const entry of entries) {
      expect(utf8ByteLength(JSON.stringify(entry))).toBeLessThanOrEqual(
        machineInventoryEntryMaxBytes,
      );
      // The list keeps what removal and status need, and only counts the heavy sections.
      expect(entry).toMatchObject({ revocable: true, sections: { apps: 64 } });
      expect(entry).not.toHaveProperty("apps");
    }
    // One computer's own page reads its sections whole.
    const { machine } = await resources.machineDetail(session, entries[0]!.id);
    expect(machine.apps).toHaveLength(64);
    expect(machine.apps?.[0]?.operations).toHaveLength(64);
    await expect(resources.machineDetail(session, "dev_missing")).rejects.toMatchObject({
      code: "not_found",
    });
  } finally {
    await host?.close();
    await database.drop();
  }
});
