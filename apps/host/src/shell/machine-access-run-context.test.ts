import { createId, type RunnerId } from "@opensteer/core";
import type { ReachableMachineRecord } from "@opensteer/database";
import { machineAccessMaxMachines, runnerCommandMaxSerializedBytes } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { computeMachineAccess } from "./machine-access-run-context.js";

const hostPublicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGb1S7cXG0hsUv0pTQMiPBlAcCu4KvBvWs5R+dBDvOyW";

function machine(input: {
  readonly name: string;
  readonly runnerId?: RunnerId;
  readonly shares?: number;
}): ReachableMachineRecord {
  return {
    commands: true,
    forwarding: false,
    fullDiskAccess: false,
    hostPublicKey,
    lastSeenAt: new Date("2026-09-13T10:00:00.000Z"),
    name: input.name,
    platform: "darwin",
    runnerId: input.runnerId ?? createId("runner"),
    shares: Array.from({ length: input.shares ?? 1 }, (_, index) => ({
      mode: "read" as const,
      path: `/Users/person/${"share".repeat(40)}/${index}`,
    })),
  };
}

function computeFor(
  machines: readonly ReachableMachineRecord[],
  options: {
    readonly connected?: (runnerId: RunnerId) => boolean;
    readonly overheadBytes?: number;
    readonly callerMachineName?: string;
  } = {},
) {
  const listReachableMachines = vi.fn(async () => machines);
  return {
    context: computeMachineAccess({
      callerMachineName: options.callerMachineName ?? "cloud-1",
      callerRunnerId: createId("runner"),
      requestedBy: createId("user"),
      runners: { isRunnerConnected: options.connected ?? (() => true) },
      serializedCommandBytes: (access) =>
        (options.overheadBytes ?? 0) + new TextEncoder().encode(JSON.stringify(access)).byteLength,
      store: { listReachableMachines } as never,
    }),
    listReachableMachines,
  };
}

describe("machineAccess run context", () => {
  it("names each computer, allocating aliases deterministically and marking who is online", async () => {
    const offline = machine({ name: "Build Box" });
    const { context } = computeFor(
      [machine({ name: "Example Mac" }), offline, machine({ name: "Example Mac" })],
      {
        connected: (runnerId) => runnerId !== offline.runnerId,
      },
    );

    const resolved = await context;

    expect(resolved?.callerMachineName).toBe("cloud-1");
    expect(resolved?.omittedMachines).toBe(0);
    expect(resolved?.machines.every((entry) => entry.fullDiskAccess === false)).toBe(true);
    expect(resolved?.machines.map((entry) => entry.alias).sort()).toEqual([
      "build-box",
      "example-mac",
      "example-mac-2",
    ]);
    expect(resolved?.machines.find((entry) => entry.runnerId === offline.runnerId)?.status).toBe(
      "offline",
    );
    expect(resolved?.machines.every((entry) => entry.status === "online")).toBe(false);
  });

  it("lists at most the machine cap and counts the rest, choosing by name", async () => {
    // Enrolled in the opposite order from their names, so a selection that read
    // ids would keep a different set entirely.
    const machines = Array.from({ length: machineAccessMaxMachines + 5 }, (_, index) =>
      machine({
        name: `box-${(machineAccessMaxMachines + 4 - index).toString().padStart(2, "0")}`,
      }),
    );

    const resolved = await computeFor(machines).context;

    expect(resolved?.machines).toHaveLength(machineAccessMaxMachines);
    expect(resolved?.omittedMachines).toBe(5);
    expect(resolved?.machines.map((entry) => entry.name)).toEqual(
      Array.from(
        { length: machineAccessMaxMachines },
        (_, index) => `box-${index.toString().padStart(2, "0")}`,
      ),
    );
  });

  it("drops whole computers until the Run command itself fits, and counts those too", async () => {
    // The Thread history this command already carries leaves room for only a
    // few machines, so the list yields rather than the command overflowing.
    const machines = Array.from({ length: 12 }, (_, index) =>
      machine({ name: `box-${index}`, shares: 30 }),
    );
    const perMachineBytes = new TextEncoder().encode(
      JSON.stringify({ callerMachineName: "cloud-1", machines: [machines[0]], omittedMachines: 0 }),
    ).byteLength;

    const resolved = await computeFor(machines, {
      overheadBytes: runnerCommandMaxSerializedBytes - perMachineBytes * 4,
    }).context;

    expect(resolved).not.toBeNull();
    expect(resolved && resolved.machines.length).toBeLessThan(12);
    expect(resolved && resolved.machines.length + resolved.omittedMachines).toBe(12);
  });
  it.each(["Alex's Mac", "Linux cloud Runner"])(
    "preserves %s when the command has room only for the named context",
    async (callerMachineName) => {
      const minimal = { callerMachineName, machines: [], omittedMachines: 1 };
      const overheadBytes =
        runnerCommandMaxSerializedBytes - Buffer.byteLength(JSON.stringify(minimal), "utf8");
      const resolved = await computeFor([machine({ name: "Other Mac" })], {
        callerMachineName,
        overheadBytes,
      }).context;
      expect(resolved).toEqual(minimal);
      expect(overheadBytes + Buffer.byteLength(JSON.stringify(resolved), "utf8")).toBe(
        runnerCommandMaxSerializedBytes,
      );
    },
  );
});
