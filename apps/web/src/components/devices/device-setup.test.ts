import { describe, expect, it } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { bindSessionToDevice, setUpThisDevice, type DeviceSetupPorts } from "./device-setup.js";
import { deviceSwitches, switchPolicy } from "./device-access.js";

const access = { browser: true, apps: false, files: true };
const proof = { issuedAt: "2026-11-12T12:00:00Z", signature: "a".repeat(86) };

function ports(overrides: Partial<DeviceSetupPorts> = {}) {
  const calls: string[] = [];
  const value: DeviceSetupPorts = {
    remoteAccessMode: async () => "connect",
    mint: async (input) => {
      calls.push(`mint:${JSON.stringify(input.access)}`);
      return { token: "t".repeat(40) };
    },
    setUp: async () => {
      calls.push("setUp");
      return { runnerId: "rnr_1" };
    },
    bind: async (runnerId) => {
      calls.push(`bind:${runnerId}`);
    },
    ...overrides,
  };
  return { calls, value };
}

describe("setting up this Mac", () => {
  it("mints with the chosen switches, starts the Runner, then binds this session", async () => {
    const { calls, value } = ports();
    await expect(
      setUpThisDevice(value, { name: "MBP", access, devicesAvailable: true, homeName: "Mac mini" }),
    ).resolves.toEqual({ ok: true, runnerId: "rnr_1" });
    expect(calls).toEqual([`mint:${JSON.stringify(access)}`, "setUp", "bind:rnr_1"]);
  });

  it("asks an older Host for the plain enrollment and binds nothing", async () => {
    const { calls, value } = ports();
    await setUpThisDevice(value, {
      name: "MBP",
      access,
      devicesAvailable: false,
      homeName: "Mac mini",
    });
    expect(calls).toEqual(["mint:null", "setUp"]);
  });

  it("stops before minting when Home's Use from anywhere is off", async () => {
    const { calls, value } = ports({ remoteAccessMode: async () => "off" });
    await expect(
      setUpThisDevice(value, { name: "MBP", access, devicesAvailable: true, homeName: "Mac mini" }),
    ).resolves.toEqual({
      ok: false,
      cause: { kind: "use-from-anywhere", homeName: "Mac mini" },
      runnerId: null,
    });
    expect(calls).toEqual([]);
  });

  it("keeps the device it joined when only the binding failed", async () => {
    const { value } = ports({
      bind: async () => {
        throw new Error("Session is already bound to another device");
      },
    });
    await expect(
      setUpThisDevice(value, { name: "MBP", access, devicesAvailable: true, homeName: "Mac mini" }),
    ).resolves.toEqual({
      ok: false,
      cause: { kind: "bind", detail: "Session is already bound to another device" },
      runnerId: "rnr_1",
    });
  });
});

describe("binding a new sign-in", () => {
  it("binds an unbound session once and then leaves it alone", async () => {
    const client = new MockHostClient({ latencyMs: 0 });
    try {
      const machine = client.getSnapshot().machines.find((entry) => entry.kind === "computer")!;
      const signed: string[] = [];
      const bindPorts = {
        currentSession: async () => {
          const result = await client.rpc["sessions.list"]({});
          if (!result.ok) throw new Error(result.error.message);
          const current = result.data.sessions.find((session) => session.current)!;
          return { id: current.id, deviceId: current.deviceId ?? null };
        },
        sign: async (sessionId: string) => {
          signed.push(sessionId);
          return proof;
        },
        bind: (machineId: string, signedProof: typeof proof) =>
          client.bindDeviceSession({ machineId, proof: signedProof }),
      };
      const other = client
        .getSnapshot()
        .machines.find((entry) => entry.kind === "computer" && entry.id !== machine.id)!;
      // The mock's own session starts bound to its laptop, so a different Mac's binding refuses.
      await expect(bindSessionToDevice(bindPorts, other.id)).rejects.toThrow("already bound");
      await expect(bindSessionToDevice(bindPorts, machine.id)).resolves.toBe("already-bound");
      expect(signed).toHaveLength(1);
    } finally {
      client.dispose();
    }
  });
});

describe("access switches", () => {
  const laptop = () =>
    new MockHostClient({ latencyMs: 0 })
      .getSnapshot()
      .machines.find((entry) => entry.id === "rnr_33333333-3333-4333-8333-333333333333")!;

  it("writes only the switch that changed, so the Host keeps the other", () => {
    const policy = { ...laptop().access!.policy, browser: true, apps: true };
    const written = switchPolicy(policy, "browser", false);
    expect(written).toEqual({
      browser: false,
      reach: policy.reach,
      commands: policy.commands,
      forwarding: policy.forwarding,
      shares: policy.shares,
    });
    expect("apps" in written).toBe(false);
  });

  it("turns Files and commands off by reach alone, and on to the owner with commands", () => {
    const policy = { ...laptop().access!.policy, commands: false, forwarding: false };
    expect(switchPolicy(policy, "files", false)).toMatchObject({
      reach: "nobody",
      shares: policy.shares,
    });
    expect(switchPolicy({ ...policy, reach: "nobody" }, "files", true)).toMatchObject({
      reach: "owner",
      commands: true,
      forwarding: true,
      shares: policy.shares,
    });
  });

  it("fixes Home's browser and files, and marks a switch waiting on macOS", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const home = client.getSnapshot().machines.find((entry) => entry.kind === "home")!;
    client.dispose();
    expect(deviceSwitches(home).map((item) => [item.capability, item.kind])).toEqual([
      ["browser", "fixed"],
      ["apps", "switch"],
      ["files", "fixed"],
    ]);
    const mac = laptop();
    const waiting = deviceSwitches({
      ...mac,
      allowedModules: ["browser", "integrations", "shell"],
      fullDiskAccess: false,
      access: { ...mac.access!, policy: { ...mac.access!.policy, apps: true, reach: "owner" } },
    });
    expect(waiting).toContainEqual({
      capability: "files",
      kind: "switch",
      needsMacos: true,
      on: true,
    });
  });
});
