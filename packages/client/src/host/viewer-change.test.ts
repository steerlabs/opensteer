import { TabSchema, createId } from "@opensteer/core";
import type { PersonalResourceKind } from "@opensteer/protocol/resources";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import { MockPersonalHost } from "../mock/mock-personal-host.js";
import { resourceBackedFields, type HostSnapshot } from "./client.js";
import { HttpHostClient, type WebSocketClient } from "./host-session-client.js";

/*
 * What a client holds goes with the viewer it was read for, together with what says it was read.
 * A viewer becoming known adopts what was read for it; another viewer, or a new history, clears
 * everything and reads it again; nothing of the viewer before is ever shown.
 */

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});

const fields = Object.keys(resourceBackedFields) as (keyof typeof resourceBackedFields)[];
const kinds = [...new Set(Object.values(resourceBackedFields).flat())] as PersonalResourceKind[];

const listed = TabSchema.parse({
  tabId: "listed-tab",
  kind: "page",
  title: "Ada Lovelace",
  computer: { computerId: createId("runner"), name: "Studio Mac" },
  groupId: null,
  state: "open",
  openedBy: "person",
  usedBy: [],
  createdAt: "2026-11-15T12:00:00.000Z",
  updatedAt: "2026-11-15T12:00:00.000Z",
  url: "https://ada.example/",
  profile: null,
});

function shown(snapshot: HostSnapshot) {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      field === "tabs" ? [...snapshot.tabs.rows.keys()] : snapshot[field],
    ]),
  );
}

function harness(seed = new MockHostClient({ latencyMs: 0 })) {
  const host = new MockPersonalHost(seed);
  const reads = new Map<PersonalResourceKind, number>();
  const held: (() => void)[] = [];
  const control = {
    attachHeld: true,
    /** Holds every resource read's answer until released. */
    readsHeld: false,
    heldReads: [] as (() => void)[],
    /** Rewrites the shell cut the client receives, as another viewer's or history's would read. */
    rewriteShell: undefined as
      ((snapshot: Record<string, unknown>) => Record<string, unknown>) | undefined,
  };
  const client = new HttpHostClient({
    baseUrl: "http://scoped-host",
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.pathname.endsWith("/resources.detail.get")) return host.fetch(input, init);
      const kind = JSON.parse(url.searchParams.get("input")!).kind as PersonalResourceKind;
      reads.set(kind, (reads.get(kind) ?? 0) + 1);
      if (control.readsHeld) await new Promise<void>((resolve) => control.heldReads.push(resolve));
      const response = await host.fetch(input, init);
      if (kind !== "tab") return response;
      const body = (await response.json()) as { data: { data: { tabs: { tabs: unknown[] } } } };
      body.data.data.tabs.tabs = [listed];
      return Response.json(body);
    },
    webSocketFactory: () => {
      const socket = host.connect();
      const send = socket.send.bind(socket);
      const deliver = socket.deliver.bind(socket);
      socket.send = (data) => {
        if (!control.attachHeld) return send(data);
        held.push(() => send(data));
      };
      socket.deliver = (frame) => {
        if (
          control.rewriteShell &&
          frame.type === "host.snapshot" &&
          "subscriptionId" in frame &&
          frame.subscriptionId === "shell"
        )
          return deliver({
            ...frame,
            snapshot: control.rewriteShell(frame.snapshot as never),
          } as typeof frame);
        deliver(frame);
      };
      return socket as unknown as WebSocketClient;
    },
    capabilities: [],
  });
  disposals.push(() => {
    client.dispose();
    host.dispose();
  });
  const releaseAttach = () => {
    control.attachHeld = false;
    for (const send of held.splice(0)) send();
  };
  return { host, client, reads, control, releaseAttach };
}

it("keeps every resource read that lands before the first shell cut, and reads none again", async () => {
  const { client, reads, releaseAttach } = harness();
  // Reading the fields watches their kinds; the reads start beside the socket's attach.
  void shown(client.getSnapshot());
  const loading = client.load();
  await vi.waitFor(() =>
    expect([...client.getSnapshot().loadedResources].sort()).toEqual([...kinds].sort()),
  );
  expect(client.getSnapshot().user).toBeNull();
  const before = shown(client.getSnapshot());
  expect(before.tabs).toEqual([listed.tabId]);
  releaseAttach();
  await loading;
  await vi.waitFor(() => expect(client.getSnapshot().user).not.toBeNull());
  // A read the cut started is asked before this round trip answers.
  await client.rpc["auth.config"]({});
  expect(shown(client.getSnapshot())).toEqual(before);
  for (const kind of kinds) expect(reads.get(kind), kind).toBe(1);
});

it("clears everything for another viewer, shows none of it, and reads it again for them", async () => {
  const { host, client, reads, control, releaseAttach } = harness(
    new MockHostClient({ latencyMs: 0, places: "absent", subagents: "needs" }),
  );
  releaseAttach();
  void shown(client.getSnapshot());
  await client.load();
  await vi.waitFor(() => {
    expect([...client.getSnapshot().loadedResources].sort()).toEqual([...kinds].sort());
    expect(client.getSnapshot().waitingRequests.length).toBeGreaterThan(0);
  });
  const first = client.getSnapshot();
  const other = createId("user");
  // Every snapshot shown as the other viewer, judged once its blank state is known.
  const asOther: { snapshot: HostSnapshot; tabs: number }[] = [];
  disposals.push(
    client.subscribe(() => {
      const snapshot = client.getSnapshot();
      // Only what was shown before any of the other viewer's reads answered.
      if (snapshot.user?.id === other && control.readsHeld)
        asOther.push({ snapshot, tabs: snapshot.tabs.rows.size });
    }),
  );
  control.readsHeld = true;
  control.rewriteShell = (snapshot) => ({
    ...snapshot,
    viewerId: other,
    session: {
      ...(snapshot.session as Record<string, unknown>),
      user: { ...(snapshot.session as { user: object }).user, id: other },
    },
  });
  host.repairShell();
  await vi.waitFor(() => expect(client.getSnapshot().user?.id).toBe(other));
  const between = client.getSnapshot();
  expect(between.tabs.rows.size).toBe(0);
  expect(between.loadedResources).toEqual([]);
  expect(between.ownerProfile).toBeNull();
  expect(between.environments).toEqual([]);
  expect(between.harnesses).toEqual([]);
  control.readsHeld = false;
  for (const resolve of control.heldReads.splice(0)) resolve();
  await vi.waitFor(() => {
    expect([...client.getSnapshot().loadedResources].sort()).toEqual([...kinds].sort());
    expect(client.getSnapshot().tabs.rows.has(listed.tabId)).toBe(true);
  });
  for (const kind of kinds) expect(reads.get(kind), kind).toBe(2);
  // Before its own reads answered, the other viewer saw blanks: no value the first viewer was shown.
  const leaks = asOther.flatMap(({ snapshot, tabs }) => [
    ...fields.filter(
      (field) =>
        field !== "tabs" &&
        !Object.is(first[field], between[field]) &&
        Object.is(snapshot[field], first[field]),
    ),
    ...(tabs > 0 ? ["tabs"] : []),
    ...(first.waitingRequests.length > 0 && snapshot.waitingRequests === first.waitingRequests
      ? ["waitingRequests"]
      : []),
  ]);
  expect(asOther.length).toBeGreaterThan(0);
  expect(leaks).toEqual([]);
});

it("reads resources and waiting Requests again after a new history for the same viewer", async () => {
  const { host, client, reads, control, releaseAttach } = harness(
    new MockHostClient({ latencyMs: 0, places: "absent", subagents: "needs" }),
  );
  releaseAttach();
  void shown(client.getSnapshot());
  await client.load();
  await vi.waitFor(() => {
    expect([...client.getSnapshot().loadedResources].sort()).toEqual([...kinds].sort());
    expect(client.getSnapshot().waitingRequests.length).toBeGreaterThan(0);
  });
  const before = shown(client.getSnapshot());
  const waiting = client.getSnapshot().waitingRequests.map(({ request }) => request.id);
  // The same viewer, the same pending count; only the Host's history moved.
  const epoch = crypto.randomUUID();
  control.rewriteShell = (snapshot) => ({ ...snapshot, epoch });
  host.repairShell();
  await vi.waitFor(() => {
    for (const kind of kinds) expect(reads.get(kind), kind).toBe(2);
  });
  await vi.waitFor(() => {
    // Every value is the same as before; the machine counter tells its readers they were reread.
    const { machineRevision, ...after } = shown(client.getSnapshot());
    const { machineRevision: earlier, ...held } = before;
    expect(after).toEqual(held);
    expect(machineRevision).toBeGreaterThan(earlier as number);
    expect(client.getSnapshot().waitingRequests.map(({ request }) => request.id)).toEqual(waiting);
  });
});

it("keeps showing the same viewer's settings, accounts and tabs while a new history is read", async () => {
  const { host, client, control, releaseAttach } = harness();
  releaseAttach();
  void shown(client.getSnapshot());
  await client.load();
  await vi.waitFor(() =>
    expect([...client.getSnapshot().loadedResources].sort()).toEqual([...kinds].sort()),
  );
  const shownDuring: { session: string; settings: boolean; harnesses: number; tabs: number }[] = [];
  disposals.push(
    client.subscribe(() => {
      const snapshot = client.getSnapshot();
      shownDuring.push({
        session: snapshot.session,
        settings: snapshot.personalSettings !== null,
        harnesses: snapshot.harnesses.length,
        tabs: snapshot.tabs.rows.size,
      });
    }),
  );
  // Reads held: what is on screen meanwhile is what the person keeps working in.
  control.readsHeld = true;
  const epoch = crypto.randomUUID();
  control.rewriteShell = (snapshot) => ({ ...snapshot, epoch });
  host.repairShell();
  await vi.waitFor(() => expect(control.heldReads.length).toBeGreaterThan(0));
  control.readsHeld = false;
  for (const resolve of control.heldReads.splice(0)) resolve();
  await client.rpc["auth.config"]({});
  expect(shownDuring.length).toBeGreaterThan(0);
  for (const seen of shownDuring) {
    expect(seen.session).toBe("authenticated");
    expect(seen.settings).toBe(true);
    expect(seen.harnesses).toBeGreaterThan(0);
    expect(seen.tabs).toBeGreaterThan(0);
  }
});
