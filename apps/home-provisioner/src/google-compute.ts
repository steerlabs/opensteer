import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CloudComputerGenerationSchema,
  CloudComputerIdSchema,
  GoogleComputeServerRefSchema,
  type CloudComputerId,
  type CloudComputerProviderWrite,
  type GoogleComputeServerRef,
} from "@opensteer/control-plane-protocol";
import { refused } from "@opensteer/core";
import { z } from "zod";
import { type ComputeAccessToken, googleMetadataAccessToken } from "./google-auth.js";
import {
  json,
  ProviderOutcomeUnknown,
  ProviderWriteRejected,
  RemoteRequestError,
  request,
  type HttpOptions,
} from "./http.js";
import { googleBootstrapReadyKey } from "./boot.js";
import type { CreateVm, ExpectedVm, VmProvider, VmServer } from "./provider.js";

const homeLabel = "opensteer-cloud-computer";
const generationLabel = "opensteer-generation";
const managedLabel = "opensteer-managed-by";
const managedBy = "home-provisioner";
const firewallTag = "opensteer-cloud-computers";
const firewallId = 1;
const accessConfigName = "External NAT";
const compute = "Google Compute Engine";

const resourceName = z.string().regex(/^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/u);
const numericId = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const labels = z.record(z.string(), z.string());
const operation = z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u),
  status: z.enum(["PENDING", "RUNNING", "DONE"]),
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
  items: z.array(z.object({ key: z.string(), value: z.string() })).default([]),
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
        accessConfigs: z
          .array(z.object({ name: z.string(), natIP: z.ipv4().optional() }))
          .default([]),
        ipv6AccessConfigs: z.array(z.object({ externalIpv6: z.ipv6().optional() })).default([]),
      }),
    )
    .default([]),
});
type Instance = z.infer<typeof instance>;
const address = z.object({
  name: resourceName,
  address: z.ipv4().optional(),
  addressType: z.literal("EXTERNAL"),
  networkTier: z.literal("PREMIUM"),
  status: z.enum(["RESERVING", "RESERVED", "IN_USE"]),
  labels: labels.default({}),
  users: z.array(z.string()).default([]),
});
const subnetwork = z.object({
  network: z.string(),
  stackType: z.enum(["IPV4_ONLY", "IPV4_IPV6", "IPV6_ONLY"]).default("IPV4_ONLY"),
  ipv6AccessType: z.enum(["EXTERNAL", "INTERNAL"]).optional(),
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
}

type Check = () => Promise<void>;
type Scope = "zone" | "region" | "global";
type Write = {
  method: "POST" | "DELETE";
  body?: unknown;
  requestId?: string | undefined;
  query?: Record<string, string>;
  check?: Check | undefined;
  observedVersion?: string | undefined;
  instanceAction?: { type: "stop" | "delete"; targetId: string };
};
type PendingOperation = { requestId: string; initial?: Operation };

export class GoogleCompute implements VmProvider {
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
        await this.#write(path, "global", signal, { method: "POST", body: expected, check });
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
    const vm = await this.#readRef(server.id, signal);
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
    }
    return (await this.#readRef(server.id, signal))?.tags?.items.includes(firewallTag) ?? false;
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
    const found = new Map<GoogleComputeServerRef, VmServer<GoogleComputeServerRef>>();
    const add = (vm: Instance, generation?: number) => {
      const identity = managedInstance(vm);
      if (identity && identity.id !== id)
        throw refused("conflict", "The Google VM belongs to a different Cloud Computer");
      const observed = googleVm(vm, identity?.generation ?? generation);
      found.set(observed.id, observed);
    };
    const listed = await this.#instances(signal, `labels.${homeLabel} = ${id}`);
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

  async #instances(signal: AbortSignal, filter?: string) {
    return this.#list(
      `${this.#zone}/instances`,
      instance,
      signal,
      `(labels.${managedLabel} = ${managedBy})${filter ? ` AND (${filter})` : ""}`,
    );
  }

  async listManagedAddresses(signal: AbortSignal) {
    const found = await this.#list(
      this.#addressesPath(),
      address,
      signal,
      `labels.${managedLabel} = ${managedBy}`,
    );
    const ids = new Set<CloudComputerId>();
    for (const entry of found) {
      const id = CloudComputerIdSchema.safeParse(entry.labels[homeLabel]);
      if (id.success && isManagedAddress(entry, id.data)) ids.add(id.data);
    }
    return [...ids];
  }

  async #list<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal, filter: string) {
    const page = z.object({
      items: z.array(schema).default([]),
      nextPageToken: z.string().min(1).optional(),
    });
    const records: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ filter, maxResults: "100" });
      if (cursor) query.set("pageToken", cursor);
      const response = await this.#request(`${path}?${query}`, page, signal);
      records.push(...response.items);
      cursor = response.nextPageToken;
      if (cursor && cursors.has(cursor))
        throw refused("internal", "Invalid Google Compute pagination");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return records;
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
    const reservation = await this.#reserveAddress(id, signal, check);
    await this.#detachPreviousAddress(input, reservation, signal, check);
    let inserted: Operation;
    try {
      inserted = await this.#write(`${this.#zone}/instances`, "zone", signal, {
        method: "POST",
        requestId: input.requestId,
        check,
        body: {
          name,
          machineType: `${this.#zone}/machineTypes/${input.serverType}`,
          labels: { ...managedLabels(id), [generationLabel]: String(generation) },
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
              network: this.#network,
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
      const existing = await this.#instance(name, signal);
      if (!existing) throw new ProviderOutcomeUnknown(error);
      return googleVm(verifyNamedInstance(existing, id, generation), generation);
    }
    const observed = await this.#instance(name, signal).catch((error: unknown) => {
      throw new ProviderOutcomeUnknown(error);
    });
    if (!observed || (inserted.targetId && inserted.targetId !== observed.id))
      throw new ProviderOutcomeUnknown();
    return googleVm(verifyNamedInstance(observed, id, generation), generation);
  }

  async #reserveAddress(id: CloudComputerId, signal: AbortSignal, check?: Check) {
    const path = this.#addressesPath();
    const name = addressName(id);
    let current = await this.#get(`${path}/${name}`, address, signal);
    if (!current) {
      try {
        await this.#write(path, "region", signal, {
          method: "POST",
          check,
          body: {
            name,
            addressType: "EXTERNAL",
            networkTier: "PREMIUM",
            ipVersion: "IPV4",
            labels: managedLabels(id),
          },
        });
      } catch (error) {
        if (!hasStatus(error, 409)) throw error;
      }
      current = await this.#get(`${path}/${name}`, address, signal);
    }
    if (!current?.address || current.status === "RESERVING") throw new ProviderOutcomeUnknown();
    if (!isManagedAddress(current, id))
      throw refused("conflict", "The Google Cloud Computer address name is already in use");
    return { ...current, address: current.address };
  }

  async #detachPreviousAddress(
    input: CreateVm,
    reservation: z.infer<typeof address>,
    signal: AbortSignal,
    check?: Check,
  ) {
    for (const user of reservation.users) {
      const name = user.split("/").at(-1)!;
      if (
        !resourceName.safeParse(name).success ||
        !matchesResource(user, `${this.#zone}/instances/${name}`)
      )
        throw refused("conflict", "The Google Cloud Computer address belongs to another VM");
      const previous = await this.#instance(name, signal);
      if (!previous) continue;
      const identity = managedInstance(previous);
      if (
        identity?.id !== input.id ||
        identity.generation >= input.generation ||
        previous.status !== "TERMINATED"
      )
        throw refused("conflict", "The Google Cloud Computer address is still attached");
      for (const nic of previous.networkInterfaces) {
        const access = nic.accessConfigs.find(({ natIP }) => natIP === reservation.address);
        if (access) {
          await this.#write(`${this.#zone}/instances/${name}/deleteAccessConfig`, "zone", signal, {
            method: "POST",
            query: { accessConfig: access.name, networkInterface: nic.name },
            check,
          });
        }
      }
    }
  }

  async releaseAddress(id: CloudComputerId, signal: AbortSignal, check?: Check) {
    const path = `${this.#addressesPath()}/${addressName(id)}`;
    const current = await this.#get(path, address, signal);
    if (!current) return true;
    if (!isManagedAddress(current, id))
      throw refused("conflict", "The Google Cloud Computer address name is already in use");
    if (current.status !== "RESERVED" || current.users.length) return false;
    try {
      await this.#write(path, "region", signal, { method: "DELETE", check });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
    return (await this.#get(path, address, signal)) === undefined;
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

  async #readRef(ref: GoogleComputeServerRef, signal: AbortSignal) {
    const [name, id] = ref.split("/") as [string, string];
    const vm = await this.#instance(name, signal);
    return vm?.id === id ? vm : undefined;
  }

  async #instance(name: string, signal: AbortSignal) {
    const vm = await this.#get(`${this.#zone}/instances/${name}`, instance, signal);
    if (vm && vm.name !== name) throw refused("conflict", "Google returned a different VM name");
    return vm;
  }

  async powerOn(
    id: GoogleComputeServerRef,
    signal: AbortSignal,
    check?: Check,
    requestId?: string,
  ) {
    const current = await this.#readRef(id, signal);
    if (!current || current.status === "RUNNING") return;
    await this.#write(`${this.#zone}/instances/${current.name}/start`, "zone", signal, {
      method: "POST",
      check,
      requestId,
    });
  }

  async powerOff(id: GoogleComputeServerRef, signal: AbortSignal, check?: Check) {
    const current = await this.#readRef(id, signal);
    if (!current || ["TERMINATED", "STOPPING", "PENDING_STOP"].includes(current.status)) return;
    try {
      await this.#write(`${this.#zone}/instances/${current.name}/stop`, "zone", signal, {
        method: "POST",
        check,
        observedVersion: `${id}/${current.lastStartTimestamp ?? ""}`,
        instanceAction: { type: "stop", targetId: current.id },
      });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
  }

  async delete(id: GoogleComputeServerRef, signal: AbortSignal, check?: Check) {
    const current = await this.#readRef(id, signal);
    if (!current) return;
    try {
      await this.#write(`${this.#zone}/instances/${current.name}`, "zone", signal, {
        method: "DELETE",
        check,
        observedVersion: id,
        instanceAction: { type: "delete", targetId: current.id },
      });
    } catch (error) {
      if (!hasStatus(error, 404)) throw error;
    }
    const identity = managedInstance(current) ?? namedIdentity(current.name);
    if (identity) await this.releaseAddress(identity.id, signal, check);
  }

  async canRecoverWrite(write: CloudComputerProviderWrite, signal: AbortSignal) {
    if (!write.dispatched) return true;
    const operations = await this.#list(
      `${this.#zone}/operations`,
      operation,
      signal,
      `clientOperationId = "${write.token}"`,
    );
    return operations
      .filter(({ clientOperationId }) => clientOperationId === write.token)
      .every(({ status }) => status === "DONE");
  }

  async updateBootstrap(
    id: GoogleComputeServerRef,
    receiptRecorded: boolean,
    signal: AbortSignal,
    check?: Check,
  ) {
    const vm = await this.#readRef(id, signal);
    if (!vm) return false;
    if (!vm.metadata) return true;
    const items = vm.metadata.items;
    const hasUserData = items.some(({ key }) => key === "user-data");
    const hasReady = items.some(({ key }) => key === googleBootstrapReadyKey);
    if (!receiptRecorded && (!hasUserData || hasReady)) return true;
    if (receiptRecorded && !hasUserData && !hasReady) return true;
    try {
      await this.#write(`${this.#zone}/instances/${vm.name}/setMetadata`, "zone", signal, {
        method: "POST",
        check,
        observedVersion: `${id}/${vm.metadata.fingerprint}`,
        body: {
          fingerprint: vm.metadata.fingerprint,
          items: receiptRecorded
            ? items.filter(({ key }) => key !== "user-data" && key !== googleBootstrapReadyKey)
            : [...items, { key: googleBootstrapReadyKey, value: "1" }],
        },
      });
    } catch (error) {
      if (hasStatus(error, 412)) return false;
      throw error;
    }
    if (receiptRecorded) {
      const updated = await this.#readRef(id, signal);
      return updated !== undefined && bootstrapMetadata(updated) === "absent";
    }
    return true;
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
      query.toString(),
      write.requestId ?? write.observedVersion,
    ]);
    const prior = this.#pendingOperations.get(key);
    const pending: PendingOperation = prior ?? { requestId: write.requestId ?? randomUUID() };
    const initial =
      pending.initial ??
      (write.instanceAction
        ? await this.#activeInstanceOperation(write.instanceAction, signal)
        : undefined) ??
      (await this.#dispatch(path, query, write, pending, key, signal));
    let current = initial;
    try {
      while (current.status !== "DONE") {
        await this.#wait(1_000, signal);
        current = await this.#request(this.#operationPath(scope, initial.name), operation, signal);
        if (current.name !== initial.name)
          throw refused("conflict", "Google returned a different operation");
      }
    } catch (error) {
      throw new ProviderOutcomeUnknown(error);
    }
    this.#pendingOperations.delete(key);
    if (current.error || current.httpErrorStatusCode)
      throw new ProviderWriteRejected(
        new RemoteRequestError(compute, current.httpErrorStatusCode ?? 500),
      );
    return { ...current, targetId: current.targetId ?? initial.targetId };
  }

  async #activeInstanceOperation(
    action: NonNullable<Write["instanceAction"]>,
    signal: AbortSignal,
  ) {
    const filter = `(targetId = ${action.targetId}) (operationType = ${action.type}) (status != DONE)`;
    const operations = await this.#list(`${this.#zone}/operations`, operation, signal, filter);
    const matches = operations.filter(
      ({ targetId, operationType, status }) =>
        targetId === action.targetId && operationType === action.type && status !== "DONE",
    );
    if (matches.length > 1) throw new ProviderOutcomeUnknown();
    return matches[0];
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
        },
      );
    } catch (error) {
      if (hasStatus(error, 401)) this.#accessToken.invalidate?.(token);
      throw error;
    }
  }
}

function matchesResource(resource: string, path: string) {
  return resource === path || resource.endsWith(`/compute/v1/${path}`);
}

function hasStatus(error: unknown, status: number): boolean {
  const cause = error instanceof ProviderWriteRejected ? error.original : error;
  return (
    cause instanceof RemoteRequestError && cause.service === compute && cause.status === status
  );
}

function managedLabels(id: CloudComputerId) {
  return { [homeLabel]: id, [managedLabel]: managedBy };
}

function instanceName(id: CloudComputerId, generation: number) {
  return `os-${id.replace("_", "-")}-${generation}`;
}

function addressName(id: CloudComputerId) {
  return `os-${id.replace("_", "-")}-ip`;
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
  if (vm.labels[managedLabel] !== managedBy) return undefined;
  const id = CloudComputerIdSchema.safeParse(vm.labels[homeLabel]);
  const generation = CloudComputerGenerationSchema.safeParse(Number(vm.labels[generationLabel]));
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

function isManagedAddress(entry: z.infer<typeof address>, id: CloudComputerId) {
  return (
    entry.name === addressName(id) &&
    entry.labels[homeLabel] === id &&
    entry.labels[managedLabel] === managedBy
  );
}

function bootstrapMetadata(vm: Instance): NonNullable<VmServer["bootstrapMetadata"]> {
  if (vm.metadata?.items.some(({ key }) => key === googleBootstrapReadyKey)) return "enabled";
  return vm.metadata?.items.some(({ key }) => key === "user-data") ? "pending" : "absent";
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
    bootstrapMetadata: bootstrapMetadata(vm),
    firewalls: vm.tags?.items.includes(firewallTag) ? [{ id: firewallId, status: "applied" }] : [],
  };
}
