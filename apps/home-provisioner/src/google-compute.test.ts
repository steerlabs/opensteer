import { GoogleComputeServerRefSchema } from "@opensteer/control-plane-protocol";
import { expect, it, vi } from "vitest";
import { GoogleCompute } from "./google-compute.js";
import {
  addressName,
  ComputeFake,
  computeComputerId,
  computeCreate,
  computeInstanceId,
  computeInstanceName,
  computeIpv4,
  computeIpv6,
  globalPath,
  regionPath,
  zonePath,
} from "./google-compute.test-support.js";
import { ProviderOutcomeUnknown, ProviderWriteRejected } from "./http.js";
import { loadConfig } from "./config.js";

const signal = new AbortController().signal;
const ref = GoogleComputeServerRefSchema.parse(`${computeInstanceName}/${computeInstanceId}`);
const reqs = (fake: ComputeFake, method: string, path: string) =>
  fake.requests.filter((request) => request.method === method && request.path === path);

it("creates a Shielded VM once, with the exact instance ID, one address, and gated user data", async () => {
  const fake = new ComputeFake();
  const provider = fake.adapter();
  expect(await provider.ensureFirewall(signal)).toBe(1);
  const check = vi.fn(async () => {
    expect(fake.requests.filter(({ method }) => method === "POST")).toHaveLength(
      check.mock.calls.length,
    );
  });
  const vm = await provider.create(computeCreate, signal, check);
  expect(vm).toMatchObject({
    id: ref,
    generation: 3,
    status: "running",
    ipv4: computeIpv4,
    ipv6: null,
  });
  expect(await provider.create(computeCreate, signal, check)).toEqual(vm);
  expect(check).toHaveBeenCalledTimes(2);
  const [insert] = reqs(fake, "POST", `${zonePath}/instances`);
  expect(insert?.query.get("requestId")).toBe(computeCreate.requestId);
  expect(insert?.body).toEqual({
    name: computeInstanceName,
    machineType: `${zonePath}/machineTypes/e2-medium`,
    labels: {
      "opensteer-cloud-computer": computeComputerId,
      "opensteer-generation": "3",
      "opensteer-managed-by": "home-provisioner",
    },
    tags: { items: ["opensteer-cloud-computers"] },
    shieldedInstanceConfig: {
      enableSecureBoot: true,
      enableVtpm: true,
      enableIntegrityMonitoring: true,
    },
    scheduling: {
      automaticRestart: true,
      onHostMaintenance: "MIGRATE",
      provisioningModel: "STANDARD",
    },
    serviceAccounts: [],
    metadata: {
      items: [
        { key: "enable-oslogin", value: "TRUE" },
        { key: "block-project-ssh-keys", value: "TRUE" },
        { key: "disable-legacy-endpoints", value: "TRUE" },
        { key: "user-data", value: computeCreate.userData },
      ],
    },
    disks: [
      {
        boot: true,
        autoDelete: true,
        initializeParams: {
          sourceImage: computeCreate.image,
          diskType: `${zonePath}/diskTypes/pd-balanced`,
          diskSizeGb: "30",
        },
      },
    ],
    networkInterfaces: [
      {
        network: `${globalPath}/networks/home-net`,
        subnetwork: `${regionPath}/subnetworks/home-subnet`,
        stackType: "IPV4_ONLY",
        accessConfigs: [
          {
            type: "ONE_TO_ONE_NAT",
            name: "External NAT",
            natIP: computeIpv4,
            networkTier: "PREMIUM",
          },
        ],
      },
    ],
  });
  expect(fake.waitCalls).toEqual([1000, 1000, 1000]);
  expect(fake.addresses.size).toBe(1);
});

it("finds a VM after a lost response and does not submit another insert", async () => {
  const fake = new ComputeFake();
  fake.nextInsert = "lost";
  const provider = fake.adapter();
  await expect(provider.create(computeCreate, signal)).rejects.toBeInstanceOf(
    ProviderOutcomeUnknown,
  );
  expect(await provider.find(computeComputerId, signal, { generation: 3 })).toEqual([
    expect.objectContaining({ id: ref }),
  ]);
  expect(await provider.create(computeCreate, signal)).toMatchObject({ id: ref });
  expect(reqs(fake, "POST", `${zonePath}/instances`)).toHaveLength(1);
});

it.each([
  ["failure", 400],
  ["quota", 403],
] as const)("surfaces a definitive %s rejection", async (failure, status) => {
  const fake = new ComputeFake();
  fake.nextInsert = failure;
  const provider = fake.adapter();
  await expect(provider.create(computeCreate, signal)).rejects.toEqual(
    expect.objectContaining<Partial<ProviderWriteRejected>>({
      original: expect.objectContaining({ status }),
    }),
  );
  expect(fake.instances.size).toBe(0);
  expect(reqs(fake, "POST", `${zonePath}/instances`)).toHaveLength(1);
});

it("reports an unobserved operation as unknown", async () => {
  const fake = new ComputeFake();
  const provider = fake.adapter();
  await provider.create(computeCreate, signal);
  const check = vi.fn(async () => {});
  fake.keepOperationsRunning = true;
  await expect(provider.powerOff(ref, signal, check)).rejects.toBeInstanceOf(
    ProviderOutcomeUnknown,
  );
  expect(check).toHaveBeenCalledOnce();
  fake.keepOperationsRunning = false;
  await fake.adapter().powerOff(ref, signal, check);
  expect(await provider.describe(ref, signal)).toMatchObject({ status: "off" });
  expect(check).toHaveBeenCalledOnce();
  expect(reqs(fake, "POST", `${zonePath}/instances/${computeInstanceName}/stop`)).toHaveLength(1);
});

it("pages Compute inventories without filters and selects journal operations locally", async () => {
  const fake = new ComputeFake();
  fake.pageSize = 1;
  fake.nextInsert = "late";
  const provider = fake.adapter();
  await expect(provider.create(computeCreate, signal)).rejects.toBeInstanceOf(
    ProviderOutcomeUnknown,
  );
  expect(await provider.listManaged(signal)).toEqual([]);
  expect(await provider.listManagedAddresses(signal)).toEqual([
    { id: computeComputerId, generation: 3 },
  ]);
  const write = {
    kind: "create" as const,
    token: computeCreate.requestId!,
    generation: 3,
    dispatched: true,
  };
  expect(await provider.canRecoverWrite(write, signal)).toBe(false);
  expect(await provider.canRecoverWrite({ ...write, token: "unrelated" }, signal)).toBe(true);
  const lists = fake.requests.filter(
    ({ method, path }) => method === "GET" && /\/(addresses|instances|operations)$/u.test(path),
  );
  expect(lists.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      `${zonePath}/instances`,
      `${zonePath}/operations`,
      `${regionPath}/addresses`,
    ]),
  );
  expect(lists.every(({ query }) => !query.has("filter"))).toBe(true);
  expect(lists.some(({ query }) => query.has("pageToken"))).toBe(true);
});

it("paginates and preserves distinct VMs for the same generation and refuses wrong identifiers", async () => {
  const fake = new ComputeFake();
  fake.pageSize = 1;
  const provider = fake.adapter();
  await provider.create(computeCreate, signal);
  const base = fake.instances.get(computeInstanceName)!;
  fake.instances.set("duplicate-instance", {
    ...base,
    labels: { ...base.labels },
    name: "duplicate-instance",
    id: "18446744073709551613",
  });
  fake.instances.set("duplicate-page-entry", { ...base });
  fake.instances.set("unmanaged-instance", {
    ...base,
    name: "unmanaged-instance",
    id: "10",
    labels: {},
  });
  expect(
    (await provider.find(computeComputerId, signal, { generation: 3 })).map(({ id }) => id),
  ).toEqual([ref, "duplicate-instance/18446744073709551613"]);
  expect(await provider.listManaged(signal)).toHaveLength(2);
  expect(
    reqs(fake, "GET", `${zonePath}/instances`).some(({ query }) => query.get("pageToken") === "2"),
  ).toBe(true);
  expect(
    await provider.describe(GoogleComputeServerRefSchema.parse(`${computeInstanceName}/9`), signal),
  ).toBeUndefined();
  expect(await provider.describe(ref, signal, 4)).toMatchObject({ generation: 3 });
  base.labels["opensteer-generation"] = "4";
  expect(await provider.find(computeComputerId, signal, { generation: 3 })).toEqual([
    expect.objectContaining({ id: ref, generation: 4 }),
    expect.objectContaining({ generation: 3 }),
  ]);
});

it("preserves each machine's own address through stop, start, and replacement", async () => {
  const fake = new ComputeFake();
  const provider = fake.adapter();
  const vm = await provider.create(computeCreate, signal);
  await provider.powerOff(vm.id, signal);
  expect(await provider.describe(vm.id, signal)).toMatchObject({
    ipv4: computeIpv4,
    status: "off",
  });
  await provider.powerOn(vm.id, signal);
  expect(await provider.describe(vm.id, signal)).toMatchObject({
    ipv4: computeIpv4,
    status: "running",
  });
  await provider.powerOff(vm.id, signal);
  const replacement = await provider.create(
    { ...computeCreate, generation: 4, requestId: "00000000-0000-4000-8000-000000000011" },
    signal,
  );
  expect(replacement).toMatchObject({ ipv4: "192.0.2.22", status: "running" });
  expect(await provider.describe(vm.id, signal)).toMatchObject({
    ipv4: computeIpv4,
    status: "off",
  });
  expect(await provider.listManagedAddresses(signal)).toEqual([
    { id: computeComputerId, generation: 3 },
    { id: computeComputerId, generation: 4 },
  ]);
  await provider.delete(vm.id, signal);
  expect(await provider.listManagedAddresses(signal)).toEqual([
    { id: computeComputerId, generation: 4 },
  ]);
  expect(await provider.describe(replacement.id, signal)).toMatchObject({ ipv4: "192.0.2.22" });
  await provider.delete(replacement.id, signal);
  expect(await provider.describe(replacement.id, signal)).toBeUndefined();
  expect(await provider.listManagedAddresses(signal)).toEqual([]);
  expect(reqs(fake, "POST", `${regionPath}/addresses`)).toHaveLength(2);
  expect(reqs(fake, "DELETE", `${regionPath}/addresses/${addressName}`)).toHaveLength(1);
});

it("installs a scoped 80/443 rule per address family and verifies the instance tag", async () => {
  const fake = new ComputeFake();
  fake.dualStack = true;
  const provider = fake.adapter();
  const check = vi.fn(async () => {});
  await provider.ensureFirewall(signal, check);
  await provider.ensureFirewall(signal, check);
  expect(check).toHaveBeenCalledTimes(2);
  const rules = reqs(fake, "POST", `${globalPath}/firewalls`);
  expect(rules.map(({ body }) => body)).toEqual(
    ["0.0.0.0/0", "::/0"].map((range) => ({
      name: expect.stringMatching(/^opensteer-cloud-computers-v[46]$/u),
      description: "Managed by the Opensteer Home provisioner",
      network: `${globalPath}/networks/home-net`,
      direction: "INGRESS",
      priority: 1000,
      targetTags: ["opensteer-cloud-computers"],
      sourceRanges: [range],
      allowed: [{ IPProtocol: "tcp", ports: ["80", "443"] }],
    })),
  );
  const vm = await provider.create(computeCreate, signal);
  expect(vm.ipv6).toBe(computeIpv6);
  const instance = fake.instances.get(computeInstanceName)!;
  instance.tags.items = ["another-tag"];
  const untagged = (await provider.describe(vm.id, signal))!;
  expect(await provider.ensureFirewallAttached(untagged, 1, signal)).toBe(true);
  expect(instance.tags.items).toEqual(["another-tag", "opensteer-cloud-computers"]);
});

it("opens the metadata gate after the bootstrap clock starts, then scrubs only its own keys", async () => {
  const fake = new ComputeFake();
  const provider = fake.adapter();
  await provider.create(computeCreate, signal);
  expect(await provider.updateBootstrap(ref, false, signal)).toBe(true);
  expect(await provider.updateBootstrap(ref, false, signal)).toBe(true);
  const instance = fake.instances.get(computeInstanceName)!;
  expect(instance.metadata.items).toContainEqual({ key: "opensteer-bootstrap-ready", value: "1" });
  expect(instance.metadata.items).toContainEqual({
    key: "user-data",
    value: computeCreate.userData,
  });
  instance.metadata.items.push({ key: "unrelated", value: "keep" });
  expect(await provider.updateBootstrap(ref, true, signal)).toBe(true);
  expect(instance.metadata.items).toEqual([
    { key: "enable-oslogin", value: "TRUE" },
    { key: "block-project-ssh-keys", value: "TRUE" },
    { key: "disable-legacy-endpoints", value: "TRUE" },
    { key: "unrelated", value: "keep" },
  ]);
  expect(await provider.updateBootstrap(ref, true, signal)).toBe(true);
  const writes = reqs(fake, "POST", `${zonePath}/instances/${computeInstanceName}/setMetadata`);
  expect(writes).toHaveLength(2);
  expect(writes[1]?.body).toMatchObject({ fingerprint: "changed" });
});

it("caches, refreshes, and discards a refused metadata token without replay", async () => {
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const fake = new ComputeFake();
  const provider = fake.adapter();
  await provider.listManaged(signal);
  await provider.listManaged(signal);
  expect(fake.metadataCalls).toBe(1);
  now += 51_000;
  fake.token = "new-access-token";
  await provider.listManaged(signal);
  expect(fake.metadataCalls).toBe(2);
  fake.rejectComputeToken = true;
  await expect(provider.listManaged(signal)).rejects.toMatchObject({ status: 401 });
  expect(fake.metadataCalls).toBe(2);
  fake.rejectComputeToken = false;
  await provider.listManaged(signal);
  expect(fake.metadataCalls).toBe(3);
  fake.rejectMetadata = true;
  now += 51_000;
  await expect(provider.listManaged(signal)).rejects.toMatchObject({
    service: "Google metadata",
    status: 403,
  });
});

it("takes an ADC client from local test composition without looking for machine credentials", async () => {
  const fake = new ComputeFake();
  const adc = { getAccessToken: vi.fn(async () => fake.token) };
  const provider = new GoogleCompute({
    project: "test-project",
    zone: "us-central1-a",
    network: "home-net",
    subnet: "home-subnet",
    diskType: "pd-balanced",
    diskSizeGb: 30,
    timeoutMs: 2000,
    actionTimeoutMs: 5000,
    baseUrl: new URL("https://compute.test/compute/v1/"),
    fetch: fake.fetch,
    accessToken: adc,
  });
  expect(await provider.listManaged(signal)).toEqual([]);
  expect(adc.getAccessToken).toHaveBeenCalledWith(signal);
  expect(fake.metadataCalls).toBe(0);
});

it("keeps Hetzner defaults and selects a four-vCPU Google machine with one override", () => {
  const shared = {
    OPENSTEER_ACCOUNT_URL: "https://account.test",
    OPENSTEER_HOME_CLOUDFLARE_TOKEN: "cloudflare_token_for_tests",
    OPENSTEER_HOME_CLOUDFLARE_ZONE_ID: "0".repeat(32),
  };
  expect(
    loadConfig({
      ...shared,
      OPENSTEER_HOME_DEFAULT_REGION: "fsn1",
      OPENSTEER_HOME_DEFAULT_SERVER_TYPE: "cpx22",
      OPENSTEER_HOME_IMAGE: "123",
      OPENSTEER_HOME_HETZNER_TOKEN: "hetzner_test_token_deliberately_fake",
    }),
  ).toMatchObject({ provider: "hetzner", region: "fsn1", serverType: "cpx22", image: 123 });
  expect(
    loadConfig({
      ...shared,
      OPENSTEER_HOME_PROVIDER: "google",
      OPENSTEER_HOME_GCP_PROJECT: "test-project",
      OPENSTEER_HOME_GCP_ZONE: "us-central1-a",
      OPENSTEER_HOME_GCP_NETWORK: "home-net",
      OPENSTEER_HOME_GCP_SUBNET: "home-subnet",
    }),
  ).toMatchObject({
    provider: "google",
    region: "us-central1-a",
    serverType: "e2-standard-4",
    diskType: "pd-balanced",
    diskSizeGb: 30,
  });
  expect(
    loadConfig({
      ...shared,
      OPENSTEER_HOME_PROVIDER: "google",
      OPENSTEER_HOME_GCP_PROJECT: "test-project",
      OPENSTEER_HOME_GCP_ZONE: "us-central1-a",
      OPENSTEER_HOME_GCP_NETWORK: "home-net",
      OPENSTEER_HOME_GCP_SUBNET: "home-subnet",
      OPENSTEER_HOME_GCP_MACHINE_TYPE: "e2-standard-8",
    }).serverType,
  ).toBe("e2-standard-8");
  expect(
    GoogleComputeServerRefSchema.safeParse(`${computeInstanceName}/18446744073709551616`).success,
  ).toBe(false);
});
