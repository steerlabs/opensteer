import { describe, expect, it } from "vitest";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentConfigSchema, readAgentConfig, refuseUnsupportedMode } from "../config.js";
import { egressRuleset, hostRuleset, resolverFile, type NetworkConfig } from "./network.js";

const config: NetworkConfig = {
  resolvers: ["8.8.8.8"],
  privateResolvers: [],
  hostUpstreams: [],
  relayUid: 990,
};

function order(ruleset: string, ...needles: string[]): number[] {
  return needles.map((needle) => {
    const at = ruleset.indexOf(needle);
    expect(at, needle).toBeGreaterThanOrEqual(0);
    return at;
  });
}

describe("review G4: the proxies' egress rules", () => {
  for (const [name, build] of [
    ["in the slot's namespace", egressRuleset],
    ["on the host", hostRuleset],
  ] as const) {
    it(`drops the blocked ranges before any public resolver is accepted (${name})`, () => {
      const rules = build(config, ["10.42.0.6"]);
      const [blocked, host, resolver] = order(
        rules,
        "ip daddr @blocked4 counter drop",
        "ip daddr { 10.42.0.6 } counter drop",
        "ip daddr { 8.8.8.8 } meta l4proto { tcp, udp } th dport 53 accept",
      );
      expect(blocked).toBeLessThan(resolver!);
      expect(host).toBeLessThan(resolver!);
    });

    it(`opens a private resolver for port 53 only because it is named (${name})`, () => {
      expect(build(config, [])).not.toContain("169.254.169.254");
      const rules = build({ ...config, privateResolvers: ["169.254.169.254"] }, []);
      const [opened, blocked] = order(
        rules,
        "ip daddr { 169.254.169.254 } meta l4proto { tcp, udp } th dport 53 accept",
        "ip daddr @blocked4 counter drop",
      );
      expect(opened).toBeLessThan(blocked!);
    });
  }

  it("scopes a host upstream to its address and port", () => {
    const upstream = { ...config, hostUpstreams: [{ address: "192.0.43.10", port: 8443 }] };
    const host = hostRuleset(upstream, []);
    expect(host).toContain('iifname "ospv*" ip daddr 192.0.43.10 tcp dport 8443 accept');
    expect(host).not.toMatch(/iifname "ospv\*" tcp dport/u);
    expect(egressRuleset(upstream, [])).toContain("ip daddr 192.0.43.10 tcp dport 8443 accept");
  });

  it("keeps the namespace filter on the proxy's own output, where a host flush cannot reach", () => {
    const rules = egressRuleset(config, []);
    expect(rules).toContain("table inet osp_egress {");
    expect(rules).toContain('oifname "eth0" jump to_world');
    expect(rules).toContain("meta nfproto ipv6 counter drop");
  });
});

const base = () => ({
  journal: "/var/lib/opensteer-pool/journal",
  listen: { host: "127.0.0.1", port: 7310 },
  admin: {
    listen: { host: "127.0.0.1", port: 7311 },
    provisionerKey: "a".repeat(60),
    hostId: "pool-host-a",
    hostKeyFile: "/etc/opensteer-pool/host-key.pem",
  },
  driver: {
    firecracker: "/opt/f",
    jailer: "/opt/j",
    images: "/srv/i",
    jailRoot: "/srv/j",
    savedRoot: "/srv/s",
    stateDirectory: "/var/d",
    arrayIdFile: "/srv/a",
    profilesRoot: "/var/p",
    credentialsRoot: "/etc/c",
    slotUidBase: 200_000,
    egressUidBase: 300_000,
    egress: { node: "/opt/n", main: "/opt/m" },
  },
});

describe("review G4: the configuration", () => {
  const parse = (network: Record<string, unknown>) =>
    agentConfigSchema.safeParse({ ...base(), driver: { ...base().driver, network } });

  it("accepts only public resolvers, and a blocked one only when named as private", () => {
    expect(parse({ resolvers: ["8.8.8.8"] }).success).toBe(true);
    expect(parse({ resolvers: ["169.254.169.254"] }).success).toBe(false);
    expect(parse({ resolvers: ["10.128.0.2"] }).success).toBe(false);
    expect(parse({ resolvers: [], privateResolvers: ["169.254.169.254"] }).success).toBe(true);
  });

  it("names a host upstream by address and port, not by port alone", () => {
    expect(parse({ resolvers: [], hostUpstreamPorts: [8443] }).success).toBe(false);
    expect(
      parse({ resolvers: [], hostUpstreams: [{ address: "192.0.43.10", port: 8443 }] }).success,
    ).toBe(true);
  });
});

describe("review G5: the guest mode", () => {
  it("runs our runtime in a guest only where the relay can reach it", () => {
    const config = agentConfigSchema.parse({
      ...base(),
      driver: { ...base().driver, network: { resolvers: [] } },
    });
    expect(() => refuseUnsupportedMode(config)).not.toThrow();
    const runtime = { ...config, driver: { ...config.driver, guestMode: "runtime" as const } };
    expect(() => refuseUnsupportedMode(runtime)).toThrow("needs the relay");
    expect(() =>
      refuseUnsupportedMode({
        ...runtime,
        driver: { ...runtime.driver, network: { ...runtime.driver.network, relayUid: 999 } },
      }),
    ).not.toThrow();
  });
});

describe("review G10: the configuration's own checks", () => {
  it("refuses overlapping uid ranges", () => {
    const config = base();
    const overlapping = {
      ...config,
      driver: { ...config.driver, egressUidBase: 205_000, network: { resolvers: [] } },
    };
    expect(agentConfigSchema.safeParse(overlapping).success).toBe(false);
    const apart = { ...config, driver: { ...config.driver, network: { resolvers: [] } } };
    expect(agentConfigSchema.safeParse(apart).success).toBe(true);
  });

  it("refuses a configuration file other users can read", async () => {
    const directory = await mkdtemp(join(tmpdir(), "osp-config-"));
    const file = join(directory, "agent.json");
    const text = JSON.stringify({
      ...base(),
      driver: { ...base().driver, network: { resolvers: [] } },
    });
    await writeFile(file, text, { mode: 0o644 });
    await expect(readAgentConfig(file)).rejects.toThrow("readable by other users");
    await chmod(file, 0o600);
    expect((await readAgentConfig(file)).driver.guestMode).toBe("bench");
  });
});

describe("re-check finding 2: the resolvers the firewall opens are the ones the proxy uses", () => {
  it("writes a private resolver into the slot's resolver file when no public one is named", () => {
    const config: NetworkConfig = {
      resolvers: [],
      privateResolvers: ["169.254.169.254"],
      hostUpstreams: [],
      relayUid: null,
    };
    expect(resolverFile(config)).toBe("nameserver 169.254.169.254\n");
    const rules = egressRuleset(config, []);
    expect(rules).toContain(
      "ip daddr { 169.254.169.254 } meta l4proto { tcp, udp } th dport 53 accept",
    );
    // Port 53 is open to nothing else.
    expect(rules.match(/dport 53 accept/g)).toHaveLength(1);
  });

  it("names private resolvers before public ones", () => {
    expect(
      resolverFile({
        resolvers: ["1.1.1.1"],
        privateResolvers: ["169.254.169.254"],
        hostUpstreams: [],
        relayUid: null,
      }),
    ).toBe("nameserver 169.254.169.254\nnameserver 1.1.1.1\n");
  });
});
