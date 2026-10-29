import { createId } from "@opensteer/core";
import {
  RunnerAuxiliaryStreamIdSchema,
  RunnerAuxiliaryWelcomeSchema,
  RunnerBootIdSchema,
  RunnerConnectionIdSchema,
  RunnerConnectionLeaseIdSchema,
  type RunnerAuxiliaryWelcome,
} from "@opensteer/protocol";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunnerAuxiliaryFenceLedger } from "./auxiliary-connection.js";

describe("RunnerAuxiliaryFenceLedger", () => {
  it("tells its owner the lease ran out instead of leaving a fence that throws", async () => {
    // Expiry is the stream ending. The ledger owns the lease, so it is the one
    // place that notices, and it says so to the owner of the transport rather
    // than waiting to throw at whichever caller stamps the next frame.
    const ledger = new RunnerAuxiliaryFenceLedger();
    const expirations: Error[] = [];
    ledger.onLeaseExpired((reason) => expirations.push(reason));
    ledger.adopt(welcome({ streamLeaseExpiresAt: 30 }));

    expect(ledger.expired).toBe(false);
    await waitFor(() => expirations.length > 0);

    expect(expirations).toHaveLength(1);
    expect(expirations[0]?.message).toBe("The auxiliary stream lease has expired");
    expect(ledger.expired).toBe(true);
  });

  it("watches a lease adopted before anyone was listening", async () => {
    // The stream adopts its welcome during the handshake and only then wires up
    // the teardown it needs; a lease that was already running must still be
    // watched from the moment there is someone to tell.
    const ledger = new RunnerAuxiliaryFenceLedger();
    ledger.adopt(welcome({ streamLeaseExpiresAt: 30 }));
    const expirations: Error[] = [];
    ledger.onLeaseExpired((reason) => expirations.push(reason));

    await waitFor(() => expirations.length > 0);
    expect(expirations).toHaveLength(1);
  });

  it("pushes expiry out when the Host renews the lease", async () => {
    const ledger = new RunnerAuxiliaryFenceLedger();
    const expirations: Error[] = [];
    ledger.onLeaseExpired((reason) => expirations.push(reason));
    ledger.adopt(welcome({ streamLeaseExpiresAt: 30 }));
    ledger.renew(new Date(Date.now() + 5_000).toISOString());

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(expirations).toEqual([]);
    expect(ledger.expired).toBe(false);
    expect(() => ledger.fence).not.toThrow();
    ledger.release();
  });

  it("stops watching a lease once the stream it fenced is gone", async () => {
    const ledger = new RunnerAuxiliaryFenceLedger();
    const expirations: Error[] = [];
    ledger.onLeaseExpired((reason) => expirations.push(reason));
    ledger.adopt(welcome({ streamLeaseExpiresAt: 30 }));
    ledger.release();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(expirations).toEqual([]);
  });

  it("refuses to stamp an expired fence on the operation path", () => {
    // The refusal still belongs somewhere: an operation that asks for a fence
    // after the lease ran out fails as that operation, not as a timer.
    const now = { value: Date.parse("2026-01-01T00:00:00.000Z") };
    const ledger = new RunnerAuxiliaryFenceLedger({ now: () => now.value });
    const adopted = ledger.adopt(
      RunnerAuxiliaryWelcomeSchema.parse({
        ...welcomeFields(),
        streamLeaseExpiresAt: new Date(now.value + 60_000).toISOString(),
      }),
    );

    expect(ledger.fence).toEqual(adopted);
    now.value += 60_001;
    expect(ledger.expired).toBe(true);
    expect(() => ledger.fence).toThrow("The auxiliary stream lease has expired");
  });
});

function welcomeFields() {
  return {
    auxiliaryStreamId: RunnerAuxiliaryStreamIdSchema.parse(`rax_${randomUUID()}`),
    bootId: RunnerBootIdSchema.parse(`rbt_${randomUUID()}`),
    connectionGeneration: 1,
    connectionId: RunnerConnectionIdSchema.parse(`rcn_${randomUUID()}`),
    connectionLeaseId: RunnerConnectionLeaseIdSchema.parse(`rls_${randomUUID()}`),
    heartbeatIntervalMs: 1_000,
    module: "shell" as const,
    runnerId: createId("runner"),
    serverTime: new Date().toISOString(),
    type: "host.auxiliary.welcome" as const,
  };
}

function welcome(options: { readonly streamLeaseExpiresAt: number }): RunnerAuxiliaryWelcome {
  return RunnerAuxiliaryWelcomeSchema.parse({
    ...welcomeFields(),
    streamLeaseExpiresAt: new Date(Date.now() + options.streamLeaseExpiresAt).toISOString(),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the auxiliary lease");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
