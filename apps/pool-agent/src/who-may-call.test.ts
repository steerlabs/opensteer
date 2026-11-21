/**
 * Who may call, and deleted slots (pool-agent-review-state-sol.md, findings 2, 5, 9 and the lead's own).
 * Each test was written against 5f37312fb and failed there for the reason the review gives.
 */
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserPoolAgentRequestBytes,
  browserPoolAgentSignatureHeader,
  callBrowserPoolAgent,
  signBrowserPoolAgentBytes,
  type BrowserPoolAgentEnvelope,
} from "@opensteer/browser-runtime-core/browser-pool-agent-wire";
import { callFor, fixture, slotId, open } from "./review.test-support.js";
import { FaultyJournal, homeKeyPair, startTestPoolAgent, testGuest } from "./test-support.js";

afterEach(async () => {
  for (const agent of open.splice(0)) await agent.close().catch(() => undefined);
});

describe("finding 2: authentication and the term refer to one Home key", () => {
  it("refuses a request signed by the old key naming the new term while the key is being replaced", async () => {
    const f = await fixture({ faultyJournal: true });
    await f.call("start");
    const running = await f.status();
    const next = homeKeyPair();
    let release!: () => void;
    (f.agent.journal as FaultyJournal).holdWrites(
      new Promise<void>((resolve) => (release = resolve)),
    );
    const replacing = f.agent.agent.replaceKey({ slotId, term: 2, homeKey: next.spki });
    const pause = callFor({ ...running, term: 2 }, "pause");
    const sent = callBrowserPoolAgent(
      { url: f.agent.url, homeKey: f.home.privateKey, agentKey: f.controlKey },
      slotId,
      2,
      { op: "apply", call: pause },
    ).then(
      (reply) => reply,
      (error: unknown) => error,
    );
    await expect.poll(() => (f.agent.journal as FaultyJournal).held).toBe(1);
    release();
    (f.agent.journal as FaultyJournal).holdWrites(undefined);
    await replacing;
    expect(await sent).toBeInstanceOf(Error);
    expect(f.driver.processes.size).toBe(1);
    expect([...f.driver.processes.values()][0]!.state).toBe("running");
    expect(f.agent.agent.effects(slotId)).toEqual(["start"]);
  });
});

describe("finding 5: a deleted slot stays deleted", () => {
  it("refuses a call queued behind the delete and writes nothing for it", async () => {
    const f = await fixture();
    const stop = callFor(await f.status(), "stop");
    let release!: () => void;
    f.driver.gate("kill", new Promise<void>((resolve) => (release = resolve)));
    const deleting = f.agent.agent.deleteSlot(slotId);
    await expect.poll(() => f.driver.operations.includes(`kill:${slotId}`)).toBe(true);
    const queued = f.agent.agent.apply(stop).then(
      (result) => result,
      (error: unknown) => error,
    );
    release();
    f.driver.gate("kill", undefined);
    expect(await deleting).toBe(true);
    expect(await queued).toBeInstanceOf(Error);
    await f.restart();
    expect(f.agent.agent.slotIds()).not.toContain(slotId);
  });

  it("creates one slot for a repeated or concurrent create of one id", async () => {
    const t = await startTestPoolAgent();
    open.push(t);
    const home = homeKeyPair();
    const input = { slotId: "slot-twice", term: 1, homeKey: home.spki, guest: testGuest };
    const [one, two] = await Promise.all([t.agent.createSlot(input), t.agent.createSlot(input)]);
    expect(two.controlKey).toBe(one.controlKey);
    expect((await t.agent.createSlot(input)).controlKey).toBe(one.controlKey);
    const restarted = await t.restart();
    open.splice(open.indexOf(t), 1, restarted);
    expect(restarted.agent.summaries().find((s) => s.slotId === "slot-twice")?.controlKey).toBe(
      one.controlKey,
    );
  });
});

describe("finding 9: a stored answer is bound to the term that authenticated it", () => {
  it("refuses a previous term's call even when its id has a stored answer", async () => {
    const f = await fixture();
    const start = callFor(await f.status(), "start");
    const endpoint = { url: f.agent.url, homeKey: f.home.privateKey, agentKey: f.controlKey };
    await callBrowserPoolAgent(endpoint, slotId, 1, { op: "apply", call: start });
    // The same Home key, a higher term: the provisioner fenced the previous term.
    await f.agent.agent.replaceKey({ slotId, term: 2, homeKey: f.home.spki });
    await expect(
      callBrowserPoolAgent(endpoint, slotId, 1, { op: "apply", call: start }),
    ).rejects.toThrow();
  });
});

describe("the lead's finding: an unknown slot reads like a bad signature", () => {
  it("answers an unknown slot exactly as it answers a request it cannot authenticate", async () => {
    const f = await fixture();
    const post = async (envelope: BrowserPoolAgentEnvelope, key: KeyObject) => {
      const response = await fetch(`${f.agent.url}/v1`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [browserPoolAgentSignatureHeader]: signBrowserPoolAgentBytes(
            browserPoolAgentRequestBytes(envelope),
            key,
          ),
        },
        body: JSON.stringify(envelope),
      });
      return { status: response.status, body: await response.text() };
    };
    const envelope = (id: string): BrowserPoolAgentEnvelope => ({
      v: 1,
      slotId: id,
      term: 1,
      issuedAt: new Date().toISOString(),
      nonce: randomUUID(),
      request: { op: "status" },
    });
    const stranger = generateKeyPairSync("ed25519").privateKey;
    const unknown = await post(envelope("slot-nobody"), stranger);
    const forged = await post(envelope(slotId), stranger);
    expect(unknown).toEqual(forged);
    expect(unknown.status).toBe(401);
  });
});

describe("deleted slots", () => {
  it("leaves only a tombstone for a deleted slot, not a live record", async () => {
    const f = await fixture();
    await f.agent.agent.deleteSlot(slotId);
    const names = await readdir(join(f.agent.directory, "journal"));
    await f.restart();
    expect(f.agent.agent.slotIds()).not.toContain(slotId);
    expect(names.length).toBeLessThanOrEqual(1);
  });
});
