import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  BrowserPoolDiskRefSchema,
  BrowserPoolHostIdSchema,
  CloudComputerGenerationSchema,
  CloudComputerIdSchema,
  GoogleComputeServerRefSchema,
  type BrowserPoolHostId,
  type BrowserPoolHostProviderWrite,
  type CloudComputerId,
  type CloudComputerProviderWrite,
  type GoogleComputeServerRef,
} from "@opensteer/control-plane-protocol";
import { refused, sameStringSet } from "@opensteer/core";
import { z } from "zod";
import { type ComputeAccessToken, googleMetadataAccessToken } from "./google-auth.js";
import {
  json,
  ObservationFailed,
  ProviderOutcomeUnknown,
  ProviderPlacementError,
  ProviderRateLimited,
  ProviderWriteRejected,
  RemoteRequestError,
  request,
  type HttpOptions,
} from "./http.js";
import { googleBootstrapReadyKey } from "./boot.js";
import { poolProfileDiskDeviceName } from "./pool-boot.js";
import type {
  CreatePoolHostVm,
  CreateVm,
  EnsurePoolProfileDisk,
  ExpectedPoolHostVm,
  ExpectedVm,
  PoolFirewallConfig,
  PoolHostProvider,
  PoolHostVm,
  PoolProfileDisk,
  VmAddress,
  VmProvider,
  VmServer,
} from "./provider.js";

const homeLabel = "opensteer-cloud-computer";
const poolHostLabel = "opensteer-pool-host";
const generationLabel = "opensteer-generation";
const managedLabel = "opensteer-managed-by";
const managedBy = "home-provisioner";
const firewallTag = "opensteer-cloud-computers";
const poolFirewallTag = "opensteer-pool-hosts";
const poolFirewallHomeName = "opensteer-pool-hosts-home";
const poolFirewallAdminName = "opensteer-pool-hosts-admin";
const firewallId = 1;
const accessConfigName = "External NAT";
const compute = "Google Compute Engine";

const resourceName = z.string().regex(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u);
const numericId = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const labels = z.record(z.string(), z.string());
const operation = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
  status: z.enum(["PENDING", "RUNNING", "DONE"]),
  insertTime: z.string().optional(),
  creationTimestamp: z.string().optional(),
  clientOperationId: z.string().optional(),
  operationType: z.string().optional(),
  targetId: z
    .string()
    .regex(/^\d{1,20}$/u)
    .optional(),
  error: z.object({ errors: z.array(z.unknown()).optional() }).optional(),
  httpErrorStatusCode: z.number().int().optional(),
});
type Operation = z.infer<typeof operation>;
const metadata = z.object({
  fingerprint: z.string().min(1),
  // Inventory pages carry only the keys; a write reads the instance itself first.
  items: z.array(z.object({ key: z.string(), value: z.string().optional() })).default([]),
});
const instance = z.object({
  id: numericId,
  name: resourceName,
  labels: labels.default({}),
  status: z.string(),
  lastStartTimestamp: z.string().optional(),
  tags: z
    .object({
      items: z.array(z.string()).default([]),
      fingerprint: z.string().optional(),
    })
    .optional(),
  metadata: metadata.optional(),
  networkInterfaces: z
    .array(
      z.object({
        name: z.string(),
        networkIP: z.ipv4().optional(),
        accessConfigs: z
          .array(z.object({ name: z.string(), natIP: z.ipv4().optional() }))
          .default([]),
        ipv6AccessConfigs: z.array(z.object({ externalIpv6: z.ipv6().optional() })).default([]),
      }),
    )
    .default([]),
});
type Instance = z.infer<typeof instance>;
const disk = z.object({
  id: numericId,
  name: resourceName,
  labels: labels.default({}),
  users: z.array(z.string()).default([]),
});
type Disk = z.infer<typeof disk>;
const address = z.object({
  name: resourceName,
  address: z.union([z.ipv4(), z.ipv6()]).optional(),
  addressType: z.string(),
  networkTier: z.string().optional(),
  status: z.enum(["RESERVING", "RESERVED", "IN_USE"]),
  labels: labels.default({}),
  labelFingerprint: z.string().optional(),
  users: z.array(z.string()).default([]),
});
const subnetwork = z.object({
  network: z.string(),
  stackType: z.enum(["IPV4_ONLY", "IPV4_IPV6", "IPV6_ONLY"]).default("IPV4_ONLY"),
  ipv6AccessType: z.enum(["EXTERNAL", "INTERNAL"]).optional(),
  ipCidrRange: z.string().optional(),
});
const firewall = z.object({
  name: resourceName,
  description: z.string().optional(),
  network: z.string(),
  direction: z.literal("INGRESS"),
  priority: z.number(),
  disabled: z.boolean().default(false),
  targetTags: z.array(z.string()).default([]),
  targetServiceAccounts: z.array(z.string()).default([]),
  sourceRanges: z.array(z.string()).default([]),
  sourceTags: z.array(z.string()).default([]),
  sourceServiceAccounts: z.array(z.string()).default([]),
  destinationRanges: z.array(z.string()).default([]),
  allowed: z
    .array(z.object({ IPProtocol: z.string(), ports: z.array(z.string()).default([]) }))
    .default([]),
  denied: z.array(z.unknown()).default([]),
});

// Partial responses keep each inventory page to the fields the adapter reads.
// https://cloud.google.com/compute/docs/api/how-tos/performance
const instanceFields =
  "items(id,name,labels,status,lastStartTimestamp,tags,metadata(fingerprint,items/key)," +
  "networkInterfaces(name,networkIP,accessConfigs(name,natIP),ipv6AccessConfigs(externalIpv6))),nextPageToken";
const diskFields = "items(id,name,labels,users),nextPageToken";
const addressFields =
  "items(name,address,addressType,networkTier,status,labels,labelFingerprint,users),nextPageToken";
const operationFields =
  "items(name,status,clientOperationId,insertTime,creationTimestamp),nextPageToken";
// "If your project exceeds a rate quota, you receive a 403 error with the reason
// rateLimitExceeded. ... wait a minute then try your request again."
// https://cloud.google.com/compute/docs/api-rate-limits
const rateLimitBackoffMs = 60_000;
// Operations for a recovered write were sent no earlier than this before its recoverAfter.
const recoveryLookbackMs = 2 * 60 * 60_000;

interface GoogleComputeOptions extends HttpOptions {
  readonly project: string;
  readonly zone: string;
  readonly network: string;
  readonly subnet: string;
  readonly diskType: string;
  readonly diskSizeGb: number;
  readonly actionTimeoutMs: number;
  readonly baseUrl?: URL;
  readonly accessToken?: ComputeAccessToken;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly log?: (entry: Record<string, unknown>) => void;
}

type Check = () => Promise<void>;
type Scope = "zone" | "region" | "global";
type Write = {
  method: "POST" | "DELETE";
  resourceName?: string;
  body?: unknown;
  requestId?: string | undefined;
  query?: Record<string, string>;
  check?: Check | undefined;
  observedVersion?: string | undefined;
};
type Address = z.infer<typeof address>;
interface Inventory {
  readonly instances: Map<string, Instance>;
  readonly addresses: Map<string, Address>;
  disks?: Map<string, Disk>;
  /** Managed instances found in another zone, by the Cloud Computer their labels name. */
  readonly strays: Map<CloudComputerId, { name: string; scope: string }>;
  /** Managed pool host instances found in another zone, by the pool host ID their labels name. */
  readonly poolStrays: Map<BrowserPoolHostId, { name: string; scope: string }>;
}
type PendingOperation = { requestId: string; initial?: Operation };

export class GoogleCompute implements VmProvider, PoolHostProvider {
  readonly #options: GoogleComputeOptions;
  readonly #baseUrl: URL;
  readonly #accessToken: ComputeAccessToken;
  readonly #wait: NonNullable<GoogleComputeOptions["wait"]>;
  readonly #region: string;
  readonly #project: string;
  readonly #network: string;
  readonly #subnet: string;
  readonly #zone: string;
  readonly #pendingOperations = new Map<string, PendingOperation>();
  #inventory: Inventory | undefined;
  #retryAt = 0;

  constructor(options: GoogleComputeOptions) {
    this.#options = options;
    this.#baseUrl = options.baseUrl ?? new URL("https://compute.googleapis.com/compute/v1/");
    this.#accessToken = options.accessToken ?? googleMetadataAccessToken(options);
    this.#wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
    this.#region = options.zone.slice(0, options.zone.lastIndexOf("-"));
    this.#project = `projects/${options.project}`;
    this.#network = `${this.#project}/global/networks/${options.network}`;
    this.#subnet = `${this.#project}/regions/${this.#region}/subnetworks/${options.subnet}`;
    this.#zone = `${this.#project}/zones/${options.zone}`;
  }

  /**
   * Reads the zone's instances and the region's addresses once for the whole pass. Every
   * Cloud Computer in the pass reads from it, and each write refreshes the one resource it
   * changed by name.
   */
  async beginPass(signal: AbortSignal) {
    this.#inventory = undefined;
    const [instances, addresses, strayScan] = await Promise.all([
      this.#list(`${this.#zone}/instances`, instance, signal, { fields: instanceFields }),
      this.#list(this.#addressesPath(), address, signal, { fields: addressFields }),
      this.#strayInstances(signal),
    ]);
    this.#inventory = {
      instances: new Map(instances.map((vm) => [vm.name, vm])),
      addresses: new Map(addresses.map((entry) => [entry.name, entry])),
      strays: strayScan.strays,
      poolStrays: strayScan.poolStrays,
    };
  }

  async ensureFirewall(signal: AbortSignal, check?: Check) {
    // A VPC firewall rule can only have source ranges from one address family.
    // https://cloud.google.com/firewall/docs/firewalls
    const dualStack = await this.#dualStack(signal);
    await this.#ensureFirewallRule("v4", "0.0.0.0/0", signal, check);
    if (dualStack) await this.#ensureFirewallRule("v6", "::/0", signal, check);
    return firewallId;
  }

  async #ensureFirewallRule(suffix: string, range: string, signal: AbortSignal, check?: Check) {
    const name = `${firewallTag}-${suffix}`;
    const path = `${this.#project}/global/firewalls`;
    const expected = {
      name,
      description: "Managed by the Opensteer Home provisioner",
      network: this.#network,
      direction: "INGRESS",
      priority: 1000,
      targetTags: [firewallTag],
      sourceRanges: [range],
      allowed: [{ IPProtocol: "tcp", ports: ["80", "443"] }],
    };
    let current = await this.#get(`${path}/${name}`, firewall, signal);
    if (!current) {
      try {
        await this.#write(path, "global", signal, {
          method: "POST",
          resourceName: name,
          body: expected,
          check,
        });
        return;
      } catch (error) {
        if (!hasStatus(error, 409)) throw error;
        current = await this.#get(`${path}/${name}`, firewall, signal);
        if (!current) throw new ProviderOutcomeUnknown(error);
      }
    }
    if (
      current.name !== name ||
      current.description !== expected.description ||
      !matchesResource(current.network, this.#network) ||
      current.priority !== expected.priority ||
      current.disabled ||
      current.targetTags.length !== 1 ||
      current.targetTags[0] !== firewallTag ||
      current.sourceRanges.length !== 1 ||
      current.sourceRanges[0] !== range ||
      current.allowed.length !== 1 ||
      current.allowed[0]?.IPProtocol !== "tcp" ||
      current.allowed[0].ports.length !== 2 ||
      !["80", "443"].every((port) => current.allowed[0]?.ports.includes(port)) ||
      current.denied.length ||
      current.sourceTags.length ||
      current.sourceServiceAccounts.length ||
      current.targetServiceAccounts.length ||
      current.destinationRanges.length
    ) {
      throw refused(
        "conflict",
        "The Google Cloud Computer firewall does not match the required rules",
      );
    }
  }

  async ensureFirewallAttached(
    server: VmServer<GoogleComputeServerRef>,
    id: number,
    signal: AbortSignal,
    check?: Check,
  ) {
    if (id !== firewallId) return false;
    if (server.firewalls.some((rule) => rule.id === id && rule.status === "applied")) return true;
    const vm = await this.#readRef(server.id, signal, true);
    if (!vm) return false;
    if (vm.tags?.items.includes(firewallTag)) return true;
    if (!vm.tags?.fingerprint) throw refused("conflict", "The Google VM has no tag fingerprint");
    try {
      await this.#write(`${this.#zone}/instances/${vm.name}/setTags`, "zone", signal, {
        method: "POST",
        check,
        body: { fingerprint: vm.tags.fingerprint, items: [...vm.tags.items, firewallTag] },
      });
    } catch (error) {
      if (hasStatus(error, 412)) return false;
      throw error;
    } finally {
      await this.#refreshAfterWrite(vm.name, signal);
    }
    return (await this.#readRef(server.id, signal))?.tags?.items.includes(firewallTag) ?? false;
  }

  /** The subnet's primary IPv4 range, where Homes and pool hosts are created (review S3). */
  async subnetRange(signal: AbortSignal): Promise<string | undefined> {
    return (await this.#request(this.#subnet, subnetwork, signal)).ipCidrRange;
  }

  async #dualStack(signal: AbortSignal) {
    const subnet = await this.#request(this.#subnet, subnetwork, signal);
    if (!matchesResource(subnet.network, this.#network))
      throw refused("conflict", "The Google subnet is on a different network");
    if (subnet.stackType === "IPV4_ONLY") return false;
    if (subnet.stackType === "IPV4_IPV6" && subnet.ipv6AccessType === "EXTERNAL") return true;
    throw refused(
      "conflict",
      "Google Cloud Computers need IPv4 and support dual stack with external IPv6",
    );
  }

  async find(id: CloudComputerId, signal: AbortSignal, expected?: ExpectedVm) {
    if (expected?.providerServerId || expected?.previousProviderServerId)
      throw refused("conflict", "This Cloud Computer is recorded with a different VM provider");
    const stray = this.#inventory?.strays.get(id);
    if (stray)
      throw new ProviderPlacementError(
        `Managed Compute instance ${stray.name} of ${id} is in ${stray.scope}, outside the ` +
          `configured zone ${this.#options.zone}. Nothing is done to this Cloud Computer until ` +
          "an operator deletes or relabels that instance or sets the zone back.",
      );
    const found = new Map<GoogleComputeServerRef, VmServer<GoogleComputeServerRef>>();
    const add = (vm: Instance, generation?: number) => {
      const identity = managedInstance(vm);
      if (identity && identity.id !== id)
        throw refused("conflict", "The Google VM belongs to a different Cloud Computer");
      const observed = googleVm(vm, identity?.generation ?? generation);
      found.set(observed.id, observed);
    };
    const listed = await this.#instances(signal);
    for (const vm of listed) {
      if (managedInstance(vm)?.id === id) add(vm);
    }
    if (!expected) return [...found.values()];

    const generations = new Set([
      expected.generation,
      ...(expected.pendingProviderWrites ?? [])
        .filter(({ kind }) => kind === "create")
        .map(({ generation }) => generation),
    ]);
    for (const generation of generations) {
      const name = instanceName(id, generation);
      if ([...found.keys()].some((ref) => ref.startsWith(`${name}/`))) continue;
      const named = await this.#instance(name, signal);
      if (named) {
        verifyNamedInstance(named, id, generation);
        add(named, generation);
      }
    }
    for (const ref of [expected.providerServerRef, expected.previousProviderServerRef]) {
      if (!ref || found.has(ref)) continue;
      const vm = await this.#readRef(ref, signal);
      if (vm)
        add(
          vm,
          vm.name === instanceName(id, expected.generation)
            ? expected.generation
            : (namedIdentity(vm.name)?.generation ?? expected.generation - 1),
        );
    }
    return [...found.values()];
  }

  async listManaged(signal: AbortSignal) {
    const found = new Map<GoogleComputeServerRef, { id: CloudComputerId; server: VmServer }>();
    for (const vm of await this.#instances(signal)) {
      const identity = managedInstance(vm);
      if (!identity) continue;
      const server = googleVm(vm, identity.generation);
      found.set(server.id, { id: identity.id, server });
    }
    return [...found.values()];
  }

  /**
   * Finds managed instances outside the configured zone. "returnPartialSuccess: Opt-in for
   * partial success behavior which provides partial results in case of failure"; a zone the
   * listing could not reach is logged and skipped, since the configured zone is read on its own.
   * https://cloud.google.com/compute/docs/reference/rest/v1/instances/aggregatedList
   */
  async #strayInstances(signal: AbortSignal) {
    const page = z.object({
      items: z
        .record(
          z.string(),
          z.object({
            instances: z
              .array(z.object({ name: resourceName, labels: labels.default({}) }))
              .default([]),
            warning: z.object({ code: z.string() }).optional(),
          }),
        )
        .default({}),
      nextPageToken: z.string().min(1).optional(),
      unreachables: z.array(z.string()).default([]),
    });
    const strays = new Map<CloudComputerId, { name: string; scope: string }>();
    const poolStrays = new Map<BrowserPoolHostId, { name: string; scope: string }>();
    const unreachable = new Set<string>();
    for await (const result of this.#pages(`${this.#project}/aggregated/instances`, page, signal, {
      returnPartialSuccess: "true",
    })) {
      for (const scope of result.unreachables) unreachable.add(scope);
      for (const [scope, { instances, warning }] of Object.entries(result.items)) {
        if (warning && warning.code !== "NO_RESULTS_ON_PAGE") unreachable.add(scope);
        if (scope === `zones/${this.#options.zone}`) continue;
        for (const vm of instances) {
          const identity = managedIdentity(vm.labels);
          if (identity && !strays.has(identity.id))
            strays.set(identity.id, { name: vm.name, scope });
          const poolIdentity = managedPoolHostIdentity(vm.labels);
          if (poolIdentity && !poolStrays.has(poolIdentity.id))
            poolStrays.set(poolIdentity.id, { name: vm.name, scope });
        }
      }
    }
    if (unreachable.size)
      this.#options.log?.({
        event: "home-provisioner.provider.zones-unreachable",
        scopes: [...unreachable].sort(),
      });
    return { strays, poolStrays };
  }

  async #instances(signal: AbortSignal) {
    if (this.#inventory) return [...this.#inventory.instances.values()];
    return this.#list(`${this.#zone}/instances`, instance, signal, { fields: instanceFields });
  }

  async listManagedAddresses(signal: AbortSignal) {
    const found = this.#inventory
      ? [...this.#inventory.addresses.values()]
      : await this.#list(this.#addressesPath(), address, signal, { fields: addressFields });
    const addresses = new Map<string, VmAddress>();
    for (const entry of found) {
      const identity = managedIdentity(entry.labels);
      if (identity && isManagedAddress(entry, identity)) addresses.set(entry.name, identity);
    }
    return [...addresses.values()];
  }

  async #list<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    parameters: Record<string, string> = {},
  ) {
    const page = z.object({
      items: z.array(schema).default([]),
      nextPageToken: z.string().min(1).optional(),
    });
    const records: T[] = [];
    for await (const result of this.#pages(path, page, signal, parameters))
      records.push(...result.items);
    return records;
  }

  async *#pages<T extends { nextPageToken?: string | undefined }>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    parameters: Record<string, string> = {},
  ) {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ maxResults: "100", ...parameters });
      if (cursor) query.set("pageToken", cursor);
      const response = await this.#request(`${path}?${query}`, schema, signal);
      yield response;
      cursor = response.nextPageToken;
      if (cursor && cursors.has(cursor))
        throw refused("internal", "Invalid Google Compute pagination");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  async create(input: CreateVm, signal: AbortSignal, check?: Check) {
    const { id, generation } = input;
    const name = instanceName(id, generation);
    if (input.region !== this.#region && input.region !== this.#options.zone)
      throw refused("conflict", "This Google provisioner serves a different Cloud Computer region");
    if (input.firewallId !== firewallId)
      throw refused("conflict", "The Google Cloud Computer firewall was not verified");

    const found = await this.#instance(name, signal);
    if (found) return googleVm(verifyNamedInstance(found, id, generation), generation);

    const dualStack = await this.#dualStack(signal);
    const reservation = await this.#reserveAddress(
      { id, generation },
      input.requestId,
      signal,
      check,
    );
    let inserted: Operation;
    try {
      inserted = await this.#write(`${this.#zone}/instances`, "zone", signal, {
        method: "POST",
        resourceName: name,
        requestId: input.requestId,
        check,
        body: {
          name,
          machineType: `${this.#zone}/machineTypes/${input.serverType}`,
          labels: managedLabels({ id, generation }),
          tags: { items: [firewallTag] },
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
              { key: "serial-port-enable", value: "FALSE" },
              { key: "user-data", value: input.userData },
            ],
          },
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: input.image,
                diskType: `${this.#zone}/diskTypes/${this.#options.diskType}`,
                diskSizeGb: String(this.#options.diskSizeGb),
              },
            },
          ],
          networkInterfaces: [
            {
              subnetwork: this.#subnet,
              stackType: dualStack ? "IPV4_IPV6" : "IPV4_ONLY",
              accessConfigs: [
                {
                  type: "ONE_TO_ONE_NAT",
                  name: accessConfigName,
                  natIP: reservation.address,
                  networkTier: "PREMIUM",
                },
              ],
              ...(dualStack
                ? {
                    ipv6AccessConfigs: [
                      { type: "DIRECT_IPV6", name: "External IPv6", networkTier: "PREMIUM" },
                    ],
                  }
                : {}),
            },
          ],
        },
      });
    } catch (error) {
      if (!hasStatus(error, 409)) throw error;
      const existing = await this.#refreshInstance(name, signal);
      if (!existing) throw new ProviderOutcomeUnknown(error);
      return googleVm(verifyNamedInstance(existing, id, generation), generation);
    }
    const observed = await this.#refreshInstance(name, signal).catch((error: unknown) => {
      if (error instanceof ProviderRateLimited) throw error;
      throw new ProviderOutcomeUnknown(error);
    });
    if (!observed || (inserted.targetId && inserted.targetId !== observed.id))
      throw new ProviderOutcomeUnknown();
    // The insert put the address in use.
    if (this.#inventory)
      await this.#refreshAddress(reservation.name, signal).catch(() => {
        this.#inventory = undefined;
      });
    return googleVm(verifyNamedInstance(observed, id, generation), generation);
  }

  /**
   * Reserves the new generation's address before the old machine is stopped, so a refusal (quota
   * or anything else) leaves the running Home as it is. The address name belongs to one
   * generation and is reserved once, so its request id is derived from that name.
   */
  async prepareCreate(target: VmAddress, signal: AbortSignal, check?: Check) {
    await this.#reserveAddress(target, `${target.id}/${target.generation}`, signal, check);
  }

  async #reserveAddress(
    target: VmAddress,
    journalId: string | undefined,
    signal: AbortSignal,
    check?: Check,
  ) {
    const path = this.#addressesPath();
    const name = addressName(target);
    let current = await this.#address(name, signal);
    if (!current) {
      try {
        await this.#write(path, "region", signal, {
          method: "POST",
          resourceName: name,
          requestId: childRequestId(journalId, "address-insert", name),
          check,
          body: {
            name,
            addressType: "EXTERNAL",
            networkTier: "PREMIUM",
            // A regional external address is IPv4; Compute refuses `ipVersion` here ("IP
            // Version is not supported for regional addresses"), it exists for global ones.
            labels: managedLabels(target),
          },
        });
      } catch (error) {
        if (!hasStatus(error, 409)) throw error;
      }
      current = await this.#refreshAddress(name, signal);
    }
    if (!current?.address || current.status === "RESERVING") throw new ProviderOutcomeUnknown();
    // Compute keeps no labels from addresses.insert: "These can only be added or modified by the
    // setLabels method." Label this generation's own reservation (its name is derived from the
    // Cloud Computer and generation), including one an earlier pass reserved but did not label.
    // https://cloud.google.com/compute/docs/reference/rest/v1/addresses
    if (
      Object.keys(current.labels).length === 0 &&
      current.status === "RESERVED" &&
      current.users.length === 0 &&
      current.addressType === "EXTERNAL" &&
      current.networkTier === "PREMIUM"
    ) {
      if (!current.labelFingerprint)
        throw refused("conflict", "The Google address has no label fingerprint");
      try {
        await this.#write(`${path}/${name}/setLabels`, "region", signal, {
          method: "POST",
          requestId: childRequestId(journalId, "address-labels", name),
          check,
          body: { labels: managedLabels(target), labelFingerprint: current.labelFingerprint },
        });
      } catch (error) {
        if (!hasStatus(error, 412)) throw error;
      }
      current = await this.#refreshAddress(name, signal);
      if (!current?.address) throw new ProviderOutcomeUnknown();
    }
    if (!isManagedAddress(current, target))
      throw refused("conflict", "The Google Cloud Computer address name is already in use");
    return { ...current, address: current.address };
  }

  async releaseAddress(target: VmAddress, signal: AbortSignal, check?: Check) {
    const name = addressName(target);
    const path = `${this.#addressesPath()}/${name}`;
    const current = await this.#address(name, signal);
    if (!current) return true;
    if (!isManagedAddress(current, target))
      throw refused("conflict", "The Google Cloud Computer address name is already in use");
    if (current.status !== "RESERVED" || current.users.length) return false;
    try {
      await this.#write(path, "region", signal, {
        method: "DELETE",
        check,
        requestId: childRequestId(name, "address-delete", name),
      });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
    return (await this.#refreshAddress(name, signal)) === undefined;
  }

  #addressesPath() {
    return `${this.#project}/regions/${this.#region}/addresses`;
  }

  async describe(id: GoogleComputeServerRef, signal: AbortSignal, knownGeneration?: number) {
    const vm = await this.#readRef(id, signal);
    return vm
      ? googleVm(
          vm,
          managedInstance(vm)?.generation ?? knownGeneration ?? namedIdentity(vm.name)?.generation,
        )
      : undefined;
  }

  async #readRef(ref: GoogleComputeServerRef, signal: AbortSignal, fresh = false) {
    const [name, id] = ref.split("/") as [string, string];
    const vm = fresh
      ? await this.#refreshInstance(name, signal)
      : await this.#instance(name, signal);
    return vm?.id === id ? vm : undefined;
  }

  /** The instance as this pass's inventory holds it, or read by name outside a pass. */
  async #instance(name: string, signal: AbortSignal) {
    if (this.#inventory) return this.#inventory.instances.get(name);
    return this.#refreshInstance(name, signal);
  }

  /** Reads one instance by name and puts the answer in the inventory. */
  async #refreshInstance(name: string, signal: AbortSignal) {
    const vm = await this.#get(`${this.#zone}/instances/${name}`, instance, signal);
    if (vm && vm.name !== name) throw refused("conflict", "Google returned a different VM name");
    if (this.#inventory) {
      if (vm) this.#inventory.instances.set(name, vm);
      else this.#inventory.instances.delete(name);
    }
    return vm;
  }

  async #address(name: string, signal: AbortSignal) {
    if (this.#inventory) return this.#inventory.addresses.get(name);
    return this.#refreshAddress(name, signal);
  }

  async #refreshAddress(name: string, signal: AbortSignal) {
    const entry = await this.#get(`${this.#addressesPath()}/${name}`, address, signal);
    if (entry && entry.name !== name)
      throw refused("conflict", "Google returned a different address name");
    if (this.#inventory) {
      if (entry) this.#inventory.addresses.set(name, entry);
      else this.#inventory.addresses.delete(name);
    }
    return entry;
  }

  async powerOn(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    check?: Check,
    requestId?: string,
  ) {
    const current = await this.#readRef(id, signal);
    if (!current || current.status === "RUNNING") return;
    try {
      await this.#write(`${this.#zone}/instances/${current.name}/start`, "zone", signal, {
        method: "POST",
        check,
        requestId,
      });
    } finally {
      await this.#refreshAfterWrite(current.name, signal);
    }
  }

  async powerOff(id: GoogleComputeServerRef, signal: AbortSignal, check?: Check) {
    const current = await this.#readRef(id, signal);
    if (!current || ["TERMINATED", "STOPPING", "PENDING_STOP"].includes(current.status)) return;
    // One stop per start of this instance: a provisioner that restarts sends the same id again
    // and Compute answers with the original operation instead of a second stop.
    // https://cloud.google.com/compute/docs/reference/rest/v1/instances/stop
    try {
      await this.#write(`${this.#zone}/instances/${current.name}/stop`, "zone", signal, {
        method: "POST",
        check,
        // Without a start time there is no incarnation to name, so the id stays random.
        ...(current.lastStartTimestamp
          ? { requestId: childRequestId(id, "stop", current.lastStartTimestamp) }
          : { observedVersion: id }),
      });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    } finally {
      await this.#refreshAfterWrite(current.name, signal);
    }
  }

  async delete(id: GoogleComputeServerRef, signal: AbortSignal, check?: Check) {
    const current = await this.#readRef(id, signal);
    if (!current) return;
    // One delete per instance incarnation (the reference carries its numeric id).
    // https://cloud.google.com/compute/docs/reference/rest/v1/instances/delete
    try {
      await this.#write(`${this.#zone}/instances/${current.name}`, "zone", signal, {
        method: "DELETE",
        check,
        requestId: childRequestId(id, "delete", ""),
      });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    } finally {
      await this.#refreshAfterWrite(current.name, signal);
    }
    // Deleting the instance frees its address; the reconciler releases it, as cleanup that
    // cannot hold back the result of the delete itself.
    const identity = managedInstance(current) ?? namedIdentity(current.name);
    if (identity && this.#inventory)
      await this.#refreshAddress(addressName(identity), signal).catch(() => {
        this.#inventory = undefined;
      });
  }

  /**
   * Reads zonal operations newest first ("only sorting by name or creationTimestamp desc is
   * supported", zoneOperations.list) and stops once a page reaches operations older than the
   * write could have sent. `clientOperationId` is "the value of requestId if you provided it".
   * https://cloud.google.com/compute/docs/reference/rest/v1/zoneOperations/list
   * https://cloud.google.com/compute/docs/reference/rest/v1/zoneOperations
   */
  async canRecoverWrite(write: CloudComputerProviderWrite, signal: AbortSignal) {
    if (!write.dispatched) return true;
    const recoverAfter = write.recoverAfter ? Date.parse(write.recoverAfter) : Number.NaN;
    const oldest = Number.isFinite(recoverAfter) ? recoverAfter - recoveryLookbackMs : undefined;
    const page = z.object({
      items: z.array(operation).default([]),
      nextPageToken: z.string().min(1).optional(),
    });
    const matches: Operation[] = [];
    for await (const result of this.#pages(`${this.#zone}/operations`, page, signal, {
      orderBy: "creationTimestamp desc",
      fields: operationFields,
    })) {
      matches.push(
        ...result.items.filter(({ clientOperationId }) => clientOperationId === write.token),
      );
      const last = result.items.at(-1);
      const time = last ? Date.parse(last.insertTime ?? last.creationTimestamp ?? "") : Number.NaN;
      if (oldest !== undefined && Number.isFinite(time) && time < oldest) break;
    }
    return matches.every(({ status }) => status === "DONE");
  }

  async updateBootstrap(
    id: GoogleComputeServerRef,
    receiptRecorded: boolean,
    signal: AbortSignal,
    check?: Check,
  ) {
    return this.#updateBootstrapMetadata(id, receiptRecorded, false, signal, check);
  }

  async #updateBootstrapMetadata(
    id: GoogleComputeServerRef,
    done: boolean,
    keepReadyKey: boolean,
    signal: AbortSignal,
    check?: Check,
  ) {
    const vm = await this.#readRef(id, signal, true);
    if (!vm) return false;
    if (!vm.metadata) return true;
    const items = vm.metadata.items;
    const hasUserData = items.some(({ key }) => key === "user-data");
    const hasReady = items.some(({ key }) => key === googleBootstrapReadyKey);
    if (!done && (!hasUserData || hasReady)) return true;
    if (done && !hasUserData && (keepReadyKey || !hasReady)) return true;
    try {
      await this.#write(`${this.#zone}/instances/${vm.name}/setMetadata`, "zone", signal, {
        method: "POST",
        check,
        observedVersion: `${id}/${vm.metadata.fingerprint}`,
        body: {
          fingerprint: vm.metadata.fingerprint,
          items: done
            ? items.filter(
                ({ key }) =>
                  key !== "user-data" && (keepReadyKey || key !== googleBootstrapReadyKey),
              )
            : [...items, { key: googleBootstrapReadyKey, value: "1" }],
        },
      });
    } catch (error) {
      if (hasStatus(error, 412)) return false;
      throw error;
    } finally {
      await this.#refreshAfterWrite(vm.name, signal);
    }
    if (done) {
      const updated = await this.#readRef(id, signal);
      return updated !== undefined && bootstrapMetadata(updated, keepReadyKey) === "absent";
    }
    return true;
  }

  // --- Browser pool host provider (PoolHostProvider) ---

  async ensurePoolFirewalls(config: PoolFirewallConfig, signal: AbortSignal, check?: Check) {
    const homePorts = [...new Set([String(config.agentPort), String(config.relayPort)])].sort();
    await this.#ensurePoolFirewallRule(
      {
        name: poolFirewallHomeName,
        description: "Managed by the Opensteer Home provisioner (browser pool Home ingress)",
        sourceTags: [firewallTag],
        sourceRanges: [],
        ports: homePorts,
      },
      signal,
      check,
    );
    await this.#ensurePoolFirewallRule(
      {
        name: poolFirewallAdminName,
        description: "Managed by the Opensteer Home provisioner (browser pool admin ingress)",
        sourceTags: [],
        sourceRanges: [config.provisionerCidr],
        ports: [String(config.adminPort)],
      },
      signal,
      check,
    );
  }

  async #ensurePoolFirewallRule(
    rule: {
      name: string;
      description: string;
      sourceTags: string[];
      sourceRanges: string[];
      ports: string[];
    },
    signal: AbortSignal,
    check?: Check,
  ) {
    const path = `${this.#project}/global/firewalls`;
    const expected = {
      name: rule.name,
      description: rule.description,
      network: this.#network,
      direction: "INGRESS",
      priority: 1000,
      targetTags: [poolFirewallTag],
      ...(rule.sourceTags.length ? { sourceTags: rule.sourceTags } : {}),
      ...(rule.sourceRanges.length ? { sourceRanges: rule.sourceRanges } : {}),
      allowed: [{ IPProtocol: "tcp", ports: rule.ports }],
    };
    let current = await this.#get(`${path}/${rule.name}`, firewall, signal);
    if (!current) {
      try {
        await this.#write(path, "global", signal, {
          method: "POST",
          resourceName: rule.name,
          body: expected,
          check,
        });
        return;
      } catch (error) {
        if (!hasStatus(error, 409)) throw error;
        current = await this.#get(`${path}/${rule.name}`, firewall, signal);
        if (!current) throw new ProviderOutcomeUnknown(error);
      }
    }
    const sortedPorts = [...(current.allowed[0]?.ports ?? [])].sort();
    if (
      current.name !== rule.name ||
      current.description !== rule.description ||
      !matchesResource(current.network, this.#network) ||
      current.priority !== expected.priority ||
      current.disabled ||
      current.targetTags.length !== 1 ||
      current.targetTags[0] !== poolFirewallTag ||
      !sameStringSet(current.sourceTags, rule.sourceTags) ||
      !sameStringSet(current.sourceRanges, rule.sourceRanges) ||
      current.allowed.length !== 1 ||
      current.allowed[0]?.IPProtocol !== "tcp" ||
      !sameStringSet(sortedPorts, rule.ports) ||
      current.denied.length ||
      current.sourceServiceAccounts.length ||
      current.targetServiceAccounts.length ||
      current.destinationRanges.length
    ) {
      throw refused(
        "conflict",
        "The Google browser pool firewall does not match the required rules",
      );
    }
  }

  async #ensureDiskInventory(signal: AbortSignal) {
    if (!this.#inventory) return undefined;
    if (!this.#inventory.disks) {
      const listed = await this.#list(`${this.#zone}/disks`, disk, signal, { fields: diskFields });
      this.#inventory.disks = new Map(listed.map((entry) => [entry.name, entry]));
    }
    return this.#inventory.disks;
  }

  async #disk(name: string, signal: AbortSignal) {
    const cache = await this.#ensureDiskInventory(signal);
    if (cache) return cache.get(name);
    return this.#refreshDisk(name, signal);
  }

  async #refreshDisk(name: string, signal: AbortSignal) {
    const entry = await this.#get(`${this.#zone}/disks/${name}`, disk, signal);
    if (entry && entry.name !== name)
      throw refused("conflict", "Google returned a different disk name");
    if (this.#inventory?.disks) {
      if (entry) this.#inventory.disks.set(name, entry);
      else this.#inventory.disks.delete(name);
    }
    return entry;
  }

  async ensurePoolProfileDisk(input: EnsurePoolProfileDisk, signal: AbortSignal, check?: Check) {
    let current = await this.#disk(input.diskName, signal);
    if (!current) {
      try {
        await this.#write(`${this.#zone}/disks`, "zone", signal, {
          method: "POST",
          resourceName: input.diskName,
          requestId: input.requestId,
          check,
          body: {
            name: input.diskName,
            sizeGb: String(input.sizeGb),
            type: `${this.#zone}/diskTypes/${input.diskType}`,
            labels: { [poolHostLabel]: input.hostId, [managedLabel]: managedBy },
          },
        });
      } catch (error) {
        if (!hasStatus(error, 409)) throw error;
      }
      current = await this.#refreshDisk(input.diskName, signal);
    }
    if (!current) throw new ProviderOutcomeUnknown();
    if (!isManagedPoolDisk(current, input.hostId)) {
      throw refused("conflict", "The Google browser pool profile disk belongs to another host");
    }
    return poolDisk(current, input.hostId);
  }

  async findPoolProfileDisk(diskName: string, signal: AbortSignal) {
    const entry = await this.#disk(diskName, signal);
    if (!entry) return undefined;
    const hostId = managedPoolDiskHostId(entry.labels);
    return hostId ? poolDisk(entry, hostId) : undefined;
  }

  async deletePoolProfileDisk(
    diskName: string,
    hostId: BrowserPoolHostId,
    signal: AbortSignal,
    check?: Check,
  ) {
    const current = await this.#refreshDisk(diskName, signal);
    if (!current) return true;
    if (!isManagedPoolDisk(current, hostId)) {
      throw refused("conflict", "The Google browser pool profile disk belongs to another host");
    }
    if (current.users.length > 0) return false;
    try {
      await this.#write(`${this.#zone}/disks/${current.name}`, "zone", signal, {
        method: "DELETE",
        check,
        requestId: childRequestId(`${current.name}/${current.id}`, "disk-delete", ""),
      });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
    return (await this.#refreshDisk(diskName, signal)) === undefined;
  }

  async listManagedPoolDisks(signal: AbortSignal) {
    const cache = await this.#ensureDiskInventory(signal);
    const listed = cache
      ? [...cache.values()]
      : await this.#list(`${this.#zone}/disks`, disk, signal, { fields: diskFields });
    const found: PoolProfileDisk[] = [];
    for (const entry of listed) {
      const hostId = managedPoolDiskHostId(entry.labels);
      if (hostId) found.push(poolDisk(entry, hostId));
    }
    return found;
  }

  async findPoolHost(id: BrowserPoolHostId, signal: AbortSignal, expected?: ExpectedPoolHostVm) {
    const stray = this.#inventory?.poolStrays.get(id);
    if (stray) {
      throw new ProviderPlacementError(
        `Managed Compute pool host ${stray.name} of ${id} is in ${stray.scope}, outside the ` +
          `configured zone ${this.#options.zone}. Nothing is done to this pool host until ` +
          "an operator deletes or relabels that instance or sets the zone back.",
      );
    }
    const found = new Map<GoogleComputeServerRef, PoolHostVm>();
    const add = (vm: Instance, generation?: number) => {
      const identity = managedPoolHostIdentity(vm.labels);
      if (identity && identity.id !== id) {
        throw refused("conflict", "The Google VM belongs to a different browser pool host");
      }
      const observed = googlePoolHostVm(vm, identity?.generation ?? generation);
      found.set(observed.id, observed);
    };
    for (const vm of await this.#instances(signal)) {
      if (managedPoolHostIdentity(vm.labels)?.id === id) add(vm);
    }
    if (!expected) return [...found.values()];

    const generations = new Set([
      expected.generation,
      ...(expected.pendingProviderWrites ?? [])
        .filter(({ kind }) => kind === "create")
        .map(({ generation }) => generation),
    ]);
    for (const generation of generations) {
      const name = poolHostInstanceName(id, generation);
      if ([...found.keys()].some((ref) => ref.startsWith(`${name}/`))) continue;
      const named = await this.#instance(name, signal);
      if (named) {
        verifyNamedPoolHostInstance(named, id, generation);
        add(named, generation);
      }
    }
    for (const ref of [expected.providerServerRef, expected.previousProviderServerRef]) {
      if (!ref || found.has(ref)) continue;
      const vm = await this.#readRef(ref, signal);
      if (vm) {
        add(
          vm,
          vm.name === poolHostInstanceName(id, expected.generation)
            ? expected.generation
            : (namedPoolHostIdentity(vm.name)?.generation ?? expected.generation - 1),
        );
      }
    }
    return [...found.values()];
  }

  async listManagedPoolHosts(signal: AbortSignal) {
    const found = new Map<GoogleComputeServerRef, { id: BrowserPoolHostId; server: PoolHostVm }>();
    for (const vm of await this.#instances(signal)) {
      const identity = managedPoolHostIdentity(vm.labels);
      if (!identity) continue;
      const server = googlePoolHostVm(vm, identity.generation);
      found.set(server.id, { id: identity.id, server });
    }
    return [...found.values()];
  }

  async createPoolHost(input: CreatePoolHostVm, signal: AbortSignal, check?: Check) {
    const { id, generation } = input;
    const name = poolHostInstanceName(id, generation);
    const found = await this.#instance(name, signal);
    if (found)
      return googlePoolHostVm(verifyNamedPoolHostInstance(found, id, generation), generation);

    const localSsds = Array.from({ length: input.localSsdCount }, () => ({
      type: "SCRATCH",
      autoDelete: true,
      interface: "NVME",
      initializeParams: {
        diskType: `${this.#zone}/diskTypes/local-ssd`,
      },
    }));

    let inserted: Operation;
    try {
      inserted = await this.#write(`${this.#zone}/instances`, "zone", signal, {
        method: "POST",
        resourceName: name,
        requestId: input.requestId,
        check,
        body: {
          name,
          machineType: `${this.#zone}/machineTypes/${input.machineType}`,
          labels: {
            [poolHostLabel]: id,
            [managedLabel]: managedBy,
            [generationLabel]: String(generation),
          },
          tags: { items: [poolFirewallTag] },
          advancedMachineFeatures: {
            enableNestedVirtualization: true,
            threadsPerCore: 1,
          },
          shieldedInstanceConfig: {
            enableSecureBoot: true,
            enableVtpm: true,
            enableIntegrityMonitoring: true,
          },
          scheduling: {
            automaticRestart: true,
            onHostMaintenance: "TERMINATE",
            provisioningModel: "STANDARD",
          },
          serviceAccounts: [],
          metadata: {
            items: [
              { key: "enable-oslogin", value: "TRUE" },
              { key: "block-project-ssh-keys", value: "TRUE" },
              { key: "disable-legacy-endpoints", value: "TRUE" },
              { key: "serial-port-enable", value: "FALSE" },
              { key: "user-data", value: input.userData },
            ],
          },
          disks: [
            {
              boot: true,
              autoDelete: true,
              initializeParams: {
                sourceImage: input.image,
                diskType: `${this.#zone}/diskTypes/${this.#options.diskType}`,
                diskSizeGb: String(input.bootDiskSizeGb),
              },
            },
            {
              boot: false,
              autoDelete: false,
              mode: "READ_WRITE",
              deviceName: poolProfileDiskDeviceName,
              source: `${this.#zone}/disks/${input.profileDiskName}`,
            },
            ...localSsds,
          ],
          // --no-address: internal VPC IP only; outbound HTTPS uses Cloud NAT.
          networkInterfaces: [
            {
              subnetwork: this.#subnet,
              stackType: "IPV4_ONLY",
            },
          ],
        },
      });
    } catch (error) {
      if (!hasStatus(error, 409)) throw error;
      const existing = await this.#refreshInstance(name, signal);
      if (!existing) throw new ProviderOutcomeUnknown(error);
      return googlePoolHostVm(verifyNamedPoolHostInstance(existing, id, generation), generation);
    }
    const observed = await this.#refreshInstance(name, signal).catch((error: unknown) => {
      if (error instanceof ProviderRateLimited) throw error;
      throw new ProviderOutcomeUnknown(error);
    });
    if (!observed || (inserted.targetId && inserted.targetId !== observed.id)) {
      throw new ProviderOutcomeUnknown();
    }
    return googlePoolHostVm(verifyNamedPoolHostInstance(observed, id, generation), generation);
  }

  async describePoolHost(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    knownGeneration?: number,
  ) {
    const vm = await this.#readRef(id, signal);
    return vm
      ? googlePoolHostVm(
          vm,
          managedPoolHostIdentity(vm.labels)?.generation ??
            knownGeneration ??
            namedPoolHostIdentity(vm.name)?.generation,
        )
      : undefined;
  }

  async powerOnPoolHost(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    check?: Check,
    requestId?: string,
  ) {
    return this.powerOn(id, signal, check, requestId);
  }

  async deletePoolHost(id: GoogleComputeServerRef, signal: AbortSignal, check?: Check) {
    return this.delete(id, signal, check);
  }

  async updatePoolHostBootstrap(
    id: GoogleComputeServerRef,
    enrolled: boolean,
    signal: AbortSignal,
    check?: Check,
  ) {
    // Z1 + J7: Pool host metadata scrub removes `user-data` (the secret carrier) and keeps
    // `opensteer-bootstrap-ready` intact (non-secret) so a re-run of `opensteer-pool-download.service`
    // after a failure between `boot-complete` and `systemctl enable` (or before token removal) can
    // still pass the metadata gate and finish cleanly.
    return this.#updateBootstrapMetadata(id, enrolled, true, signal, check);
  }

  async canRecoverPoolHostWrite(write: BrowserPoolHostProviderWrite, signal: AbortSignal) {
    return this.canRecoverWrite(
      {
        token: write.token,
        kind: write.kind === "create-disk" ? "create" : write.kind,
        generation: write.generation,
        ...(write.serverRef ? { serverRef: write.serverRef } : {}),
        ...(write.recoverAfter ? { recoverAfter: write.recoverAfter } : {}),
        ...(write.dispatched !== undefined ? { dispatched: write.dispatched } : {}),
      },
      signal,
    );
  }

  async #get<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal) {
    try {
      return await this.#request(path, schema, signal);
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
      return undefined;
    }
  }

  async #write(path: string, scope: Scope, shutdown: AbortSignal, write: Write) {
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(this.#options.actionTimeoutMs)]);
    const query = new URLSearchParams(write.query);
    const key = JSON.stringify([
      path,
      write.method,
      write.resourceName,
      query.toString(),
      write.requestId ?? write.observedVersion,
    ]);
    const prior = this.#pendingOperations.get(key);
    const pending: PendingOperation = prior ?? { requestId: write.requestId ?? randomUUID() };
    const initial =
      pending.initial ?? (await this.#dispatch(path, query, write, pending, key, signal));
    let current = initial;
    try {
      while (current.status !== "DONE") {
        await this.#wait(1_000, signal);
        current = await this.#request(this.#operationPath(scope, initial.name), operation, signal);
        if (current.name !== initial.name)
          throw refused("conflict", "Google returned a different operation");
      }
    } catch (error) {
      // The operation stays recorded in memory; the next pass resumes polling it.
      if (error instanceof ProviderRateLimited) throw error;
      throw new ProviderOutcomeUnknown(error);
    }
    this.#pendingOperations.delete(key);
    if (current.error || current.httpErrorStatusCode)
      throw new ProviderWriteRejected(
        new RemoteRequestError(
          compute,
          current.httpErrorStatusCode ?? 500,
          undefined,
          operationErrorCodes(current),
        ),
      );
    return { ...current, targetId: current.targetId ?? initial.targetId };
  }

  async #dispatch(
    path: string,
    query: URLSearchParams,
    write: Write,
    pending: PendingOperation,
    key: string,
    signal: AbortSignal,
  ) {
    let token: string;
    try {
      token = await this.#authenticate(signal);
    } catch (error) {
      throw new ProviderWriteRejected(
        error instanceof Error ? error : new Error("Google authentication failed"),
      );
    }
    await write.check?.();
    signal.throwIfAborted();
    // Compute deduplicates a repeated requestId when the original response was lost.
    // https://cloud.google.com/compute/docs/reference/rest/v1/instances/insert
    query.set("requestId", pending.requestId);
    this.#pendingOperations.set(key, pending);
    try {
      pending.initial = await this.#request(`${path}?${query}`, operation, signal, write, token);
      return pending.initial;
    } catch (error) {
      // A rate-limited request was not carried out: the write is rejected for now.
      if (error instanceof ProviderRateLimited) {
        this.#pendingOperations.delete(key);
        throw new ProviderWriteRejected(error);
      }
      if (
        error instanceof RemoteRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        this.#pendingOperations.delete(key);
        throw new ProviderWriteRejected(error);
      }
      throw new ProviderOutcomeUnknown(error);
    }
  }

  /** Refreshes an instance after a write; a rate limit there must not hide the write's own result. */
  async #refreshAfterWrite(name: string, signal: AbortSignal) {
    if (!this.#inventory) return;
    try {
      await this.#refreshInstance(name, signal);
    } catch {
      // Without a fresh copy of this instance the pass reads by name from here on.
      this.#inventory = undefined;
    }
  }

  #operationPath(scope: Scope, name: string) {
    const location =
      scope === "zone"
        ? this.#zone
        : scope === "region"
          ? `${this.#project}/regions/${this.#region}`
          : `${this.#project}/global`;
    return `${location}/operations/${name}`;
  }

  async #authenticate(signal: AbortSignal) {
    const token = await this.#accessToken.getAccessToken(signal);
    if (!token || token.length > 8192 || /\s/u.test(token))
      throw new RemoteRequestError(compute, 401);
    return token;
  }

  async #request<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    write?: Write,
    accessToken?: string,
  ) {
    if (Date.now() < this.#retryAt) throw new ProviderRateLimited(this.#retryAt);
    const token = accessToken ?? (await this.#authenticate(signal));
    try {
      return await request(
        compute,
        new URL(path, this.#baseUrl),
        this.#options,
        signal,
        json(schema),
        {
          ...(write ? { method: write.method, body: write.body } : {}),
          headers: { authorization: `Bearer ${token}` },
          errorReasons: true,
        },
      );
    } catch (error) {
      if (hasStatus(error, 401)) this.#accessToken.invalidate?.(token);
      const failure = httpFailure(error);
      if (isRateLimited(failure)) {
        this.#retryAt = Math.max(
          this.#retryAt,
          failure.retryAt ?? 0,
          Date.now() + rateLimitBackoffMs,
        );
        throw new ProviderRateLimited(this.#retryAt, failure);
      }
      throw error;
    }
  }
}

function isRateLimited(error: unknown): error is RemoteRequestError {
  return (
    error instanceof RemoteRequestError &&
    error.service === compute &&
    (error.status === 429 ||
      (error.status === 403 &&
        error.reasons.some((reason) => /^(rateLimitExceeded|RATE_LIMIT_EXCEEDED)$/u.test(reason))))
  );
}

function operationErrorCodes(operation: Operation): string[] {
  return (operation.error?.errors ?? []).flatMap((entry) => {
    const code = (entry as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^[A-Za-z0-9_.-]{1,128}$/u.test(code) ? [code] : [];
  });
}

function matchesResource(resource: string, path: string) {
  return resource === path || resource.endsWith(`/compute/v1/${path}`);
}

/** The HTTP failure under an error: a failed GET's comes inside an `ObservationFailed`. */
function httpFailure(error: unknown): unknown {
  const cause = error instanceof ProviderWriteRejected ? error.original : error;
  return cause instanceof ObservationFailed ? cause.cause : cause;
}

function hasStatus(error: unknown, status: number): boolean {
  const cause = httpFailure(error);
  return (
    cause instanceof RemoteRequestError && cause.service === compute && cause.status === status
  );
}

function managedLabels({ id, generation }: VmAddress) {
  return { [homeLabel]: id, [managedLabel]: managedBy, [generationLabel]: String(generation) };
}

function instanceName(id: CloudComputerId, generation: number) {
  return `os-${id.replace("_", "-")}-${generation}`;
}

function addressName({ id, generation }: VmAddress) {
  return `${instanceName(id, generation)}-ip`;
}

function childRequestId(journalId: string | undefined, kind: string, name: string) {
  if (!journalId) return undefined;
  const hex = createHash("sha256")
    .update(JSON.stringify([journalId, kind, name]))
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function namedIdentity(name: string) {
  const match = /^os-cc-([a-f0-9-]{36})-([1-9][0-9]{0,15})$/u.exec(name);
  if (!match) return undefined;
  const id = CloudComputerIdSchema.safeParse(`cc_${match[1]}`);
  const generation = CloudComputerGenerationSchema.safeParse(Number(match[2]));
  return id.success && generation.success
    ? { id: id.data, generation: generation.data }
    : undefined;
}

function managedInstance(vm: Instance) {
  return managedIdentity(vm.labels);
}

function managedIdentity(labels: Instance["labels"]): VmAddress | undefined {
  if (labels[managedLabel] !== managedBy) return undefined;
  const id = CloudComputerIdSchema.safeParse(labels[homeLabel]);
  const generation = CloudComputerGenerationSchema.safeParse(Number(labels[generationLabel]));
  return id.success && generation.success
    ? { id: id.data, generation: generation.data }
    : undefined;
}

function verifyNamedInstance(vm: Instance, id: CloudComputerId, generation: number) {
  if (
    vm.name !== instanceName(id, generation) ||
    (vm.labels[homeLabel] !== undefined && vm.labels[homeLabel] !== id) ||
    (vm.labels[generationLabel] !== undefined &&
      vm.labels[generationLabel] !== String(generation)) ||
    (vm.labels[managedLabel] !== undefined && vm.labels[managedLabel] !== managedBy)
  )
    throw refused("conflict", "The Google VM's labels differ from its Cloud Computer name");
  return vm;
}

function isManagedAddress(entry: z.infer<typeof address>, target: VmAddress) {
  return (
    entry.name === addressName(target) &&
    entry.labels[homeLabel] === target.id &&
    entry.labels[generationLabel] === String(target.generation) &&
    entry.labels[managedLabel] === managedBy &&
    entry.addressType === "EXTERNAL" &&
    entry.networkTier === "PREMIUM" &&
    (entry.address === undefined || z.ipv4().safeParse(entry.address).success)
  );
}

function bootstrapMetadata(
  vm: Instance,
  keepReadyKey = false,
): NonNullable<VmServer["bootstrapMetadata"]> {
  const hasUserData = vm.metadata?.items.some(({ key }) => key === "user-data") ?? false;
  const hasReady = vm.metadata?.items.some(({ key }) => key === googleBootstrapReadyKey) ?? false;
  if (keepReadyKey) {
    if (!hasUserData) return "absent";
    return hasReady ? "enabled" : "pending";
  }
  if (hasReady) return "enabled";
  return hasUserData ? "pending" : "absent";
}

function googleVm(vm: Instance, generation?: number): VmServer<GoogleComputeServerRef> {
  if (!generation) throw refused("conflict", "The Google VM has no Cloud Computer generation");
  const nic = vm.networkInterfaces[0];
  return {
    id: GoogleComputeServerRefSchema.parse(`${vm.name}/${vm.id}`),
    generation,
    status:
      vm.status === "RUNNING" ? "running" : vm.status === "TERMINATED" ? "off" : "transitioning",
    ipv4: nic?.accessConfigs[0]?.natIP ?? null,
    ipv6: nic?.ipv6AccessConfigs[0]?.externalIpv6 ?? null,
    internalIpv4: nic?.networkIP ?? null,
    bootstrapMetadata: bootstrapMetadata(vm),
    firewalls: vm.tags?.items.includes(firewallTag) ? [{ id: firewallId, status: "applied" }] : [],
  };
}

function poolHostInstanceName(id: BrowserPoolHostId, generation: number) {
  return `osp-${id.replace("_", "-")}-${generation}`;
}

function namedPoolHostIdentity(name: string) {
  const match = /^osp-ph-([a-f0-9-]{36})-([1-9][0-9]{0,15})$/u.exec(name);
  if (!match) return undefined;
  const id = BrowserPoolHostIdSchema.safeParse(`ph_${match[1]}`);
  const generation = CloudComputerGenerationSchema.safeParse(Number(match[2]));
  return id.success && generation.success
    ? { id: id.data, generation: generation.data }
    : undefined;
}

function managedPoolHostIdentity(
  instanceLabels: Instance["labels"],
): { id: BrowserPoolHostId; generation: number } | undefined {
  if (instanceLabels[managedLabel] !== managedBy) return undefined;
  const id = BrowserPoolHostIdSchema.safeParse(instanceLabels[poolHostLabel]);
  const generation = CloudComputerGenerationSchema.safeParse(
    Number(instanceLabels[generationLabel]),
  );
  return id.success && generation.success
    ? { id: id.data, generation: generation.data }
    : undefined;
}

function managedPoolDiskHostId(diskLabels: Disk["labels"]): BrowserPoolHostId | undefined {
  if (diskLabels[managedLabel] !== managedBy) return undefined;
  const parsed = BrowserPoolHostIdSchema.safeParse(diskLabels[poolHostLabel]);
  return parsed.success ? parsed.data : undefined;
}

function isManagedPoolDisk(entry: Disk, hostId: BrowserPoolHostId) {
  return entry.labels[managedLabel] === managedBy && entry.labels[poolHostLabel] === hostId;
}

function poolDisk(entry: Disk, hostId: BrowserPoolHostId): PoolProfileDisk {
  return {
    name: entry.name,
    ref: BrowserPoolDiskRefSchema.parse(`${entry.name}/${entry.id}`),
    hostId,
  };
}

function verifyNamedPoolHostInstance(vm: Instance, id: BrowserPoolHostId, generation: number) {
  if (
    vm.name !== poolHostInstanceName(id, generation) ||
    (vm.labels[poolHostLabel] !== undefined && vm.labels[poolHostLabel] !== id) ||
    (vm.labels[generationLabel] !== undefined &&
      vm.labels[generationLabel] !== String(generation)) ||
    (vm.labels[managedLabel] !== undefined && vm.labels[managedLabel] !== managedBy)
  ) {
    throw refused("conflict", "The Google VM's labels differ from its browser pool host name");
  }
  return vm;
}

function googlePoolHostVm(vm: Instance, generation?: number): PoolHostVm {
  if (!generation) throw refused("conflict", "The Google VM has no browser pool host generation");
  const nic = vm.networkInterfaces[0];
  return {
    id: GoogleComputeServerRefSchema.parse(`${vm.name}/${vm.id}`),
    generation,
    status:
      vm.status === "RUNNING" ? "running" : vm.status === "TERMINATED" ? "off" : "transitioning",
    internalIpv4: nic?.networkIP ?? null,
    bootstrapMetadata: bootstrapMetadata(vm, true),
  };
}
