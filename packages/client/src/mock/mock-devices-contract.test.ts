import { answerDeviceAccessRequest } from "../computers/device-access-request.js";
import { devicesView } from "../computers/devices.js";
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
it("lists each seeded device once, and an older phone app's session under Also signed in", async () => {
  const client = new MockHostClient({ latencyMs: 0, devices: "seeded" });
  try {
    const sessions = await client.rpc["sessions.list"]({});
    if (!sessions.ok) throw new Error(sessions.error.message);
    const view = devicesView({
      machines: client.getSnapshot().machines,
      sessions: sessions.data.sessions,
      hereId: null,
    });
    const ids = view.devices.map((row) => row.machine.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(view.devices.filter((row) => row.machine.kind === "home")).toHaveLength(1);
    expect(view.alsoSignedIn.map((row) => [row.label, row.status])).toContainEqual([
      "Opensteer for iPhone",
      "Update to finish setup",
    ]);
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

it.each(["fulfilled", "declined"] as const)(
  "answers device access with %s through the shared client",
  async (decision) => {
    const client = new MockHostClient({ latencyMs: 0, devices: "seeded" });
    try {
      const request = Object.values(client.getSnapshot().requests)
        .flat()
        .find((entry) => entry.payload.kind === "device.access")!;
      if (request.payload.kind !== "device.access")
        throw new Error("Expected device access fixture");
      const { machineId, access } = request.payload;
      const machine = client.getSnapshot().machines.find((entry) => entry.id === machineId)!;
      const before = machine.access!;
      const result = await answerDeviceAccessRequest(client, request, decision);
      expect(
        Object.values(client.getSnapshot().requests)
          .flat()
          .find((entry) => entry.id === request.id),
      ).toBeUndefined();
      const after = client.getSnapshot().machines.find((entry) => entry.id === machineId)!.access!;
      if (decision === "fulfilled") {
        expect(result).toMatchObject({ outcome: "updated" });
        expect(after.revision).toBe(before.revision + 1);
        expect(after.policy[access === "files" ? "commands" : access]).toBe(true);
      } else expect(after).toEqual(before);
    } finally {
      client.dispose();
    }
  },
);

it("turns Files on while preserving saved folders, commands and forwarding", async () => {
  const seed = new MockHostClient({ latencyMs: 0, devices: "seeded" });
  const original = Object.values(seed.getSnapshot().requests)
    .flat()
    .find((entry) => entry.payload.kind === "device.access")!;
  seed.dispose();
  if (original.payload.kind !== "device.access") throw new Error("Expected device access fixture");
  const request = { ...original, payload: { ...original.payload, access: "files" as const } };
  const client = new MockHostClient({ latencyMs: 0, pendingRequests: [request] });
  try {
    const machine = client
      .getSnapshot()
      .machines.find((entry) => entry.id === request.payload.machineId)!;
    await client.updateMachineAccess({
      runnerId: machine.id,
      expectedRevision: machine.access!.revision,
      policy: {
        ...machine.access!.policy,
        reach: "nobody",
        commands: false,
        forwarding: false,
        shares: [{ path: "/tmp/project", mode: "read" }],
      },
    });
    const before = client.getSnapshot().machines.find((entry) => entry.id === machine.id)!.access!
      .policy;
    await answerDeviceAccessRequest(client, request, "fulfilled");
    expect(
      client.getSnapshot().machines.find((entry) => entry.id === machine.id)!.access!.policy,
    ).toEqual({ ...before, reach: "owner" });
    expect(
      Object.values(client.getSnapshot().requests)
        .flat()
        .find((entry) => entry.id === request.id),
    ).toBeUndefined();
  } finally {
    client.dispose();
  }
});
