import { createId } from "@opensteer/core";
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
  const control = {
    holdLists: false,
    failLists: 0,
    listCalls: 0,
    pageSize: undefined as number | undefined,
    dispatched: [] as unknown[],
  };
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
      control.listCalls++;
      if (control.failLists > 0) {
        control.failLists--;
        return Response.json({
          ok: false,
          error: { code: "timeout", message: "Host busy", retryable: true },
        });
      }
      // The answer is what the Host listed when the read reached it.
      const answer = (await (await personal.fetch(input, init)).json()) as {
        data: {
          requests: unknown[];
          window: { hasMore: boolean; nextBefore?: string | null };
        };
      };
      answer.data.requests = [...host.pending];
      if (control.pageSize !== undefined) {
        // The Host pages the list: `before` is the index the next page starts at.
        const before = JSON.parse(url.searchParams.get("input") ?? "{}").before as
          string | undefined;
        const start = before ? Number(before) : 0;
        const end = start + control.pageSize;
        answer.data.requests = host.pending.slice(start, end);
        answer.data.window = {
          ...answer.data.window,
          hasMore: end < host.pending.length,
          nextBefore: end < host.pending.length ? String(end) : null,
        };
      }
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

it("lets unrelated shell activity leave a list read in flight alone, and installs its answer", async () => {
  const f = await harness();
  f.control.holdLists = true;
  await f.client.load();
  await vi.waitFor(() => expect(f.lists).toHaveLength(1));
  // Other work keeps publishing shell frames; the pending Requests do not change.
  for (let frame = 0; frame < 5; frame++) {
    f.personal.repairShell();
    await f.roundTrip();
  }
  expect(f.lists).toHaveLength(1);
  f.control.holdLists = false;
  for (const list of f.lists.splice(0)) list.release();
  await vi.waitFor(() =>
    expect(f.ids().sort()).toEqual(f.all.map(({ request }) => request.id).sort()),
  );
  await f.roundTrip();
  // One read answered it: the frames neither displaced it nor queued reruns behind it.
  expect(f.control.listCalls).toBe(1);
});

it("lets a list read finish while unrelated shell activity keeps arriving", async () => {
  const f = await harness();
  f.control.holdLists = true;
  await f.client.load();
  await vi.waitFor(() => expect(f.lists).toHaveLength(1));
  // Other tasks move: the shell advances, its pending-Requests revision does not.
  for (let through = 1; through <= 5; through++) {
    f.personal.publish(String(1_000 + through));
    await f.roundTrip();
  }
  expect(f.lists).toHaveLength(1);
  f.lists.splice(0)[0]!.release();
  await vi.waitFor(() =>
    expect(f.ids().sort()).toEqual(f.all.map(({ request }) => request.id).sort()),
  );
  f.personal.publish("2000");
  await f.roundTrip();
  expect(f.lists).toHaveLength(0);
});

it("reads the list again when a listed Request changes but the count does not", async () => {
  const f = await harness();
  await f.client.load();
  await vi.waitFor(() => expect(f.ids()).toHaveLength(f.all.length));
  // The same Requests, one of them now asked from a renamed place: the count and the bounded
  // attention preview are unchanged; only the Host's pending-Requests revision moves.
  const [first, ...rest] = f.all;
  const renamed = {
    ...first!,
    subagent: { id: createId("executionNode"), title: "Renamed", within: null },
  };
  f.host.pending = [renamed, ...rest] as typeof f.all;
  f.personal.repairShell();
  await vi.waitFor(() =>
    expect(
      f.client.getSnapshot().waitingRequests.find(({ request }) => request.id === first!.request.id)
        ?.subagent?.title,
    ).toBe("Renamed"),
  );
});

it("lists every pending Request however many pages the Host serves them in", async () => {
  const f = await harness();
  // 2,001 pending Requests, 100 to a page: twenty-one pages.
  f.host.pending = Array.from({ length: 2_001 }, () => ({
    ...f.all[0]!,
    request: { ...f.all[0]!.request, id: `req_${crypto.randomUUID()}` as never },
  }));
  f.control.pageSize = 100;
  await f.client.load();
  await vi.waitFor(() => expect(f.ids()).toHaveLength(2_001), { timeout: 3_000 });
  expect(f.control.listCalls).toBe(21);
});
