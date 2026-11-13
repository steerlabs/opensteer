import { describe, expect, it } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { MachineSummary } from "@opensteer/protocol";
import { bindSessionToDevice, setUpThisDevice, type DeviceSetupPorts } from "./device-setup.js";
import { appliedSetupAccess, deviceSwitchDetail, deviceSwitches } from "./device-access.js";

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

  it("fixes Home's browser and files, and marks a switch waiting on macOS", () => {
    const client = new MockHostClient({ latencyMs: 0 });
    const home = client.getSnapshot().machines.find((entry) => entry.kind === "home")!;
    client.dispose();
    expect(deviceSwitches(home, true).map((item) => [item.capability, item.kind])).toEqual([
      ["browser", "fixed"],
      ["apps", "switch"],
      ["files", "fixed"],
    ]);
    const mac = laptop();
    const waiting = deviceSwitches(
      {
        ...mac,
        allowedModules: ["browser", "integrations", "shell"],
        fullDiskAccess: false,
        access: { ...mac.access!, policy: { ...mac.access!.policy, apps: true, reach: "owner" } },
      },
      true,
    );
    expect(waiting).toContainEqual({
      capability: "files",
      kind: "switch",
      needsMacos: true,
      on: true,
    });
  });

  it("offers Apps wherever the Host granted integrations, with macOS remedies only on a Mac", () => {
    const mac = laptop();
    const server: MachineSummary = {
      ...mac,
      kind: "server",
      allowedModules: ["integrations", "shell"],
      device: { form: "server", platform: "linux" },
      computerUse: null,
      fullDiskAccess: false,
      access: { ...mac.access!, policy: { ...mac.access!.policy, apps: true, reach: "owner" } },
    };
    const switches = deviceSwitches(server, true);
    expect(switches).toEqual([
      { capability: "apps", kind: "switch", needsMacos: false, on: true },
      { capability: "files", kind: "switch", needsMacos: false, on: true },
    ]);
    expect(deviceSwitchDetail(switches[0]!, server, false)).toBe("Apps and tools it hosts");
  });

  it("shows an older Host's Browser and Apps as always on, keeping only Files a switch", () => {
    const mac: MachineSummary = {
      ...laptop(),
      allowedModules: ["browser", "integrations", "shell"],
    };
    expect(
      deviceSwitches(mac, false).map((item) => [
        item.capability,
        item.kind === "fixed" ? item.reason : "switch",
      ]),
    ).toEqual([
      ["browser", "older-host"],
      ["apps", "older-host"],
      ["files", "switch"],
    ]);
  });

  it("reads Ready from what the Host stored, never from choices it couldn't take", () => {
    const mac = laptop();
    const chosen = { browser: true, apps: true, files: true };
    const legacy = {
      ...mac,
      access: {
        ...mac.access!,
        policy: { reach: "nobody" as const, commands: false, forwarding: false, shares: [] },
      },
    };
    expect(appliedSetupAccess({ machine: legacy, chosen, devicesAvailable: false })).toEqual({
      browser: true,
      apps: true,
      files: false,
    });
    expect(appliedSetupAccess({ machine: null, chosen, devicesAvailable: false })).toBeNull();
    expect(appliedSetupAccess({ machine: null, chosen, devicesAvailable: true })).toBe(chosen);
  });
});
