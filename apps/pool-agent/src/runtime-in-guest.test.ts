/**
 * Our runtime in a guest (pool-runtime-in-guest.md): what the agent gives the guest at boot and
 * over vsock, and what it never puts on the command line.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { callFor, open, slotId } from "./review.test-support.js";
import { homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

const spki = () =>
  generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");

async function pooled() {
  const agent = await startTestPoolAgent({ saveAfterMs: null });
  open.push(agent);
  const home = homeKeyPair();
  const ticket = spki();
  await agent.agent.createSlot({
    slotId,
    term: 1,
    homeKey: home.spki,
    guest: testGuest,
    relayKey: spki(),
    ticketKey: { keyId: "host-v1", spki: ticket },
  });
  const call = async (kind: Parameters<typeof callFor>[1]) =>
    agent.agent.apply(callFor(await agent.agent.status(slotId, 1), kind));
  return { agent, call, ticket };
}

describe("the bridge token (decision 3)", () => {
  it("gives a new instance a new token over vsock, never on its command line", async () => {
    const f = await pooled();
    await f.call("start");
    const [first] = [...f.agent.driver.processes.keys()];
    const [token] = f.agent.driver.tokens.get(first!)!;
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    const boot = f.agent.driver.boots.at(-1)!;
    expect(JSON.stringify(boot.parameters)).not.toContain(token);
    await f.call("stop");
    await f.call("start");
    const second = [...f.agent.driver.processes.keys()].at(-1)!;
    expect(f.agent.driver.tokens.get(second)![0]).not.toBe(token);
  });

  it("gives the same instance's token again after every resume", async () => {
    const f = await pooled();
    await f.call("start");
    const jail = [...f.agent.driver.processes.keys()][0]!;
    await f.call("pause");
    await f.call("resume");
    const tokens = f.agent.driver.tokens.get(jail)!;
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toBe(tokens[0]);
  });
});

describe("the boot identity (decision 2)", () => {
  it("boots the guest with its slot, key, floor and the Home's ticket key, all public", async () => {
    const f = await pooled();
    await f.call("start");
    const parameters = f.agent.driver.boots.at(-1)!.parameters;
    expect(parameters).toMatchObject({
      "opensteer.pool.slot": slotId,
      "opensteer.pool.floor": "1.0",
      "opensteer.pool.ticket": `host-v1:${f.ticket}`,
    });
    expect(parameters["opensteer.pool.key"]).toMatch(/^[A-Za-z0-9+/=]+$/u);
  });
});
