import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import type { HostSnapshot } from "./client.js";
import { HttpHostClient } from "./host-session-client.js";
import type { ClientLifecycle } from "./lifecycle.js";

/*
 * The global waiting Requests converge on what the Host states after every event that can move
 * them: an answer elsewhere, an answer here, the app returning to the front, a repair.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.restoreAllMocks();
});

async function harness() {
  const seed = new MockHostClient({ latencyMs: 0, places: "absent", subagents: "needs" });
  await seed.load();
  const original = seed.getSnapshot.bind(seed);
  const all = original().waitingRequests;
  expect(all.length).toBeGreaterThan(0);
  // What the Host lists as pending; its shell count follows it. The bounded attention shows none.
  const host = { pending: all as HostSnapshot["waitingRequests"] };
  vi.spyOn(seed, "getSnapshot").mockImplementation(() => ({
    ...original(),
    needsYou: null,
    waitingRequests: host.pending,
  }));
  const personal = new MockPersonalHost(seed);
  const lists: { release: () => void }[] = [];
  const control = { holdLists: false, failLists: 0, dispatched: [] as unknown[] };
  let foreground = () => {};
  let background = () => {};
  const lifecycle: ClientLifecycle = {
    getSnapshot: () => ({ network: "online", visibility: "foreground" }),
    onForeground: (listener) => {
      foreground = listener;
      return () => {};
    },
    onBackground: (listener) => {
      background = listener;
      return () => {};
    },
    onNetworkChange: () => () => {},
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    capabilities: [],
    lifecycle,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/commands.dispatch")) {
        const command = JSON.parse(String(init?.body)) as { type: string; requestId?: string };
        if (command.type === "request.respond") {
          control.dispatched.push(command);
          host.pending = host.pending.filter(({ request }) => request.id !== command.requestId);
          return Response.json({
            ok: true,
            data: { type: "request.respond", wasDuplicate: false },
          });
        }
      }
      if (!url.pathname.endsWith("/requests.list")) return personal.fetch(input, init);
      if (control.failLists > 0) {
        control.failLists--;
        return Response.json({
          ok: false,
          error: { code: "timeout", message: "Host busy", retryable: true },
        });
      }
      // The answer is what the Host listed when the read reached it.
      const answer = (await (await personal.fetch(input, init)).json()) as {
        data: { requests: unknown[] };
      };
      answer.data.requests = [...host.pending];
      if (!control.holdLists) return Response.json(answer);
      const held = Promise.withResolvers<void>();
      lists.push({ release: held.resolve });
      await held.promise;
      return Response.json(answer);
    },
    webSocketFactory: personal.connect,
  });
  disposals.push(() => {
    client.dispose();
    personal.dispose();
  });
  const ids = () => client.getSnapshot().waitingRequests.map(({ request }) => request.id);
  // A round trip after which anything the client started before it has been asked.
  const roundTrip = async () => {
    for (let index = 0; index < 3; index++) await client.rpc["auth.config"]({});
  };
  return {
    all,
    host,
    personal,
    client,
    control,
    lists,
    ids,
    roundTrip,
    foreground: () => foreground(),
    background: () => background(),
  };
}

it("never installs a list read before the last Request was answered elsewhere", async () => {
  const f = await harness();
  f.control.holdLists = true;
  await f.client.load();
  await vi.waitFor(() => expect(f.lists).toHaveLength(1));
  // Answered on another device while the first read is out: the Host's count goes to zero.
  f.host.pending = [];
  f.personal.repairShell();
  await f.roundTrip();
  for (const list of f.lists.splice(0)) list.release();
  await f.roundTrip();
  expect(f.ids()).toEqual([]);
});

it("reads the list again on returning to the front when its read was given up behind", async () => {
  const f = await harness();
  f.host.pending = [];
  await f.client.load();
  f.background();
  // A Request arrives while the app is behind; any read of it fails there.
  f.control.failLists = 1;
  f.host.pending = f.all;
  f.personal.repairShell();
  await f.roundTrip();
  f.foreground();
  // The failed read retries after its first backoff, a second.
  await vi.waitFor(
    () => expect(f.ids().sort()).toEqual(f.all.map(({ request }) => request.id).sort()),
    { timeout: 3_000 },
  );
});

it("drops a Request answered here at once, and an older list read never brings it back", async () => {
  const f = await harness();
  await f.client.load();
  await vi.waitFor(() => expect(f.ids()).toHaveLength(f.all.length));
  const answered = f.all[0]!.request.id;
  // A read that began before the answer, holding the Request as pending.
  f.control.holdLists = true;
  f.host.pending = [...f.all];
  f.personal.repairShell();
  const shown: string[][] = [];
  disposals.push(f.client.subscribe(() => shown.push(f.ids())));
  const answering = f.client.dispatch({
    idempotencyKey: "request:answer:test",
    expectedRevision: "1",
    requestId: answered,
    response: { answers: { choice: ["yes"] }, kind: "form" },
    type: "request.respond",
  });
  expect(f.ids()).not.toContain(answered);
  await answering;
  f.control.holdLists = false;
  for (const list of f.lists.splice(0)) list.release();
  await f.roundTrip();
  expect(f.ids()).not.toContain(answered);
  expect(shown.some((ids) => ids.includes(answered))).toBe(false);
});
