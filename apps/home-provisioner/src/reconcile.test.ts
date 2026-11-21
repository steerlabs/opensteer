import {
  CloudComputerDesiredSchema,
  CloudComputerIdentitySchema,
  CloudComputerReportSchema,
  type CloudComputerDesired,
  type CloudComputerId,
  type CloudComputerReport,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import { BootstrapScrubFailure, RemoteRequestError } from "./http.js";
import type { AccountApi } from "./account.js";
import type { Addresses, CreateVm, DnsProvider, VmProvider, VmServer } from "./provider.js";
import { Reconciler } from "./reconcile.js";
import { ComputeFake, computeCreate, regionPath, zonePath } from "./google-compute.test-support.js";
import { fakeHetzner } from "./hetzner.test-support.js";

const home = CloudComputerDesiredSchema.parse({
  id: "cc_00000000-0000-4000-8000-000000000001",
  generation: 1,
  revision: 1,
  readinessStartedAt: new Date(10).toISOString(),
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

function harness({
  concurrency = 2,
  compute,
  adapter,
}: { concurrency?: number; compute?: ComputeFake; adapter?: VmProvider } = {}) {
  const reports: CloudComputerReport[] = [];
  const onError = vi.fn();
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
    listManaged: vi.fn(async () =>
      [...servers.values()].map((server) => ({ id: server.home, server })),
    ),
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
  const vmProvider = adapter ?? compute?.adapter() ?? provider;
  const dns = {
    listManaged: vi.fn(async () =>
      [...records.keys()].map((hostname) => ({ id: home.id, hostname })),
    ),
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
    acquire: vi.fn(async () => {}),
    check: vi.fn<AccountApi["check"]>(async (id, check) => {
      const row = status.desired.find((computer) => computer.id === id);
      if (check.operation === "orphan") return !row;
      if (compute && row) {
        const writes = row.pendingProviderWrites ?? [];
        if ("revision" in check && check.revision !== row.revision) return false;
        if (check.operation === "begin-provider-write") {
          row.pendingProviderWrites = [
            ...writes,
            { ...check.write, recoverAfter: new Date(status.now + 1000).toISOString() },
          ];
        }
        if (check.operation === "send-provider-write") {
          row.pendingProviderWrites = writes.map((write) =>
            write.token === check.token ? { ...write, dispatched: true } : write,
          );
        }
        if (
          check.operation === "finish-provider-write" ||
          check.operation === "recover-provider-write"
        )
          row.pendingProviderWrites = writes.filter(({ token }) => token !== check.token);
      }
      if (check.operation === "finish-provider-write") return Boolean(row);
      return check.revision === row?.revision;
    }),
    desired: vi.fn(async () => status.desired),
    report: vi.fn<AccountApi["report"]>(async (report) => {
      reports.push(CloudComputerReportSchema.parse(report));
      if (report.providerServerId || report.providerServerRef) {
        status.desired = status.desired.map((row) =>
          row.id === report.id && row.revision === report.revision
            ? {
                ...row,
                ...(report.providerServerId ? { providerServerId: report.providerServerId } : {}),
                ...(report.providerServerRef
                  ? { providerServerRef: report.providerServerRef }
                  : {}),
              }
            : row,
        );
      }
      return true;
    }),
  };
  const setup = (client: AccountApi = account) =>
    new Reconciler({
      account: client,
      provider: vmProvider,
      dns,
      discover: async () => status.identity,
      accountOrigin: new URL("https://account.example.com"),
      image: compute
        ? "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
        : "ubuntu-24.04",
      defaultRegion: compute ? "us-central1" : "ash",
      defaultServerType: compute ? "e2-medium" : "cpx22",
      concurrency,
      readinessTimeoutMs: 1000,
      orphanGraceMs: 60_000,
      onError,
      now: () => status.now,
    });
  const reconciler = setup();
  const signal = new AbortController().signal;
  return {
    calls,
    put,
    provider,
    vmProvider,
    dns,
    records,
    servers,
    account,
    status,
    reports,
    onError,
    pass: () => reconciler.pass(signal),
    another: (client: AccountApi) => setup(client).pass(signal),
    pin: () => {
      status.desired = status.desired.map((row) => ({
        ...row,
        revision: row.revision + 1,
        bootCompleted: true,
        observedIdentity: identity,
      }));
    },
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
          phase: "booting",
          observedIdentity: null,
          providerServerId: 1,
        });
        h.pin();
        await h.pass();
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
        expect(h.last()?.phase).toBe("booting");
      },
    },
    {
      name: "powers on an existing VM without a token",
      async run(h) {
        h.status.desired = [{ ...home, bootstrapToken: undefined }];
        h.put(home, "off");
        await h.pass();
        expect(h.calls).toEqual(["firewall", "powerOn:1", "dns"]);
        expect(h.last()?.phase).toBe("booting");
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
        expect(h.reports.map(({ phase }) => phase)).toEqual(["provisioning", "booting", "failed"]);
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
        h.pin();
        await h.pass();
        h.status.identity = changed;
        await h.pass();
        expect(h.last()).toMatchObject({
          phase: "failed",
          observedIdentity: identity,
          lastError: "The Cloud Computer reported a different Home identity for this generation.",
        });
        expect(h.records.has(home.hostname)).toBe(false);
        h.status.desired = [{ ...h.status.desired[0]!, observedIdentity: identity }];
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
        expect(h.calls).toEqual([
          "powerOff:1",
          "removeDns",
          "firewall",
          "create:2",
          "powerOn:2",
          "dns",
        ]);
        expect(h.servers.get(1)?.status).toBe("off");
        h.pin();
        await h.pass();
        expect(h.calls.at(-1)).toBe("delete:1");
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
        h.pin();
        const active = h.status.desired[0]!;
        h.status.desired = [
          {
            ...active,
            revision: active.revision + 1,
            state: "suspended",
            bootstrapToken: undefined,
          },
        ];
        await h.pass();
        expect(h.servers.get(1)?.status).toBe("off");
        expect(h.records.has(home.hostname)).toBe(false);
        expect(h.last()).toMatchObject({ phase: "suspended", observedIdentity: identity });
        h.status.desired = [
          { ...active, revision: active.revision + 2, bootstrapToken: undefined },
        ];
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
        expect(h.calls.filter((call) => call === "removeDns")).toHaveLength(2);
        expect(h.calls.filter((call) => call === "delete:1")).toHaveLength(2);
        expect(h.provider.describe).toHaveBeenLastCalledWith(
          server.id,
          expect.any(AbortSignal),
          server.generation,
        );
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
            expect.objectContaining({ id: second.id, phase: "booting" }),
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
        expect(h.reports.map(({ phase }) => phase)).toEqual(["provisioning", "booting"]);
      },
    },
  ];
  it.each(cases)("$name", ({ run }) => run(harness()));

  it.each(["Hetzner", "Google"])(
    "reconciles the VM, DNS and Home identity through its lifecycle on %s",
    async (provider) => {
      const google = provider === "Google";
      const compute = google ? new ComputeFake() : undefined;
      const h = harness(compute ? { compute } : { adapter: fakeHetzner() });
      h.status.desired = [{ ...home, region: null, serverType: null }];
      await h.pass();
      expect(h.last()?.phase).toBe("booting");
      const initial = (await h.vmProvider.find(home.id, new AbortController().signal))[0]!;
      expect(initial.ipv4).toBe(h.records.get(home.hostname)?.ipv4);
      h.pin();
      await h.pass();
      expect(h.last()).toMatchObject({ phase: "ready", observedIdentity: identity });
      const active = h.status.desired[0]!;
      h.status.desired = [
        { ...active, revision: active.revision + 1, state: "suspended", bootstrapToken: undefined },
      ];
      await h.pass();
      expect(h.last()).toMatchObject({ phase: "suspended", ipv4: initial.ipv4 });
      expect(h.records.has(home.hostname)).toBe(false);
      h.status.desired = [{ ...active, revision: active.revision + 2, bootstrapToken: undefined }];
      await h.pass();
      expect(h.last()).toMatchObject({ phase: "ready", ipv4: initial.ipv4 });
      expect(h.last()?.providerServerRef ?? h.last()?.providerServerId).toBe(initial.id);
      h.status.desired = [
        { ...h.status.desired[0]!, revision: active.revision + 3, state: "deleted" },
      ];
      await h.pass();
      expect(h.last()).toMatchObject({ phase: "deleted", providerServerId: null, ipv4: null });
      expect(h.records.size).toBe(0);
      expect(await h.vmProvider.listManaged(new AbortController().signal)).toEqual([]);
      if (compute) expect(compute.addresses.size).toBe(0);
    },
  );

  it("records the Google insert before dispatch and scrubs metadata after the Account receipt", async () => {
    const compute = new ComputeFake();
    const h = harness({ compute });
    h.status.desired = [{ ...home, region: null, serverType: null }];
    await h.pass();
    const [instance] = compute.instances.values();
    const [insert] = compute.requests.filter(
      ({ method, path }) => method === "POST" && path === `${zonePath}/instances`,
    );
    const checks = vi.mocked(h.account.check).mock.calls.map(([, check]) => check);
    expect(checks).toContainEqual(
      expect.objectContaining({
        operation: "begin-provider-write",
        write: expect.objectContaining({ kind: "create", token: insert?.query.get("requestId") }),
      }),
    );
    expect(checks).toContainEqual(
      expect.objectContaining({
        operation: "send-provider-write",
        token: insert?.query.get("requestId"),
      }),
    );
    expect(h.reports.map(({ phase }) => phase)).toEqual(["provisioning", "booting"]);
    expect(instance?.metadata.items).toContainEqual({
      key: "opensteer-bootstrap-ready",
      value: "1",
    });
    expect(instance?.metadata.items.find(({ key }) => key === "user-data")?.value).toContain(
      "/instance/attributes/opensteer-bootstrap-ready",
    );
    h.pin();
    await h.pass();
    expect(instance?.metadata.items.some(({ key }) => key === "user-data")).toBe(true);
    h.status.desired = [{ ...h.status.desired[0]!, bootstrapReceiptRecorded: true }];
    await h.pass();
    expect(instance?.metadata.items.map(({ key }) => key)).toEqual([
      "enable-oslogin",
      "block-project-ssh-keys",
      "disable-legacy-endpoints",
    ]);
  });

  it("gives two Google purchases in one pass distinct address and instance request IDs", async () => {
    const compute = new ComputeFake();
    const h = harness({ compute });
    h.status.desired = [{ ...home }, { ...second }];
    await h.pass();
    const addresses = compute.requests.filter(
      ({ method, path }) => method === "POST" && path === `${regionPath}/addresses`,
    );
    const instances = compute.requests.filter(
      ({ method, path }) => method === "POST" && path === `${zonePath}/instances`,
    );
    expect(addresses).toHaveLength(2);
    expect(instances).toHaveLength(2);
    expect(
      new Set([...addresses, ...instances].map(({ query }) => query.get("requestId"))).size,
    ).toBe(4);
    expect(compute.addresses.size).toBe(2);
    expect(compute.instances.size).toBe(2);

    const originalAddress = addresses.find(({ body }) => JSON.stringify(body).includes(home.id))!;
    const [, journal] = vi
      .mocked(h.account.check)
      .mock.calls.find(
        ([id, check]) =>
          id === home.id &&
          check.operation === "begin-provider-write" &&
          check.write.kind === "create",
      )!;
    if (journal.operation !== "begin-provider-write") throw new Error("Missing the create journal");
    const replay = new ComputeFake();
    const replayAdapter = replay.adapter();
    await replayAdapter.create(
      {
        ...computeCreate,
        id: home.id,
        generation: home.generation,
        requestId: journal.write.token,
      },
      new AbortController().signal,
    );
    const replayedAddress = replay.requests.find(
      ({ method, path }) => method === "POST" && path === `${regionPath}/addresses`,
    );
    expect(replayedAddress?.query.get("requestId")).toBe(originalAddress.query.get("requestId"));
  });

  it.each(["conflict", "rejected"])(
    "keeps a verified Google replacement ready when the last metadata scrub is %s",
    async (failure) => {
      const compute = new ComputeFake();
      const adapter = compute.adapter();
      const h = harness({ compute, adapter });
      h.status.desired = [{ ...home }];
      await h.pass();
      const [old] = compute.instances.values();
      h.status.desired = [{ ...home, generation: 2, revision: 2 }];
      await h.pass();
      const replacement = [...compute.instances.values()].find(({ name }) => name !== old?.name)!;
      h.pin();
      h.status.desired = [{ ...h.status.desired[0]!, bootstrapReceiptRecorded: true }];
      h.status.now += 1000;
      h.records.clear();
      const scrub = vi.spyOn(adapter, "updateBootstrap").mockImplementationOnce(async () => {
        expect(h.records.get(home.hostname)?.ipv4).toBe(
          replacement.networkInterfaces[0]?.accessConfigs[0]?.natIP,
        );
        expect(compute.instances.has(old!.name)).toBe(false);
        if (failure === "rejected") throw new RemoteRequestError("Google Compute Engine", 403);
        return false;
      });
      await h.pass();
      expect(h.last()).toMatchObject({ phase: "ready", generation: 2 });
      expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.any(BootstrapScrubFailure));
      expect(replacement.metadata.items.some(({ key }) => key === "user-data")).toBe(true);
      await h.pass();
      expect(scrub).toHaveBeenCalledTimes(2);
      expect(h.last()?.phase).toBe("ready");
      expect(replacement.metadata.items.some(({ key }) => key === "user-data")).toBe(false);
    },
  );

  it("keeps a lost Google insert unknown and deletes its late VM and reservation", async () => {
    const compute = new ComputeFake();
    compute.nextInsert = "late";
    const h = harness({ compute });
    h.status.desired = [{ ...home, region: null, serverType: null }];
    await h.pass();
    expect(h.reports).toEqual([]);
    const write = h.status.desired[0]?.pendingProviderWrites?.[0];
    expect(write).toMatchObject({ kind: "create", dispatched: true });
    const [operationPath] = [...compute.operations.entries()].find(
      ([, { operation }]) => operation.clientOperationId === write?.token,
    )!;
    h.status.desired = [
      { ...h.status.desired[0]!, revision: 2, state: "deleted", bootstrapToken: undefined },
    ];
    h.status.now += 2000;
    await h.restart();
    expect(h.last()?.phase).toBe("deleting");
    expect(compute.addresses.size).toBe(1);
    compute.complete(operationPath);
    await h.pass();
    expect(h.last()?.phase).toBe("deleted");
    expect(compute.instances.size).toBe(0);
    expect(compute.addresses.size).toBe(0);
    expect(h.dns.ensureRecords).not.toHaveBeenCalled();
  });

  it("sweeps an address-only Google orphan after the grace period and a fresh Account check", async () => {
    const compute = new ComputeFake();
    compute.nextInsert = "quota";
    const h = harness({ compute });
    h.status.desired = [{ ...home, region: null, serverType: null }];
    await h.pass();
    expect(h.last()?.phase).toBe("failed");
    expect(compute.addresses.size).toBe(1);
    h.status.desired = [];
    h.status.now += 60_000;
    await h.pass();
    expect(compute.addresses.size).toBe(1);
    h.status.now += 60_000;
    await h.pass();
    expect(compute.addresses.size).toBe(0);
    expect(h.account.check).toHaveBeenCalledWith(
      home.id,
      { operation: "orphan" },
      expect.any(AbortSignal),
    );
  });

  it("refuses a second reconciler while a stale pass is blocked before creating a VM", async () => {
    const h = harness({ concurrency: 1 });
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    let owner: string | undefined;
    const client = (holder: string): AccountApi => ({
      ...h.account,
      async acquire() {
        if (owner && owner !== holder) throw new RemoteRequestError("Account", 409);
        owner = holder;
      },
    });
    h.provider.find.mockImplementationOnce(async () => {
      entered.resolve();
      await proceed.promise;
      return [];
    });
    const running = h.another(client("a"));
    await entered.promise;
    h.status.desired = [{ ...home, revision: 2, state: "deleted", bootstrapToken: undefined }];
    await expect(h.another(client("b"))).rejects.toMatchObject({ status: 409 });
    proceed.resolve();
    await running;
    expect(h.provider.create).not.toHaveBeenCalled();
    expect(h.dns.ensureRecords).not.toHaveBeenCalled();
    await h.another(client("a"));
    expect(h.last()?.phase).toBe("deleted");
  });

  it("sweeps orphaned VMs and DNS only after the grace period and a fresh check", async () => {
    const h = harness();
    h.put(home, "running");
    h.records.set(home.hostname, { ipv4: "192.0.2.1", ipv6: null });
    h.status.desired = [];
    await h.pass();
    expect(h.provider.delete).not.toHaveBeenCalled();
    h.status.now += 60_000;
    await h.pass();
    expect(h.provider.delete).toHaveBeenCalledOnce();
    expect(h.records.size).toBe(0);
  });

  it("follows a deleting VM to absence without reissuing deletion", async () => {
    const h = harness();
    h.put(home, "deleting");
    h.status.desired = [{ ...home, state: "deleted", bootstrapToken: undefined }];
    await h.pass();
    expect(h.last()?.phase).toBe("deleting");
    expect(h.provider.delete).not.toHaveBeenCalled();
    h.servers.clear();
    await h.pass();
    expect(h.last()?.phase).toBe("deleted");
  });

  it("publishes AAAA only after Account explicitly enables IPv6", async () => {
    const h = harness();
    const server = h.put(home, "running");
    h.servers.set(server.id, { ...server, ipv6: "2001:db8::1" });
    await h.pass();
    expect(h.records.get(home.hostname)?.ipv6).toBeNull();
    h.status.desired = [{ ...h.status.desired[0]!, revision: 2, ipv6Enabled: true }];
    await h.pass();
    expect(h.records.get(home.hostname)?.ipv6).toBe("2001:db8::1");
  });

  it("does not deduplicate a discarded report or one from an older desired revision", async () => {
    const h = harness();
    const server = h.put(home, "running");
    h.status.desired = [{ ...home, providerServerId: server.id }];
    vi.mocked(h.account.report).mockResolvedValueOnce(false);
    await h.pass();
    await h.pass();
    expect(h.account.report).toHaveBeenCalledTimes(2);
    h.status.desired = [{ ...h.status.desired[0]!, revision: 2 }];
    await h.pass();
    expect(h.last()?.revision).toBe(2);
    expect(h.account.report).toHaveBeenCalledTimes(3);
  });

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
