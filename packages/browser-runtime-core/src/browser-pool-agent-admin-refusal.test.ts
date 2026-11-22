/**
 * Round G, A: the provisioner's client tells a refusal the pool host signed (it answered, and
 * refused) from no verified answer (the effect is unknown). Written against c2cc9d421, where
 * every one of them was the same bare BrowserPoolAgentUnavailable.
 */
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BrowserPoolAgentUnavailable,
  browserPoolAgentAdminBytes,
  browserPoolAgentAdminReplyBytes,
  callBrowserPoolAgentAdmin,
  signBrowserPoolAgentBytes,
  type BrowserPoolAgentAdminEnvelope,
} from "./browser-pool-agent-wire.js";

const provisioner = generateKeyPairSync("ed25519");
const host = generateKeyPairSync("ed25519");
const impostor = generateKeyPairSync("ed25519");

/** A pool host that answers every request with this reply, signed by `signer`. */
function answering(reply: unknown, signer = host.privateKey): typeof fetch {
  return (async (_url: unknown, init: { body: string }) => {
    const envelope = JSON.parse(init.body) as BrowserPoolAgentAdminEnvelope;
    const bytes = browserPoolAgentAdminBytes(envelope);
    const signature = signBrowserPoolAgentBytes(
      browserPoolAgentAdminReplyBytes(bytes, reply),
      signer,
    );
    return new Response(JSON.stringify({ reply, signature }), { status: 200 });
  }) as unknown as typeof fetch;
}

const call = (fetch: typeof globalThis.fetch) =>
  callBrowserPoolAgentAdmin(
    {
      url: "http://pool-host.invalid",
      provisionerKey: provisioner.privateKey,
      host: "pool-host-a",
      hostKey: host.publicKey,
      fetch,
    },
    { op: "delete", slotId: "slot-a", term: 3 },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );

const conflict = { op: "refused", code: "conflict", message: "another term" };

describe("a refusal the pool host signed", () => {
  it("carries its code", async () => {
    const error = await call(answering(conflict));
    expect(error).toBeInstanceOf(BrowserPoolAgentUnavailable);
    expect((error as BrowserPoolAgentUnavailable).refusal).toBe("conflict");
  });

  it("does not, when its signature is not the host's", async () => {
    const error = await call(answering(conflict, impostor.privateKey));
    expect(error).toBeInstanceOf(BrowserPoolAgentUnavailable);
    expect((error as BrowserPoolAgentUnavailable).refusal).toBeUndefined();
  });

  it("does not, when no answer came", async () => {
    const lost = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await call(lost);
    expect(error).toBeInstanceOf(Error);
    expect((error as BrowserPoolAgentUnavailable).refusal).toBeUndefined();
  });
});
