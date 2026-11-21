import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  browserPoolAgentAdminBytes,
  browserPoolAgentRequestBytes,
  browserPoolAgentSignatureHeader,
  signBrowserPoolAgentBytes,
  callBrowserPoolAgentAdmin,
  type BrowserPoolAgentAdminEnvelope,
  type BrowserPoolAgentEnvelope,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { createAdminServer, listen } from "./server.js";
import { homeKeyPair, startTestPoolAgent, testGuest, type TestPoolAgent } from "./test-support.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function fixture() {
  const agent: TestPoolAgent = await startTestPoolAgent();
  open.push(() => agent.close());
  const home = homeKeyPair();
  const summary = await agent.agent.createSlot({
    slotId: "slot-h",
    term: 1,
    homeKey: home.spki,
    guest: testGuest,
  });
  const agentKey = createPublicKey({
    key: Buffer.from(summary.controlKey, "base64"),
    format: "der",
    type: "spki",
  });
  const post = (envelope: unknown, signature?: string) =>
    fetch(`${agent.url}/v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signature ? { [browserPoolAgentSignatureHeader]: signature } : {}),
      },
      body: JSON.stringify(envelope),
    });
  const envelope = (
    overrides: Partial<BrowserPoolAgentEnvelope> = {},
  ): BrowserPoolAgentEnvelope => ({
    v: 1,
    slotId: "slot-h",
    term: 1,
    issuedAt: new Date().toISOString(),
    nonce: randomUUID(),
    request: { op: "status" },
    ...overrides,
  });
  return { agent, home, agentKey, post, envelope };
}

it("refuses an unsigned request, one signed by another key, a stale one, and another slot's", async () => {
  const f = await fixture();
  const request = f.envelope();
  expect((await f.post(request)).status).toBe(401);
  const other = generateKeyPairSync("ed25519").privateKey;
  expect(
    (await f.post(request, signBrowserPoolAgentBytes(browserPoolAgentRequestBytes(request), other)))
      .status,
  ).toBe(401);
  const stale = f.envelope({ issuedAt: new Date(Date.now() - 10 * 60_000).toISOString() });
  const staleAnswer = await f.post(
    stale,
    signBrowserPoolAgentBytes(browserPoolAgentRequestBytes(stale), f.home.privateKey),
  );
  expect(staleAnswer.status).toBe(400);
  expect(await staleAnswer.json()).toMatchObject({ reply: { code: "stale-request" } });
  // An unknown slot is refused as unauthenticated: nobody learns which slots exist.
  const unknown = f.envelope({ slotId: "slot-x" });
  const unknownAnswer = await f.post(
    unknown,
    signBrowserPoolAgentBytes(browserPoolAgentRequestBytes(unknown), f.home.privateKey),
  );
  expect(unknownAnswer.status).toBe(401);
  expect(await unknownAnswer.json()).toMatchObject({ reply: { code: "unauthenticated" } });
  // A body changed after signing is not the request that was signed.
  const signed = f.envelope();
  const signature = signBrowserPoolAgentBytes(
    browserPoolAgentRequestBytes(signed),
    f.home.privateKey,
  );
  expect((await f.post({ ...signed, term: 2 }, signature)).status).toBe(401);
  // A call inside the envelope cannot name another slot.
  const crossed = f.envelope({
    request: {
      op: "apply",
      call: {
        id: randomUUID(),
        slotId: "slot-y",
        term: 1,
        kind: "stop",
        expect: { instance: null, epoch: null, phase: "stopped", savedStateId: null },
      },
    },
  });
  const crossedAnswer = await f.post(
    crossed,
    signBrowserPoolAgentBytes(browserPoolAgentRequestBytes(crossed), f.home.privateKey),
  );
  expect(await crossedAnswer.json()).toMatchObject({
    reply: { op: "refused", code: "bad-request" },
  });
});

async function adminFixture() {
  const f = await fixture();
  const provisioner = generateKeyPairSync("ed25519");
  const host = generateKeyPairSync("ed25519");
  const server = createAdminServer({
    agent: f.agent.agent,
    provisionerKey: provisioner.publicKey,
    hostId: "pool-host-a",
    hostKey: host.privateKey,
  });
  const address = (await listen(server, { host: "127.0.0.1", port: 0 })) as AddressInfo;
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${address.port}`;
  const send = async (envelope: BrowserPoolAgentAdminEnvelope, key = provisioner.privateKey) => {
    const response = await fetch(`${url}/v1`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [browserPoolAgentSignatureHeader]: signBrowserPoolAgentBytes(
          browserPoolAgentAdminBytes(envelope),
          key,
        ),
      },
      body: JSON.stringify(envelope),
    });
    return { status: response.status, body: (await response.json()) as { reply: { op: string } } };
  };
  const envelope = (
    request: BrowserPoolAgentAdminEnvelope["request"],
    target = "pool-host-a",
  ): BrowserPoolAgentAdminEnvelope => ({
    v: 1,
    host: target,
    issuedAt: new Date().toISOString(),
    nonce: randomUUID(),
    request,
  });
  const client = {
    url,
    provisionerKey: provisioner.privateKey,
    host: "pool-host-a",
    hostKey: host.publicKey,
  };
  return { f, send, envelope, client, host };
}

const createFor = (slotId: string, term: number) => ({
  op: "create" as const,
  slotId,
  term,
  homeKey: homeKeyPair().spki,
  guest: testGuest,
});

it("lets only the provisioner's key administer slots, and only on the host it names", async () => {
  const { f, send, envelope } = await adminFixture();
  const create = envelope(createFor("slot-new", 1));
  expect((await send(create, f.home.privateKey)).status).toBe(401);
  // Review G2: the same signed request for another host is refused there.
  expect((await send(envelope(createFor("slot-new", 1), "pool-host-b"))).status).toBe(401);
  expect((await send(create)).body).toMatchObject({
    reply: { op: "create", slot: { slotId: "slot-new", term: 1 } },
  });
  expect((await send({ ...create, nonce: randomUUID() })).body).toMatchObject({
    reply: { op: "create" },
  });
  expect((await send(envelope({ op: "delete", slotId: "slot-new", term: 1 }))).body).toMatchObject({
    reply: { op: "delete", erased: true },
  });
});

it("makes a replayed delete, create or key replacement change nothing (review G2)", async () => {
  const { f, send, envelope } = await adminFixture();
  const first = envelope(createFor("slot-1", 1));
  await send(first);
  const firstDelete = envelope({ op: "delete", slotId: "slot-1", term: 1 });
  await send(firstDelete);
  // Recreated at a higher term, as the provisioner must after a delete.
  expect((await send(envelope(createFor("slot-1", 1)))).body).toMatchObject({
    reply: { op: "refused", code: "conflict" },
  });
  const recreated = await send(envelope(createFor("slot-1", 2)));
  expect(recreated.body).toMatchObject({ reply: { op: "create", slot: { term: 2 } } });
  const before = f.agent.agent.summaries().find((slot) => slot.slotId === "slot-1");
  // The earlier requests, replayed byte for byte inside their window.
  expect((await send(firstDelete)).body).toMatchObject({ reply: { op: "refused" } });
  expect((await send(first)).body).toMatchObject({ reply: { op: "refused" } });
  expect(
    (
      await send(
        envelope({ op: "replace-key", slotId: "slot-1", term: 2, homeKey: homeKeyPair().spki }),
      )
    ).body,
  ).toMatchObject({ reply: { op: "refused" } });
  const after = f.agent.agent.summaries().find((slot) => slot.slotId === "slot-1");
  expect(after).toEqual(before);
});

it("signs every administration reply with the host key the provisioner pinned", async () => {
  const { client, host } = await adminFixture();
  expect(await callBrowserPoolAgentAdmin(client, { op: "list" })).toMatchObject({ op: "list" });
  const impostor = generateKeyPairSync("ed25519").publicKey;
  await expect(
    callBrowserPoolAgentAdmin({ ...client, hostKey: impostor }, { op: "list" }),
  ).rejects.toThrow("host key");
  // A reply changed on the way (a substituted control key, a forged "erased") is refused.
  const forged = {
    ...client,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const answer = await fetch(input, init);
      const body = (await answer.json()) as { reply: Record<string, unknown> };
      body.reply.slots = [];
      return new Response(JSON.stringify(body), { status: answer.status });
    },
  };
  await expect(callBrowserPoolAgentAdmin(forged, { op: "list" })).rejects.toThrow("host key");
  void host;
});
