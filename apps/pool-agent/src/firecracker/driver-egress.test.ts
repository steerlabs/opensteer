/**
 * Round H, through the real driver with the host's tools replaced: on a host that pulls its
 * slots' credentials (requireEgressUpstream), no code path defines a slot's proxy without the
 * "upstream required" setting, and a proxy is defined with the upstream the slot's pulled
 * credentials name. The driver calls are the ones the agent makes at create, start, a wake from
 * memory, a wake from disk and a start after `replace-key`. Written before the setting was
 * host-wide; at create it failed (a proxy without credentials was defined without it).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** What systemd holds: each number's unit, while loaded, and what it was defined with. */
const units = new Map<
  number,
  { environment: string[]; listening: boolean; loadCredential?: string[] }
>();
const defined: string[][] = [];

vi.mock("./exec.js", () => ({
  run: async (command: string, args: readonly string[]) => {
    const index = (name: string | undefined) =>
      Number(/opensteer-pool-egress-(\d+)\./u.exec(name ?? "")?.[1]);
    if (command === "getent") return "exists\n";
    if (command === "systemctl" && args[0] === "is-active")
      return units.get(index(args[1]))?.listening ? "active\n" : "inactive\n";
    if (command === "systemctl" && args[0] === "show") {
      const unit = units.get(index(args.at(-1)));
      if (args.includes("LoadState")) return unit ? "loaded\n" : "not-found\n";
      if (args.includes("LoadCredential")) return `${(unit?.loadCredential ?? []).join(" ")}\n`;
      return `${(unit?.environment ?? []).join(" ")}\n`;
    }
    if (command === "systemctl" && args[0] === "stop") {
      for (const name of args.slice(1)) if (name.endsWith(".socket")) units.delete(index(name));
      return "";
    }
    if (command === "systemd-run") {
      defined.push([...args]);
      const unit = args.find((arg) => arg.startsWith("--unit="));
      units.set(index(unit), {
        listening: true,
        environment: args
          .filter((arg) => arg.startsWith("--setenv="))
          .map((arg) => arg.slice("--setenv=".length)),
        loadCredential: args
          .filter((arg) => arg.startsWith("--property=LoadCredential="))
          .map((arg) => arg.slice("--property=LoadCredential=".length)),
      });
      return "";
    }
    return "";
  },
  runUntil: async () => undefined,
}));

vi.mock("./network.js", async (original) => ({
  ...(await original<typeof import("./network.js")>()),
  prepareNamespace: async () => undefined,
  namespaceTablesPresent: async () => true,
  removeNamespace: async () => undefined,
}));

const { FirecrackerDriver } = await import("./driver.js");
const { sleepEgress } = await import("./egress.js");

const required = "--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true";
const upstreamOf = (args: readonly string[]) =>
  args
    .find((arg) => arg.startsWith("--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL="))
    ?.split("=")
    .at(-1) ?? null;

async function host() {
  const state = await mkdtemp(join(tmpdir(), "opensteer-pool-pull-"));
  const credentialsRoot = await mkdtemp(join(tmpdir(), "opensteer-pool-pull-credentials-"));
  const make = async () => {
    const driver = new FirecrackerDriver({
      firecracker: "/fc",
      jailer: "/jailer",
      images: "/images",
      jailRoot: "/jail",
      savedRoot: "/saved",
      stateDirectory: state,
      arrayIdFile: "/array-id",
      profilesRoot: "/profiles",
      credentialsRoot,
      slotUidBase: 200_000,
      egressUidBase: 300_000,
      egress: { node: "/node", main: "/main.js" },
      network: { resolvers: [], hostUpstreams: [] } as never,
      guestMode: "runtime",
      requireEgressUpstream: true,
    });
    await driver.openSlotNumbers();
    return driver;
  };
  return { make, driver: await make() };
}

const credentials = {
  upstreamUrl: "https://upstream.example:8443",
  username: "u-1",
  password: "the password",
};

beforeEach(() => {
  units.clear();
  defined.length = 0;
});

afterEach(() => {
  // Whatever the case: every proxy this file saw defined requires an upstream.
  for (const args of defined) expect(args).toContain(required);
});

describe("a pulling host's slot proxies always require an upstream", () => {
  it("at create, before any credentials: required, no upstream", async () => {
    const { driver } = await host();
    await driver.prepareSlot("bps-a", undefined);
    expect(defined).toHaveLength(1);
    expect(upstreamOf(defined[0]!)).toBeNull();
  });

  it("at start, once credentials are pulled: defined again with their upstream", async () => {
    const { driver } = await host();
    await driver.prepareSlot("bps-a", undefined);
    await driver.writePulledEgress("bps-a", credentials);
    expect(await driver.reviveProxy("bps-a", undefined)).toBe(true);
    expect(defined).toHaveLength(2);
    expect(upstreamOf(defined[1]!)).toBe(credentials.upstreamUrl);
    expect(defined[1]).toContain("--use-system-ca");
    // A start with nothing changed defines nothing.
    expect(await driver.reviveProxy("bps-a", undefined)).toBe(false);
    expect(defined).toHaveLength(2);
  });

  it("at a wake from memory whose proxy tripped: defined again, required", async () => {
    const { driver } = await host();
    await driver.writePulledEgress("bps-a", credentials);
    await driver.prepareSlot("bps-a", undefined);
    units.delete(0);
    expect(await driver.reviveProxy("bps-a", undefined)).toBe(true);
    expect(upstreamOf(defined.at(-1)!)).toBe(credentials.upstreamUrl);
  });

  it("at a wake from disk after a host reboot: defined from the pulled credentials", async () => {
    const h = await host();
    await h.driver.writePulledEgress("bps-a", credentials);
    await h.driver.prepareSlot("bps-a", undefined);
    // The host restarted: no unit survives, and a new agent's driver knows nothing cached.
    units.clear();
    const after = await h.make();
    await after.prepareSlot("bps-a", undefined);
    await after.reviveProxy("bps-a", undefined);
    expect(defined.map(upstreamOf)).toEqual([credentials.upstreamUrl, credentials.upstreamUrl]);
  });

  it("at a start after replace-key, and over a unit an earlier agent defined without it", async () => {
    const h = await host();
    await h.driver.writePulledEgress("bps-a", credentials);
    await h.driver.prepareSlot("bps-a", undefined);
    // replace-key ends the guest: its proxy process stops, its unit stays.
    await sleepEgress(0);
    // A new agent finds the unit as an earlier agent left it, without the setting.
    units.set(0, {
      listening: true,
      environment: [`OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL=${credentials.upstreamUrl}`],
    });
    const after = await h.make();
    await after.prepareSlot("bps-a", undefined);
    expect(await after.reviveProxy("bps-a", undefined)).toBe(true);
    expect(units.get(0)!.environment).toContain("OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true");
  });

  // Round I, U3: a unit is the slot's own only as this host defines it, credential sources too.
  it("defines again a unit with the same upstream that loads its credentials from elsewhere", async () => {
    const h = await host();
    await h.driver.writePulledEgress("bps-a", credentials);
    await h.driver.prepareSlot("bps-a", undefined);
    // A new agent finds the unit required, with the same upstream, but other credential files.
    const unit = units.get(0)!;
    unit.loadCredential = ["username:/etc/elsewhere/u", "password:/etc/elsewhere/p"];
    const after = await h.make();
    await after.prepareSlot("bps-a", undefined);
    expect(await after.proxyRequiresUpstream("bps-a")).toBe(false);
    expect(await after.reviveProxy("bps-a", undefined)).toBe(true);
    expect(units.get(0)!.loadCredential!.join(" ")).toContain("slot-");
    // As the host defines it, it is the slot's own, and stays as it is.
    const again = await h.make();
    await again.prepareSlot("bps-a", undefined);
    expect(await again.proxyRequiresUpstream("bps-a")).toBe(true);
    expect(await again.reviveProxy("bps-a", undefined)).toBe(false);
  });
});
