import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamBus } from "@opensteer/database/team-bus";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import { TeamShareOperationSchema, teamPartnerCapability } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { signHostDiscovery } from "../identity/host-keys.js";
import { TeamPartners, type TeamPartnerNetwork } from "./service.js";
import { TeamPartnerStore } from "./store.js";
import { createTeamPartnerOfferVault } from "./offer-vault.js";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.reverse()) await close();
  cleanups.length = 0;
});
async function fixture() {
  const f = await createTeamFixture();
  cleanups.push(async () => {
    await f.database.destroy();
    await f.close();
  });
  const keys = generateKeyPairSync("ed25519");
  const authority = signHostDiscovery(keys, {
    deploymentId: f.deploymentId,
    hostInstanceId: f.hostInstanceId,
    canonicalOrigin: `https://${f.deploymentId}.example`,
    hostKey: { algorithm: "Ed25519" },
    deploymentShape: { kind: "team" },
  });
  await f.database.updateTable("teamSharingSettings").set({ policy: "members" }).execute();
  const vault = createTeamPartnerOfferVault("test-secret", f.deploymentId);
  const store = new TeamPartnerStore(new TeamAccessStore(f.database), authority);
  return {
    ...f,
    keys,
    authority,
    vault,
    store,
    actor: { kind: "human" as const, userId: f.userId },
  };
}
async function setup() {
  const a = await fixture(),
    b = await fixture();
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  let blocked = false;
  const network: TeamPartnerNetwork = {
    discover: async () => ({
      kind: "team",
      apiVersion: 1,
      minimumApiVersion: 1,
      authority: a.authority,
      bootstrapMethods: [],
      capabilities: [teamPartnerCapability],
    }),
    connectSocket: async (_origin, _path, signal) => {
      if (blocked) throw new Error("Test network disconnected");
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await withTimeout(once(socket, "open"), 2000, {
        signal,
        timeoutError: () => new Error("Test partner socket never opened"),
      });
      return socket;
    },
  };
  const instances: TeamPartners[] = [];
  const buses: TeamBus[] = [];
  const make = async (f: typeof a, listen: boolean) => {
    const bus = new TeamBus(f.database);
    buses.push(bus);
    const service = new TeamPartners({
      store: new TeamPartnerStore(new TeamAccessStore(f.database), f.authority),
      keys: f.keys,
      teamName: "Test",
      bus,
      processId: randomUUID(),
      offerVault: f.vault,
      network,
      publicOnly: async () => false,
      onError: () => {},
    });
    service.setDataHandler({
      receive: async () => ({}),
      reply: async (_id, _op, send) => send(),
      connected: async () => {},
      revoked: async () => {},
      changed: async () => {},
    });
    instances.push(service);
    if (listen) server.on("connection", (socket) => service.accept(socket));
    await bus.start();
    return service;
  };
  cleanups.push(async () => {
    await Promise.all(instances.map((p) => p.close()));
    await Promise.all(buses.map((bus) => bus.close()));
  });
  const remote = await make(b, false);
  const owner = await make(a, true);
  const caller = await make(a, false);
  const offer = await a.store.createInvite(a.actor);
  const paired = await remote.redeem(b.actor, offer.offer);
  const link = await a.store.find(b.deploymentId);
  if (!link) throw new Error("Listener link was not persisted");
  await vi.waitFor(() => expect(owner.connected(link.id), "Owner never paired").toBe(true), {
    timeout: 3000,
  });
  const shareId = randomUUID();
  await a.database
    .insertInto("teamShares")
    .values({
      id: shareId,
      channelId: null,
      partnerLinkId: link.id,
      role: "follower",
      state: "active",
      generation: 1,
      name: "Shared",
      peopleOnly: false,
      offeredBy: a.userId,
      acceptedBy: a.userId,
      localApproved: true,
      endedAt: null,
      historyFromShareId: null,
    })
    .execute();
  remote.setDataHandler({
    receive: async (_id, op) => (op.op === "file" ? { bytes: randomChunk } : { answer: op.op }),
    reply: async (_id, _op, send) => send(),
    connected: async () => {},
    revoked: async () => {},
    changed: async () => {},
  });
  const op = TeamShareOperationSchema.parse({ op: "roster", shareId, generation: 1, people: [] });
  return {
    a,
    b,
    owner,
    caller,
    remote,
    link,
    op,
    make,
    offer: offer.offer,
    remoteLink: paired.link,
    blockNetwork: (value: boolean) => {
      blocked = value;
    },
  };
}
const randomChunk = randomBytes(128 * 1024).toString("base64");

it("forwards JSON and maximum-size file chunks to a socket on another copy", async () => {
  const f = await setup();
  expect(f.caller.connected(f.link.id)).toBe(false);
  expect(await f.caller.request(f.link.id, f.op)).toEqual({ answer: "roster" });
  expect(
    await f.caller.request(f.link.id, {
      op: "file",
      shareId: f.op.shareId,
      generation: 1,
      publicId: randomUUID(),
      part: "original",
      offset: 0,
    }),
  ).toEqual({ bytes: randomChunk });
  expect(await f.a.database.selectFrom("teamPartnerCalls").selectAll().execute()).toEqual([]);
  const secondDialer = await f.make(f.b, false);
  await secondDialer.start();
  await vi.waitFor(
    () =>
      expect(secondDialer.connected(f.remoteLink.id), "Second dialer never connected").toBe(true),
    { timeout: 3000 },
  );
  expect(f.remote.connected(f.remoteLink.id)).toBe(true);
  expect(await f.caller.request(f.link.id, f.op)).toEqual({ answer: "roster" });
});

it("re-reads revocation on the socket holder and refuses a queued call", async () => {
  const f = await setup();
  const id = randomUUID();
  // One transaction makes the queued work and revocation visible together.
  await f.a.database.transaction().execute(async (t) => {
    await t
      .insertInto("teamPartnerCalls")
      .values({
        id,
        linkId: f.link.id,
        operation: f.op,
        state: "queued",
        claimedBy: null,
        result: null,
        error: null,
        expiresAt: new Date(Date.now() + 5000),
      })
      .execute();
    await t
      .updateTable("teamPartnerLinks")
      .set({ state: "revoked", revokedAt: new Date() })
      .where("id", "=", f.link.id)
      .execute();
  });
  await vi.waitFor(
    () => expect(f.owner.connected(f.link.id), "Remote copy retained revoked socket").toBe(false),
    { timeout: 3000 },
  );
  const row = await f.a.database
    .selectFrom("teamPartnerCalls")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  expect(row.state).not.toBe("done");
  await expect(f.caller.request(f.link.id, f.op)).rejects.toMatchObject({ reason: "not-found" });
});

it("times out a claimed request and discards its late response", async () => {
  const f = await setup();
  const received = Promise.withResolvers<void>(),
    response = Promise.withResolvers<unknown>();
  f.remote.setDataHandler({
    receive: async () => {
      received.resolve();
      return response.promise;
    },
    reply: async (_id, _op, send) => send(),
    connected: async () => {},
    revoked: async () => {},
    changed: async () => {},
  });
  const pending = f.caller.request(f.link.id, f.op);
  const failure = expect(pending).rejects.toMatchObject({ reason: "partner-unreachable" });
  await withTimeout(received.promise, 2000, {
    timeoutError: () => new Error("Forwarded request never reached partner"),
  });
  await failure;
  response.resolve({ late: true });
  await vi.waitFor(
    async () =>
      expect(await f.a.database.selectFrom("teamPartnerCalls").selectAll().execute()).toEqual([]),
    { timeout: 2000 },
  );
});

it("opens a sealed proposal from a replacement process and clears it after pairing", async () => {
  const f = await setup();
  await f.remote.close();
  f.blockNetwork(true);
  const interrupted = await f.make(f.b, false);
  await expect(interrupted.redeem(f.b.actor, f.offer)).rejects.toThrow("Test network disconnected");
  expect((await f.b.store.get(f.remoteLink.id))?.sealedOffer).toBeInstanceOf(Buffer);
  await interrupted.close();
  f.blockNetwork(false);
  const replacement = await f.make(f.b, false);
  await replacement.start();
  await vi.waitFor(
    async () => {
      expect(
        replacement.connected(f.remoteLink.id),
        "Replacement never reopened sealed offer",
      ).toBe(true);
      expect((await f.b.store.get(f.remoteLink.id))?.sealedOffer).toBeNull();
    },
    { timeout: 3000 },
  );
});

it("refuses a queued operation after its share generation changes", async () => {
  const f = await setup();
  const id = randomUUID();
  await f.a.database.transaction().execute(async (t) => {
    await t
      .insertInto("teamPartnerCalls")
      .values({
        id,
        linkId: f.link.id,
        operation: f.op,
        state: "queued",
        claimedBy: null,
        result: null,
        error: null,
        expiresAt: new Date(Date.now() + 5000),
      })
      .execute();
    await t
      .updateTable("teamShares")
      .set({ generation: 2 })
      .where("id", "=", f.op.shareId)
      .execute();
  });
  await vi.waitFor(
    async () => {
      const row = await f.a.database
        .selectFrom("teamPartnerCalls")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(row.state, "Socket holder never refused the stale operation").toBe("failed");
      expect(row.error).toMatchObject({ reason: "not-found" });
    },
    { timeout: 2000 },
  );
});

it("re-authorizes a forwarded result before returning it to the caller", async () => {
  const f = await setup();
  f.remote.setDataHandler({
    receive: async () => {
      await f.a.database
        .updateTable("teamShares")
        .set({ generation: 2 })
        .where("id", "=", f.op.shareId)
        .execute();
      return { private: "stale result" };
    },
    reply: async (_id, _op, send) => send(),
    connected: async () => {},
    revoked: async () => {},
    changed: async () => {},
  });
  await expect(f.caller.request(f.link.id, f.op)).rejects.toMatchObject({ reason: "not-found" });
});

it("applies a sharing policy change to sockets on another copy", async () => {
  const f = await setup();
  await f.caller.setPolicy(f.a.actor, "off");
  await vi.waitFor(
    () =>
      expect(f.owner.connected(f.link.id), "Policy change left the owner socket open").toBe(false),
    { timeout: 2000 },
  );
});
