import { generateKeyPairSync } from "node:crypto";
import {
  BrowserPoolHostIdSchema,
  GoogleComputeServerRefSchema,
} from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import {
  ComputeFake,
  computeCreate,
  globalPath,
  regionPath,
  zonePath,
} from "./google-compute.test-support.js";
import { renderPoolHostUserData } from "./pool-boot.js";
import type { CreatePoolHostVm } from "./provider.js";

const signal = new AbortController().signal;
const poolHostId = BrowserPoolHostIdSchema.parse("ph_11111111-1111-4111-8111-111111111111");
const poolInstanceName = `osp-${poolHostId.replace("_", "-")}-1`;
const profileDiskName = `osp-disk-${poolHostId.slice("ph_".length)}`;
const reqs = (fake: ComputeFake, method: string, path: string) =>
  fake.requests.filter((request) => request.method === method && request.path === path);

describe("Google Compute pool host provider", () => {
  it("reports internalIpv4 (networkIP) on Home VMs and pool host VMs", async () => {
    const fake = new ComputeFake();
    const provider = fake.adapter();
    await provider.ensureFirewall(signal);
    const homeVm = await provider.create(computeCreate, signal);
    expect(homeVm.internalIpv4).toMatch(/^10\.40\./u);
    expect(homeVm.ipv4).not.toBeNull();
  });

  it("ensures pool host VPC firewalls for Home (7310/7312) and admin (7311) and rejects drift", async () => {
    const fake = new ComputeFake();
    const provider = fake.adapter();
    await provider.ensurePoolFirewalls(
      { provisionerCidr: "10.50.0.0/24", agentPort: 7310, adminPort: 7311, relayPort: 7312 },
      signal,
    );
    expect(fake.firewalls.get("opensteer-pool-hosts-home")).toMatchObject({
      network: `${globalPath}/networks/home-net`,
      direction: "INGRESS",
      targetTags: ["opensteer-pool-hosts"],
      sourceTags: ["opensteer-cloud-computers"],
      allowed: [{ IPProtocol: "tcp", ports: ["7310", "7312"] }],
    });
    expect(fake.firewalls.get("opensteer-pool-hosts-admin")).toMatchObject({
      network: `${globalPath}/networks/home-net`,
      direction: "INGRESS",
      targetTags: ["opensteer-pool-hosts"],
      sourceRanges: ["10.50.0.0/24"],
      allowed: [{ IPProtocol: "tcp", ports: ["7311"] }],
    });

    // Drift on admin firewall (wrong CIDR) is refused with conflict.
    await expect(
      provider.ensurePoolFirewalls(
        { provisionerCidr: "10.99.0.0/24", agentPort: 7310, adminPort: 7311, relayPort: 7312 },
        signal,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("creates durable profile disk once, creates --no-address nested-virt pool host VM with Local SSDs, and isolates inventory from Homes", async () => {
    const fake = new ComputeFake();
    const provider = fake.adapter();
    await provider.ensureFirewall(signal);
    await provider.ensurePoolFirewalls(
      { provisionerCidr: "10.50.0.0/24", agentPort: 7310, adminPort: 7311, relayPort: 7312 },
      signal,
    );
    // Create a Home VM in the same project/zone to confirm inventories never collide.
    await provider.create(computeCreate, signal);

    const disk = await provider.ensurePoolProfileDisk(
      {
        hostId: poolHostId,
        diskName: profileDiskName,
        sizeGb: 500,
        diskType: "pd-ssd",
        requestId: "00000000-0000-4000-8000-000000000101",
      },
      signal,
    );
    expect(disk.name).toBe(profileDiskName);
    expect(disk.ref).toMatch(new RegExp(`^${profileDiskName}/[0-9]+$`, "u"));
    expect(fake.disks.size).toBe(1);

    const createSpec: CreatePoolHostVm = {
      id: poolHostId,
      generation: 1,
      machineType: "n2-standard-8",
      image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
      bootDiskSizeGb: 40,
      profileDiskName,
      localSsdCount: 2,
      userData: "#cloud-config\npool-test",
      requestId: "00000000-0000-4000-8000-000000000102",
    };
    const check = vi.fn(async () => {});
    const vm = await provider.createPoolHost(createSpec, signal, check);
    expect(vm).toMatchObject({
      id: GoogleComputeServerRefSchema.parse(`${poolInstanceName}/${vm.id.split("/")[1]}`),
      generation: 1,
      status: "running",
      internalIpv4: expect.stringMatching(/^10\.40\./u),
      bootstrapMetadata: "pending",
    });

    const [insert] = reqs(fake, "POST", `${zonePath}/instances`).filter(
      (r) => (r.body as { name?: string })?.name === poolInstanceName,
    );
    expect(insert?.body).toMatchObject({
      name: poolInstanceName,
      machineType: `${zonePath}/machineTypes/n2-standard-8`,
      labels: {
        "opensteer-pool-host": poolHostId,
        "opensteer-generation": "1",
        "opensteer-managed-by": "home-provisioner",
      },
      tags: { items: ["opensteer-pool-hosts"] },
      advancedMachineFeatures: {
        enableNestedVirtualization: true,
        threadsPerCore: 1,
      },
      scheduling: {
        automaticRestart: true,
        onHostMaintenance: "TERMINATE",
        provisioningModel: "STANDARD",
      },
      serviceAccounts: [],
      networkInterfaces: [
        {
          subnetwork: `${regionPath}/subnetworks/home-subnet`,
          stackType: "IPV4_ONLY",
        },
      ],
    });
    // No external IP accessConfigs on pool host VM.
    const body = insert?.body as {
      networkInterfaces: { accessConfigs?: unknown }[];
      disks: Record<string, unknown>[];
    };
    expect(body.networkInterfaces[0]?.accessConfigs).toBeUndefined();
    // 1 boot disk + 1 autoDelete:false durable profile disk + 2 SCRATCH NVMe local SSDs.
    expect(body.disks).toHaveLength(4);
    expect(body.disks[0]).toMatchObject({ boot: true, autoDelete: true });
    expect(body.disks[1]).toMatchObject({
      boot: false,
      autoDelete: false,
      mode: "READ_WRITE",
      deviceName: "opensteer-profiles",
      source: `${zonePath}/disks/${profileDiskName}`,
    });
    expect(body.disks[2]).toMatchObject({
      type: "SCRATCH",
      autoDelete: true,
      interface: "NVME",
      initializeParams: { diskType: `${zonePath}/diskTypes/local-ssd` },
    });
    expect(body.disks[3]).toMatchObject({
      type: "SCRATCH",
      autoDelete: true,
      interface: "NVME",
    });

    // Home inventory and pool host inventory stay strictly disjoint.
    expect(await provider.listManaged(signal)).toHaveLength(1);
    const managedPool = await provider.listManagedPoolHosts(signal);
    expect(managedPool).toHaveLength(1);
    expect(managedPool[0]?.id).toBe(poolHostId);

    // Deleting the instance keeps the durable profile disk intact (W1), then deleting the disk removes it.
    await provider.deletePoolHost(vm.id, signal);
    expect(await provider.findPoolHost(poolHostId, signal)).toEqual([]);
    expect(await provider.findPoolProfileDisk(profileDiskName, signal)).toBeDefined();
    expect(await provider.deletePoolProfileDisk(profileDiskName, poolHostId, signal)).toBe(true);
    expect(await provider.findPoolProfileDisk(profileDiskName, signal)).toBeUndefined();
  });

  it("renders gated pool host cloud-init user-data and loads optional pool config only when configured (S8)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const provisionerKeySpki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const provisionerKeyPkcs8 = privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64");

    const userData = renderPoolHostUserData(
      {
        hostId: poolHostId,
        generation: 2,
        accountOrigin: "https://account.example.test",
        installerUrl: "https://releases.example.test/pool-host.sh",
        installerSha256: "a".repeat(64),
        bootstrapToken: "t".repeat(43),
        provisionerKey: provisionerKeySpki,
        homeCidr: "10.40.0.0/20",
        provisionerCidr: "10.50.0.0/24",
        profileDiskDevice: "/dev/disk/by-id/google-opensteer-profiles",
        everEnrolled: true,
        agentPort: 7310,
        adminPort: 7311,
        relayPort: 7312,
      },
      true,
    );
    expect(userData.startsWith("#cloud-config\n")).toBe(true);
    expect(userData).toContain("opensteer-bootstrap-ready");
    expect(userData).toContain("/dev/disk/by-id/google-opensteer-profiles");
    expect(userData).toContain('\\"everEnrolled\\":true');
    expect(userData).toContain(provisionerKeySpki);

    const baseEnv = {
      OPENSTEER_ACCOUNT_URL: "https://account.example.test",
      OPENSTEER_HOME_PROVIDER: "google",
      OPENSTEER_HOME_CLOUDFLARE_ZONE_ID: "a".repeat(32),
      OPENSTEER_HOME_CLOUDFLARE_TOKEN: "c".repeat(32),
      OPENSTEER_HOME_GCP_PROJECT: "test-project",
      OPENSTEER_HOME_GCP_ZONE: "us-central1-a",
      OPENSTEER_HOME_GCP_NETWORK: "home-net",
      OPENSTEER_HOME_GCP_SUBNET: "home-subnet",
    };
    const withoutPool = loadConfig(baseEnv);
    expect(withoutPool.provider === "google" && withoutPool.pool).toBeUndefined();

    const withPool = loadConfig({
      ...baseEnv,
      OPENSTEER_POOL_PROVISIONER_KEY: provisionerKeyPkcs8,
      OPENSTEER_POOL_HOME_CIDR: "10.40.0.0/20",
      OPENSTEER_POOL_PROVISIONER_CIDR: "10.50.0.0/24",
      OPENSTEER_POOL_LOCAL_SSD_COUNT: "2",
    });
    expect(withPool.provider).toBe("google");
    if (withPool.provider === "google") {
      expect(withPool.pool).toMatchObject({
        provisionerPublicKeySpki: provisionerKeySpki,
        homeCidr: "10.40.0.0/20",
        provisionerCidr: "10.50.0.0/24",
        localSsdCount: 2,
        adminPort: 7311,
      });
    }
  });
});
