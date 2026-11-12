import { expect, it } from "vitest";
import { createId } from "@opensteer/core";
import { MockHostClient } from "./mock-host-client.js";

it("preserves disabled switches when a legacy editor saves folders", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const machine = client
      .getSnapshot()
      .machines.find((entry) => entry.access && entry.ownership === "mine")!;
    const access = machine.access!;
    await client.updateMachineAccess({
      runnerId: machine.id,
      expectedRevision: access.revision,
      policy: { ...access.policy, browser: false, apps: false },
    });
    const { browser: _browser, apps: _apps, ...legacy } = access.policy;
    await client.updateMachineAccess({
      runnerId: machine.id,
      expectedRevision: access.revision + 1,
      policy: legacy,
    });
    expect(
      client.getSnapshot().machines.find((entry) => entry.id === machine.id)?.access?.policy,
    ).toMatchObject({ browser: false, apps: false });
  } finally {
    client.dispose();
  }
});
it("binds a session idempotently and refuses a different device", async () => {
  const at = "2026-11-12T12:00:00Z";
  const client = new MockHostClient({
    latencyMs: 0,
    sessions: [
      {
        id: createId("authSession"),
        deviceId: null,
        current: true,
        deviceLabel: "Opensteer for Mac",
        form: "computer",
        absoluteExpiresAt: at,
        createdAt: at,
        expiresAt: at,
        lastSeenAt: at,
      },
    ],
  });
  try {
    const machines = client.getSnapshot().machines.filter((entry) => entry.revocable);
    const proof = { issuedAt: at, signature: "a".repeat(86) };
    await client.bindDeviceSession({ machineId: machines[0]!.id, proof });
    await client.bindDeviceSession({ machineId: machines[0]!.id, proof });
    const sessions = await client.rpc["sessions.list"]({});
    if (!sessions.ok) throw new Error(sessions.error.message);
    expect(sessions.data.sessions[0]?.deviceId).toBe(machines[0]!.id);
    await expect(client.bindDeviceSession({ machineId: machines[1]!.id, proof })).rejects.toThrow(
      "already bound",
    );
  } finally {
    client.dispose();
  }
});
