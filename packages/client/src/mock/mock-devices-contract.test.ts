import { setPhoneUseAccess } from "../integrations/computer-use.js";
import {
  answerDeviceAccessRequest,
  applyDeviceAccess,
} from "../computers/device-access-request.js";
import { devicesView } from "../computers/devices.js";
import { expect, it } from "vitest";
import { computerTargetId } from "../host/device-projection.js";
import { DeviceIdSchema, createId } from "@opensteer/core";
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

it("retains new shell defaults underneath an initially off Files switch", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const enrollment = await client.dispatch({
      type: "runner.enrollment.createLocal",
      name: "Laptop",
      allowedModules: ["browser", "integrations", "messaging", "shell"],
      access: { browser: true, apps: true, files: false },
      idempotencyKey: crypto.randomUUID(),
    });
    if (enrollment.type !== "runner.enrollment.createLocal") throw new Error("Expected enrollment");
    const runnerId = client.connectLocalRunner(enrollment.token);
    const machine = client.getSnapshot().machines.find(({ id }) => id === runnerId)!;
    expect(machine.access!.policy).toMatchObject({
      reach: "nobody",
      commands: true,
      forwarding: true,
    });
    await client.updateMachineAccess({
      runnerId: machine.id,
      expectedRevision: 1,
      policy: { ...machine.access!.policy, reach: "owner" },
    });
    expect(
      client.getSnapshot().machines.find(({ id }) => id === machine.id)!.access!.policy,
    ).toMatchObject({ reach: "owner", commands: true, forwarding: true });
  } finally {
    client.dispose();
  }
});

it("cancels pending device Requests atomically with removal as resource-deleted", async () => {
  const client = new MockHostClient({ latencyMs: 0, devices: "seeded" });
  try {
    const request = Object.values(client.getSnapshot().requests)
      .flat()
      .find(({ kind }) => kind === "device.access")!;
    if (request.payload.kind !== "device.access") throw new Error("Expected device Request");
    const machineId = request.payload.machineId;
    const beforeCount = client
      .getSnapshot()
      .threads.find(({ id }) => id === request.originatingThreadId)!.pendingRequests;
    const observed: boolean[] = [];
    const stop = client.subscribe(() => {
      const snapshot = client.getSnapshot();
      observed.push(
        snapshot.machines.some(({ id }) => id === machineId) ||
          !Object.values(snapshot.requests)
            .flat()
            .some(({ id }) => id === request.id),
      );
    });
    await client.dispatch({
      type: "machine.revoke",
      machineId,
      idempotencyKey: crypto.randomUUID(),
    });
    stop();
    const snapshot = client.getSnapshot();
    expect(snapshot.machines.some(({ id }) => id === machineId)).toBe(false);
    expect(
      Object.values(snapshot.requests)
        .flat()
        .some(({ id }) => id === request.id),
    ).toBe(false);
    expect(snapshot.transcripts[request.originatingThreadId]).toContainEqual(
      expect.objectContaining({
        kind: "request",
        requestId: request.id,
        outcome: "Cancelled · resource-deleted",
      }),
    );
    expect(observed.every(Boolean)).toBe(true);
    expect(
      snapshot.threads.find(({ id }) => id === request.originatingThreadId)?.pendingRequests,
    ).toBe(beforeCount - 1);
  } finally {
    client.dispose();
  }
});

it("applies a retried setup's choices to a device an earlier enrollment already joined", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const machine = client
      .getSnapshot()
      .machines.find((entry) => entry.access && entry.ownership === "mine")!;
    await client.updateMachineAccess({
      runnerId: machine.id,
      expectedRevision: machine.access!.revision,
      policy: {
        ...machine.access!.policy,
        browser: true,
        apps: true,
        reach: "owner",
        commands: false,
        forwarding: false,
        shares: [{ path: "/tmp/project", mode: "read" }],
      },
    });
    const joined = client.getSnapshot().machines.find((entry) => entry.id === machine.id)!.access!;
    const chosen = { browser: false, apps: true, files: false };
    await expect(applyDeviceAccess(client, machine.id, chosen)).resolves.toEqual(chosen);
    const applied = client.getSnapshot().machines.find((entry) => entry.id === machine.id)!.access!;
    expect(applied.policy).toEqual({ ...joined.policy, browser: false, reach: "nobody" });
    await applyDeviceAccess(client, machine.id, chosen);
    expect(
      client.getSnapshot().machines.find((entry) => entry.id === machine.id)!.access!.revision,
    ).toBe(applied.revision);
  } finally {
    client.dispose();
  }
});

it("keeps a screen Device independent from its Mac across CAS detach, reattach and removal", async () => {
  const client = new MockHostClient({ latencyMs: 0, iphoneScreen: "ready" });
  try {
    const phone = client
      .getSnapshot()
      .machines.find((machine) => machine.phoneDisplay?.definitionId === "iphone-screen")!;
    const driver = phone.phoneDisplay!.driver!;
    const before = phone.access;
    const detached = await client.detachIphoneScreen({
      deviceId: phone.id,
      expectedGeneration: driver.generation,
      idempotencyKey: "detach-once",
    });
    expect(detached.generation).toBe(driver.generation + 1);
    expect(
      await client.detachIphoneScreen({
        deviceId: phone.id,
        expectedGeneration: driver.generation,
        idempotencyKey: "detach-once",
      }),
    ).toEqual(detached);
    await expect(
      client.detachIphoneScreen({ deviceId: phone.id, expectedGeneration: driver.generation }),
    ).rejects.toThrow(/changed|generation/i);
    const held = client.getSnapshot().machines.find(({ id }) => id === phone.id)!;
    expect(held.access).toEqual(before);
    expect(held.phoneDisplay?.control.reason).toEqual({ kind: "not-connected" });
    const attached = await client.attachIphoneScreen({
      driverRunnerId: driver.runnerId,
      target: {
        kind: "existing",
        deviceId: DeviceIdSchema.parse(phone.id),
        expectedGeneration: detached.generation,
      },
    });
    expect(attached.generation).toBe(detached.generation + 1);
    await client.dispatch({
      type: "machine.revoke",
      machineId: phone.id,
      idempotencyKey: "remove-phone",
    });
    expect(client.getSnapshot().machines.some(({ id }) => id === driver.runnerId)).toBe(true);
    expect(client.getSnapshot().machines.some(({ id }) => id === phone.id)).toBe(false);
    await expect(
      client.attachIphoneScreen({
        driverRunnerId: driver.runnerId,
        target: {
          kind: "existing",
          deviceId: DeviceIdSchema.parse(phone.id),
          expectedGeneration: attached.generation,
        },
      }),
    ).rejects.toThrow();
  } finally {
    client.dispose();
  }
});

it("attaches without granting access and detaches the phone when its Mac is removed", async () => {
  const client = new MockHostClient({ latencyMs: 0, iphoneScreen: "ready" });
  try {
    const existing = client
      .getSnapshot()
      .machines.find((machine) => machine.phoneDisplay?.definitionId === "iphone-screen")!;
    const driver = existing.phoneDisplay!.driver!;
    const added = await client.attachIphoneScreen({
      driverRunnerId: driver.runnerId,
      target: { kind: "new", name: "Second iPhone" },
      idempotencyKey: "new-phone",
    });
    expect(
      await client.attachIphoneScreen({
        driverRunnerId: driver.runnerId,
        target: { kind: "new", name: "Second iPhone" },
        idempotencyKey: "new-phone",
      }),
    ).toEqual(added);
    expect(
      client.getSnapshot().machines.find(({ id }) => id === added.deviceId)?.access?.policy.apps,
    ).toBe(false);
    const dashboard = await client.rpc["integrations.get"]({});
    expect(
      dashboard.ok &&
        dashboard.data.connections.some(
          ({ computer }) => computerTargetId(computer) === added.deviceId,
        ),
    ).toBe(false);
    await client.dispatch({
      type: "machine.revoke",
      machineId: driver.runnerId,
      idempotencyKey: "remove-mac",
    });
    const retained = client
      .getSnapshot()
      .machines.filter(({ id }) => id === existing.id || id === added.deviceId);
    expect(retained).toHaveLength(2);
    expect(
      retained.every((machine) => machine.phoneDisplay?.control.reason?.kind === "not-connected"),
    ).toBe(true);
  } finally {
    client.dispose();
  }
});

it("approves the phone Device without granting anything on its driver Mac", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const phone = client
      .getSnapshot()
      .machines.find((machine) => machine.phoneDisplay?.definitionId === "iphone-screen")!;
    const mac = client
      .getSnapshot()
      .machines.find(({ id }) => id === phone.phoneDisplay!.driver!.runnerId)!;
    await setPhoneUseAccess(client, phone, "read");
    const dashboard = await client.rpc["integrations.get"]({});
    if (!dashboard.ok) throw new Error(dashboard.error.message);
    expect(
      dashboard.data.connections.find(({ computer }) => computerTargetId(computer) === phone.id)
        ?.computer?.access,
    ).toBe("read");
    expect(client.getSnapshot().machines.find(({ id }) => id === mac.id)).toEqual(mac);
    expect(
      client.getSnapshot().machines.find(({ id }) => id === phone.id)?.phoneDisplay?.input.state,
    ).toBe("disabled");
    const current = client.getSnapshot().machines.find(({ id }) => id === phone.id)!;
    await client.updateMachineAccess({
      deviceId: phone.id,
      expectedRevision: current.access!.revision,
      policy: { ...current.access!.policy, apps: false },
    });
    await setPhoneUseAccess(client, current, "read-write");
    expect(
      client.getSnapshot().machines.find(({ id }) => id === phone.id)?.phoneDisplay,
    ).toMatchObject({
      control: { state: "disabled", reason: { kind: "access-off" } },
      view: { state: "ready" },
      input: { state: "ready" },
    });
  } finally {
    client.dispose();
  }
});

it("keeps canonical phone approvals working for the Android self Device", async () => {
  const client = new MockHostClient({ latencyMs: 0 });
  try {
    const phone = client.getSnapshot().machines.find((machine) => machine.kind === "agent-phone")!;
    await setPhoneUseAccess(client, phone, "read");
    const dashboard = await client.rpc["integrations.get"]({});
    if (!dashboard.ok) throw new Error(dashboard.error.message);
    expect(
      dashboard.data.connections.find(({ computer }) => computerTargetId(computer) === phone.id),
    ).toMatchObject({ definitionId: "android-phone", computer: { access: "read" } });
  } finally {
    client.dispose();
  }
});
