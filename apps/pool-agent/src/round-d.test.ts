/**
 * Round D (pool-agent-round-c-review-gemini.md, the lead's decisions). Each test was written
 * against the round C head and failed there for the reason the review gives.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
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
const nonce = () => randomBytes(16).toString("base64url");

async function slot() {
  const agent = await startTestPoolAgent({ saveAfterMs: null });
  open.push(agent);
  const keys = { home: homeKeyPair(), relay: spki(), ticket: spki() };
  await agent.agent.createSlot({
    slotId,
    term: 1,
    homeKey: keys.home.spki,
    guest: testGuest,
    relayKey: keys.relay,
    ticketKey: { keyId: "host-v1", spki: keys.ticket },
  });
  const call = async (kind: Parameters<typeof callFor>[1], term = 1) =>
    agent.agent.apply(callFor(await agent.agent.status(slotId, term), kind));
  return { agent, keys, call };
}

describe("D2: a Home's keys for a slot are one set", () => {
  it("refuses the old relay key from the replacement on, even at the new term", async () => {
    const f = await slot();
    await f.call("start");
    expect(
      f.agent.agent.authorizeRelay({ v: 1, slot: slotId, term: 1, nonce: nonce() }, f.keys.relay),
    ).toMatchObject({ ok: true });
    const next = { home: homeKeyPair(), relay: spki(), ticket: spki() };
    await f.agent.agent.replaceKey({
      slotId,
      term: 2,
      homeKey: next.home.spki,
      relayKey: next.relay,
      ticketKey: { keyId: "host-v1", spki: next.ticket },
    });
    // Knowing the next term is never enough.
    expect(
      f.agent.agent.authorizeRelay({ v: 1, slot: slotId, term: 2, nonce: nonce() }, f.keys.relay),
    ).toEqual({ ok: false, code: "refused" });
  });

  it("does not let the guest outlive a replacement: stopped, saved state gone, next start cold", async () => {
    const f = await slot();
    await f.call("start");
    await f.call("pause");
    const next = { home: homeKeyPair(), relay: spki(), ticket: spki() };
    await f.agent.agent.replaceKey({
      slotId,
      term: 2,
      homeKey: next.home.spki,
      relayKey: next.relay,
      ticketKey: { keyId: "host-v1", spki: next.ticket },
    });
    expect(await f.agent.agent.status(slotId, 2)).toMatchObject({
      phase: "stopped",
      savedState: null,
    });
    expect(f.agent.driver.images.size).toBe(0);
    expect(f.agent.driver.writers(slotId)).toBe(0);
    await f.call("start", 2);
    // The new guest boots with the new Home's ticket key.
    expect(f.agent.driver.boots.at(-1)!.parameters["opensteer.pool.ticket"]).toBe(
      `host-v1:${next.ticket}`,
    );
  });
});
