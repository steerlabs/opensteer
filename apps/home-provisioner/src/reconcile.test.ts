import {
  CloudComputerDesiredSchema,
  CloudComputerIdentitySchema,
  CloudComputerReportSchema,
  type CloudComputerDesired,
  type CloudComputerId,
  type CloudComputerReport,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import { RemoteRequestError } from "./http.js";
import type { AccountApi } from "./account.js";
import type { Addresses, CreateVm, DnsProvider, VmProvider, VmServer } from "./provider.js";
import { Reconciler } from "./reconcile.js";

const home = CloudComputerDesiredSchema.parse({
  id: "cc_00000000-0000-4000-8000-000000000001",
  generation: 1,
  hostname: "home-1.example.com",
  state: "active",
  region: null,
  serverType: null,
  release: {
    version: "1",
    installerUrl: "https://example.com/home.sh",
    installerSha256: "a".repeat(64),
  },
  bootstrapToken: "boot_token",
});
const second = CloudComputerDesiredSchema.parse({
  ...home,
  id: "cc_00000000-0000-4000-8000-000000000002",
  hostname: "home-2.example.com",
});
const identity = CloudComputerIdentitySchema.parse({
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
});
const changed = CloudComputerIdentitySchema.parse({
  ...identity,
  hostKeyFingerprint: `sha256:${"b".repeat(43)}`,
});

function harness({ concurrency = 2 } = {}) {
  const reports: CloudComputerReport[] = [];
  const calls: string[] = [];
  const servers = new Map<number, VmServer & { home: CloudComputerId }>();
  const records = new Map<string, Addresses>();
  let nextId = 1;
  const put = (computer: CloudComputerDesired, status: VmServer["status"]) => {
    const id = nextId++;
    const server = {
      id,
      generation: computer.generation,
      status,
      home: computer.id,
      ipv4: `192.0.2.${id}`,
      ipv6: null,
      firewalls: [{ id: 100, status: "applied" as const }],
    };
    servers.set(id, server);
    return server;
  };
  const provider = {
    ensureFirewall: vi.fn(async () => {
      calls.push("firewall");
      return 100;
    }),
    ensureFirewallAttached: vi.fn(async () => true),
    find: vi.fn(async (id: CloudComputerId) =>
      [...servers.values()].filter((server) => server.home === id),
    ),
    create: vi.fn(async (input: CreateVm) => {
      calls.push(`create:${input.generation}`);
      return put({ ...home, id: input.id, generation: input.generation }, "off");
    }),
    describe: vi.fn(async (id: number) => servers.get(id)),
    powerOn: vi.fn(async (id: number) => {
      calls.push(`powerOn:${id}`);
      const server = servers.get(id)!;
      expect(
        [...servers.values()].filter(
          (other) => other.home === server.home && other.status === "running",
        ),
      ).toEqual([]);
      servers.set(id, { ...server, status: "running" });
    }),
    powerOff: vi.fn(async (id: number) => {
      calls.push(`powerOff:${id}`);
      servers.set(id, { ...servers.get(id)!, status: "off" });
    }),
    delete: vi.fn(async (id: number) => {
      calls.push(`delete:${id}`);
      servers.delete(id);
    }),
  } satisfies VmProvider;
  const dns = {
    ensureRecords: vi.fn(async (hostname: string, addresses: Addresses) => {
      calls.push("dns");
      records.set(hostname, addresses);
    }),
    removeRecords: vi.fn(async (hostname: string) => {
      calls.push("removeDns");
      records.delete(hostname);
    }),
  } satisfies DnsProvider;
  const status = {
    desired: [home],
    identity: identity as typeof identity | undefined,
    now: 10,
  };
  const account: AccountApi = {
    desired: vi.fn(async () => status.desired),
    report: vi.fn(async (report) => {
      reports.push(CloudComputerReportSchema.parse(report));
    }),
  };
  const setup = () =>
    new Reconciler({
      account,
      provider,
      dns,
      discover: async () => status.identity,
      accountOrigin: new URL("https://account.example.com"),
      image: "ubuntu-24.04",
      defaultRegion: "ash",
      defaultServerType: "cpx22",
      concurrency,
      readinessTimeoutMs: 1000,
      now: () => status.now,
    });
  const reconciler = setup();
  const signal = new AbortController().signal;
  return {
    calls,
    put,
    provider,
    dns,
    records,
    servers,
    account,
    status,
    reports,
    pass: () => reconciler.pass(signal),
    restart: () => setup().pass(signal),
    last: () => reports.at(-1),
  };
}
type Harness = ReturnType<typeof harness>;

describe("Cloud Computer reconciliation", () => {
  const cases: { name: string; run(h: Harness): Promise<void> }[] = [
    {
      name: "creates a fresh VM",
      async run(h) {
        await h.pass();
        expect(h.calls).toEqual(["firewall", "create:1", "powerOn:1", "dns"]);
        expect(h.last()).toMatchObject({
          phase: "ready",
          observedIdentity: identity,
          providerServerId: 1,
        });
        expect(h.provider.create.mock.calls[0]?.[0]).toMatchObject({
          region: "ash",
          serverType: "cpx22",
        });
      },
    },
    {
      name: "finds the original VM after a lost create response",
      async run(h) {
        h.provider.create.mockImplementationOnce(async () => {
          h.put(home, "off");
          throw new Error("Lost response with boot_token");
        });
        await h.pass();
        expect(h.last()).toMatchObject({
          phase: "failed",
          lastError: "The Cloud Computer provider operation failed.",
        });
        await h.restart();
        expect(h.provider.create).toHaveBeenCalledTimes(1);
        expect(h.last()?.phase).toBe("ready");
      },
    },
    {
      name: "powers on an existing VM without a token",
      async run(h) {
        h.status.desired = [{ ...home, bootstrapToken: undefined }];
        h.put(home, "off");
        await h.pass();
        expect(h.calls).toEqual(["firewall", "powerOn:1", "dns"]);
        expect(h.last()?.phase).toBe("ready");
      },
    },
    {
      name: "repairs DNS drift",
      async run(h) {
        const server = h.put(home, "running");
        h.records.set(home.hostname, { ipv4: "192.0.2.100", ipv6: "2001:db8::1" });
        await h.pass();
        expect(h.records.get(home.hostname)).toEqual({ ipv4: server.ipv4, ipv6: null });
      },
    },
    {
      name: "keeps the VM on readiness timeout",
      async run(h) {
        h.status.identity = undefined;
        await h.pass();
        expect(h.last()?.phase).toBe("booting");
        h.status.now += 1000;
        await h.pass();
        await h.pass();
        expect(h.last()).toMatchObject({
          phase: "failed",
          lastError: "The Cloud Computer did not become ready before its deadline.",
        });
        expect(h.provider.create).toHaveBeenCalledTimes(1);
        expect(h.provider.delete).not.toHaveBeenCalled();
        expect(h.reports).toHaveLength(2);
      },
    },
    {
      name: "keeps an expired initial deadline visible across restart",
      async run(h) {
        h.status.identity = undefined;
        h.status.desired = [{ ...home, readinessStartedAt: new Date(h.status.now).toISOString() }];
        await h.pass();
        h.status.now += 1000;
        await h.restart();
        expect(h.last()).toMatchObject({
          phase: "failed",
          lastError: "The Cloud Computer did not become ready before its deadline.",
        });
        expect(h.provider.create).toHaveBeenCalledTimes(1);
      },
    },
    {
      name: "reports changed identity and retains the first identity",
      async run(h) {
        await h.pass();
        h.status.identity = changed;
        await h.pass();
        expect(h.last()).toMatchObject({
          phase: "failed",
          observedIdentity: identity,
          lastError: "The Cloud Computer reported a different Home identity for this generation.",
        });
        h.status.desired = [{ ...home, observedIdentity: identity }];
        await h.restart();
        expect(h.last()).toMatchObject({ phase: "failed", observedIdentity: identity });
      },
    },
    {
      name: "replaces a generation without double-serving",
      async run(h) {
        h.put(home, "running");
        h.status.desired = [{ ...home, generation: 2 }];
        await h.pass();
        expect(h.calls).toEqual(["firewall", "create:2", "delete:1", "powerOn:2", "dns"]);
        expect(h.last()).toMatchObject({ phase: "ready", generation: 2, providerServerId: 2 });
      },
    },
    {
      name: "keeps the old VM when a replacement has no token",
      async run(h) {
        h.put(home, "running");
        h.status.desired = [{ ...home, generation: 2, bootstrapToken: undefined }];
        await h.pass();
        expect(h.calls).toEqual([]);
        expect(h.last()).toMatchObject({
          phase: "failed",
          lastError: "A bootstrap token is required to create this Cloud Computer.",
        });
      },
    },
    {
      name: "blocks fresh creation with no bootstrap token",
      async run(h) {
        h.status.desired = [{ ...home, bootstrapToken: undefined }];
        await h.pass();
        expect(h.provider.create).not.toHaveBeenCalled();
        expect(h.last()?.phase).toBe("failed");
      },
    },
    {
      name: "suspends and resumes the same VM, DNS and identity",
      async run(h) {
        await h.pass();
        const addresses = h.records.get(home.hostname);
        h.status.desired = [{ ...home, state: "suspended", bootstrapToken: undefined }];
        await h.pass();
        expect(h.servers.get(1)?.status).toBe("off");
        expect(h.records.get(home.hostname)).toEqual(addresses);
        expect(h.last()).toMatchObject({ phase: "suspended", observedIdentity: identity });
        h.status.desired = [{ ...home, bootstrapToken: undefined }];
        await h.pass();
        expect(h.servers.get(1)?.status).toBe("running");
        expect(h.last()).toMatchObject({
          phase: "ready",
          providerServerId: 1,
          observedIdentity: identity,
        });
      },
    },
    {
      name: "reports a tombstone after delete is confirmed",
      async run(h) {
        const server = h.put(home, "running");
        h.status.desired = [{ ...home, state: "deleted", bootstrapToken: undefined }];
        h.provider.delete.mockImplementationOnce(async (id) => {
          h.calls.push(`delete:${id}`);
        });
        await h.pass();
        expect(h.last()?.phase).toBe("deleting");
        await h.restart();
        expect(h.calls).toEqual(["removeDns", "delete:1", "removeDns", "delete:1"]);
        expect(h.provider.describe).toHaveBeenLastCalledWith(server.id, expect.any(AbortSignal));
        expect(h.last()).toMatchObject({
          phase: "deleted",
          providerServerId: null,
          ipv4: null,
          observedIdentity: null,
        });
      },
    },
    {
      name: "removes DNS and tombstones an already absent VM",
      async run(h) {
        h.status.desired = [{ ...home, state: "deleted", bootstrapToken: undefined }];
        await h.pass();
        expect(h.calls).toEqual(["removeDns"]);
        expect(h.last()?.phase).toBe("deleted");
      },
    },
    {
      name: "isolates provider errors to one Cloud Computer",
      async run(h) {
        h.status.desired = [home, second];
        h.provider.find.mockRejectedValueOnce(new Error("provider secret"));
        await h.pass();
        expect(h.reports).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: home.id,
              phase: "failed",
              lastError: "The Cloud Computer provider operation failed.",
            }),
            expect.objectContaining({ id: second.id, phase: "ready" }),
          ]),
        );
      },
    },
    {
      name: "leaves a provider generation newer than desired alone",
      async run(h) {
        h.put({ ...home, generation: 2 }, "running");
        h.status.desired = [{ ...home, state: "deleted", bootstrapToken: undefined }];
        await h.pass();
        expect(h.calls).toEqual([]);
        expect(h.last()?.phase).toBe("failed");
      },
    },
    {
      name: "deduplicates acknowledged reports",
      async run(h) {
        await h.pass();
        await h.pass();
        expect(h.reports).toHaveLength(1);
      },
    },
  ];
  it.each(cases)("$name", ({ run }) => run(harness()));

  it.each([401, 403])(
    "aborts on Account HTTP %i before scheduling another home",
    async (status) => {
      const h = harness({ concurrency: 1 });
      h.status.desired = [home, second];
      const denied = new RemoteRequestError("Account", status);
      vi.mocked(h.account.report).mockRejectedValueOnce(denied);
      await expect(h.pass()).rejects.toBe(denied);
      expect(h.provider.find).toHaveBeenCalledTimes(1);
    },
  );
});
