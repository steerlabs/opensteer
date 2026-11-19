import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { HttpHostClient } from "./host-session-client.js";

/*
 * The machine list is a bounded summary; each computer's heavy sections (apps, access, computer
 * use) are read on their own. A computer whose sections cannot be read stays listed, with its
 * status and its removal.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

async function harness() {
  const seed = new MockHostClient({ latencyMs: 0 });
  await seed.load();
  const personal = new MockPersonalHost(seed);
  const control = { failDetails: true, detailReads: [] as string[] };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/environment.detail.get")) {
        control.detailReads.push(url.pathname);
        if (control.failDetails)
          return Response.json({
            ok: false,
            error: { code: "timeout", message: "Host busy", retryable: true },
          });
      }
      if (url.pathname.endsWith("/machine.detail.get")) {
        control.detailReads.push(String(init?.body ?? url.search));
        if (control.failDetails)
          return Response.json({
            ok: false,
            error: { code: "timeout", message: "Host busy", retryable: true },
          });
      }
      return personal.fetch(input, init);
    },
    webSocketFactory: personal.connect,
  });
  disposals.push(() => {
    client.dispose();
    personal.dispose();
  });
  return { seed, personal, client, control };
}

it("lists every computer from its summary while its heavy sections cannot be read, then fills them", async () => {
  const f = await harness();
  const expected = f.seed.getSnapshot().machines;
  const heavy = expected.filter(
    (machine) => machine.apps !== null || machine.computerUse !== null || machine.access !== null,
  );
  expect(heavy.length).toBeGreaterThan(0);
  await f.client.load();
  const release = f.client.watchPersonalResource("machine", () => {});
  await vi.waitFor(() =>
    expect(
      f.client
        .getSnapshot()
        .machines.map(({ id }) => id)
        .sort(),
    ).toEqual(expected.map(({ id }) => id).sort()),
  );
  await vi.waitFor(() => expect(f.control.detailReads.length).toBeGreaterThan(0));
  // Listed, with status and removal, though no section was read.
  for (const machine of f.client.getSnapshot().machines) {
    const source = expected.find(({ id }) => id === machine.id)!;
    expect(machine).toMatchObject({ status: source.status, revocable: source.revocable });
  }
  // Once the Host can answer, each computer's sections arrive whole.
  f.control.failDetails = false;
  await vi.waitFor(
    () => {
      for (const source of heavy) {
        const machine = f.client.getSnapshot().machines.find(({ id }) => id === source.id)!;
        expect(machine.apps).toEqual(source.apps);
        expect(machine.computerUse?.state).toEqual(source.computerUse?.state);
      }
    },
    { timeout: 5_000 },
  );
  release();
});

it("lists every work location from its summary while its engines cannot be read, then fills them", async () => {
  const f = await harness();
  const expected = f.seed.getSnapshot().environments;
  const withEngines = expected.filter(({ harnessDrivers }) => harnessDrivers.length > 0);
  expect(withEngines.length).toBeGreaterThan(0);
  await f.client.load();
  const release = f.client.watchPersonalResource("environment", () => {});
  await vi.waitFor(() =>
    expect(
      f.client
        .getSnapshot()
        .environments.map(({ id }) => id)
        .sort(),
    ).toEqual(expected.map(({ id }) => id).sort()),
  );
  await vi.waitFor(() => expect(f.control.detailReads.length).toBeGreaterThan(0));
  for (const environment of f.client.getSnapshot().environments) {
    const source = expected.find(({ id }) => id === environment.id)!;
    expect(environment).toMatchObject({ status: source.status, name: source.name });
  }
  f.control.failDetails = false;
  await vi.waitFor(
    () => {
      for (const source of withEngines) {
        const environment = f.client.getSnapshot().environments.find(({ id }) => id === source.id)!;
        expect(environment.harnessDrivers.map(({ driverKind }) => driverKind)).toEqual(
          source.harnessDrivers.map(({ driverKind }) => driverKind),
        );
      }
    },
    { timeout: 5_000 },
  );
  release();
});
