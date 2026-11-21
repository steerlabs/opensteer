import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { BrowserPoolAgentClient } from "../apps/host/src/browser/browser-pool-agent-client.js";
import {
  homeKeyPair,
  startTestPoolAgent,
  testGuest,
  type TestPoolAgent,
} from "../apps/pool-agent/src/test-support.js";

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
  return { agent, home, agentKey };
}

it("answers a request signed by the slot's Home, and signs the reply for that request", async () => {
  const f = await fixture();
  const client = new BrowserPoolAgentClient({
    url: f.agent.url,
    homeKey: f.home.privateKey,
    agentKey: f.agentKey,
  });
  expect(await client.status("slot-h", 1)).toMatchObject({ slotId: "slot-h", phase: "stopped" });
});

it("makes the client refuse a reply that is not signed by the slot's control key", async () => {
  const f = await fixture();
  const impostor = generateKeyPairSync("ed25519").publicKey;
  const client = new BrowserPoolAgentClient({
    url: f.agent.url,
    homeKey: f.home.privateKey,
    agentKey: impostor,
  });
  await expect(client.status("slot-h", 1)).rejects.toThrow("not signed by the slot");
  const forged = new BrowserPoolAgentClient({
    url: f.agent.url,
    homeKey: f.home.privateKey,
    agentKey: f.agentKey,
    fetch: async (input, init) => {
      const answer = await fetch(input, init);
      const body = (await answer.json()) as { reply: { status: { phase: string } } };
      body.reply.status.phase = "running";
      return new Response(JSON.stringify(body), { status: answer.status });
    },
  });
  await expect(forged.status("slot-h", 1)).rejects.toThrow("not signed by the slot");
});
