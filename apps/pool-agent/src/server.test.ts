import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import {
  browserPoolAgentAdminBytes,
  browserPoolAgentRequestBytes,
  browserPoolAgentSignatureHeader,
  signBrowserPoolAgentBytes,
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

it("lets only the provisioner's key administer slots", async () => {
  const f = await fixture();
  const provisioner = generateKeyPairSync("ed25519");
  const server = createAdminServer({ agent: f.agent.agent, provisionerKey: provisioner.publicKey });
  const address = (await listen(server, { host: "127.0.0.1", port: 0 })) as AddressInfo;
  open.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const admin = (envelope: BrowserPoolAgentAdminEnvelope, key = provisioner.privateKey) =>
    fetch(`http://127.0.0.1:${address.port}/v1`, {
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
  const create: BrowserPoolAgentAdminEnvelope = {
    v: 1,
    issuedAt: new Date().toISOString(),
    nonce: randomUUID(),
    request: {
      op: "create",
      slotId: "slot-new",
      term: 1,
      homeKey: homeKeyPair().spki,
      guest: testGuest,
    },
  };
  expect((await admin(create, f.home.privateKey)).status).toBe(401);
  const created = await admin(create);
  expect(await created.json()).toMatchObject({
    reply: { op: "create", slot: { slotId: "slot-new", term: 1 } },
  });
  const again = await admin({ ...create, nonce: randomUUID() });
  expect(await again.json()).toMatchObject({ reply: { op: "create" } });
  const deleted = await admin({
    v: 1,
    issuedAt: new Date().toISOString(),
    nonce: randomUUID(),
    request: { op: "delete", slotId: "slot-new" },
  });
  expect(await deleted.json()).toMatchObject({ reply: { op: "delete", erased: true } });
});
