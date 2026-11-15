import { createId } from "@opensteer/core";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDatabase } from "./connection.js";
import { createTeamFixture } from "./team-fixture.test-support.js";
import { TeamBus, type TeamBusEvent } from "./team-bus.js";

let fixture: Awaited<ReturnType<typeof createTeamFixture>>;
let copyB: ReturnType<typeof createDatabase>;
const buses: TeamBus[] = [];
beforeEach(async () => {
  fixture = await createTeamFixture();
  copyB = createDatabase({ connectionString: fixture.databaseUrl, applicationName: "team-copy-b" });
});
afterEach(async () => {
  await Promise.all(buses.splice(0).map((bus) => bus.close()));
  await copyB.destroy();
  await fixture.database.destroy();
  await fixture.close();
});

function listen(bus: TeamBus) {
  const events: TeamBusEvent[] = [];
  bus.on((event) => events.push(event));
  buses.push(bus);
  return events;
}

it("tells every copy about a committed change and nothing about a rolled-back one", async () => {
  const a = new TeamBus(fixture.database);
  const b = new TeamBus(copyB);
  const seenA = listen(a);
  const seenB = listen(b);
  await Promise.all([a.start(), b.start()]);

  await fixture.database
    .transaction()
    .execute(async (t) => {
      await t
        .updateTable("users")
        .set({ displayName: "Never" })
        .where("id", "=", fixture.userId)
        .execute();
      throw new Error("roll back");
    })
    .catch(() => {});
  await fixture.database
    .updateTable("users")
    .set({ displayName: "Maya Renamed" })
    .where("id", "=", fixture.userId)
    .execute();
  await a.publish({
    kind: "typing",
    channelId: createId("teamChannel"),
    rootId: null,
    userId: fixture.userId,
    typing: true,
  });

  const expected = [
    { kind: "member", userId: fixture.userId },
    expect.objectContaining({ kind: "typing", typing: true }),
  ];
  await vi.waitFor(() => expect(seenB).toEqual(expected), {
    timeout: 5_000,
    interval: 20,
  });
  expect(seenA).toEqual(expected);
});

it("reconnects after losing its session and resyncs before trusting notifications again", async () => {
  const b = new TeamBus(copyB, { onError: () => {} });
  const seen = listen(b);
  let resyncs = 0;
  b.onResync(async () => {
    resyncs++;
  });
  const health: boolean[] = [];
  b.onHealth((healthy) => health.push(healthy));
  await b.start();
  expect(resyncs).toBe(1);

  await sql`select pg_terminate_backend(pid) from pg_stat_activity
    where datname = current_database() and application_name = 'team-copy-b'`.execute(
    fixture.database,
  );
  await vi.waitFor(() => expect(resyncs).toBe(2), {
    timeout: 10_000,
    interval: 20,
  });
  expect(health).toEqual([true, false, true]);

  await fixture.database
    .updateTable("users")
    .set({ image: "https://local.invalid/new.png" })
    .where("id", "=", fixture.userId)
    .execute();
  await vi.waitFor(() => expect(seen).toEqual([{ kind: "member", userId: fixture.userId }]), {
    timeout: 5_000,
    interval: 20,
  });
});
