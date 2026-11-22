import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { GoogleCompute } from "./google-compute.js";
import type { CreateVm } from "./provider.js";

export const computeComputerId = CloudComputerIdSchema.parse(
  "cc_00000000-0000-4000-8000-000000000001",
);
export const computeInstanceName = `os-${computeComputerId.replace("_", "-")}-3`;
export const addressName = `${computeInstanceName}-ip`;
export const regionPath = "projects/test-project/regions/us-central1";
export const zonePath = "projects/test-project/zones/us-central1-a";
export const globalPath = "projects/test-project/global";
export const computeInstanceId = "18446744073709551615";
export const computeIpv4 = "192.0.2.21";
export const computeIpv6 = "2001:db8::21";
export const computeCreate: CreateVm = {
  id: computeComputerId,
  generation: 3,
  region: "us-central1",
  serverType: "e2-medium",
  image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64",
  firewallId: 1,
  userData: "#cloud-config\nbootstrap_test_token",
  requestId: "00000000-0000-4000-8000-000000000010",
};

type Labels = Record<string, string>;
type Metadata = { fingerprint: string; items: { key: string; value: string }[] };
type NetworkInterface = {
  name: string;
  networkIP?: string;
  accessConfigs: { name: string; natIP?: string }[];
  ipv6AccessConfigs?: { externalIpv6?: string }[];
};
type Disk = {
  id: string;
  name: string;
  sizeGb: string;
  type: string;
  labels: Labels;
};
type AttachedDisk = {
  boot?: boolean;
  autoDelete?: boolean;
  source?: string;
  deviceName?: string;
  type?: string;
  interface?: string;
  mode?: string;
};
type Instance = {
  name: string;
  id: string;
  labels: Labels;
  status: string;
  lastStartTimestamp?: string;
  tags: { fingerprint: string; items: string[] };
  metadata: Metadata;
  disks?: AttachedDisk[];
  networkInterfaces: NetworkInterface[];
};
type Address = { name: string; labels: Labels; address: string };
type Operation = {
  name: string;
  status: "PENDING" | "RUNNING" | "DONE";
  insertTime?: string;
  clientOperationId: string;
  operationType?: string | undefined;
  targetId?: string;
  error?: { errors: { code: string }[] };
  httpErrorStatusCode?: number;
};
type RecordedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
const requestKey = ({ method, path, query, body }: RecordedRequest) => {
  const rest = new URLSearchParams(query);
  rest.delete("requestId");
  return JSON.stringify([method, path, rest.toString(), body ?? null]);
};

export class ComputeFake {
  readonly requests: RecordedRequest[] = [];
  readonly instances = new Map<string, Instance>();
  readonly disks = new Map<string, Disk>();
  readonly addresses = new Map<string, Address>();
  readonly firewalls = new Map<string, unknown>();
  readonly operations = new Map<
    string,
    {
      operation: Operation;
      finish: () => void;
      advance: (() => void) | undefined;
    }
  >();
  readonly otherZones = new Map<string, Instance[]>();
  /** Scopes the aggregated listing reports as unreachable. */
  unreachable: string[] = [];
  readonly logs: Record<string, unknown>[] = [];
  readonly instanceStates: { name: string; status: string }[] = [];
  readonly started = new Map<string, Operation>();
  readonly waitCalls: number[] = [];
  metadataCalls = 0;
  dualStack = false;
  pageSize = 100;
  token = "test-metadata-access-token";
  expiresIn = 100;
  nextInsert: "lost" | "late" | "failure" | "quota" | undefined;
  nextAddressInsert: "quota" | undefined;
  keepOperationsRunning = false;
  rejectMetadata = false;
  rejectComputeToken = false;
  /** The next this many Compute requests are refused for the rate quota. */
  rateLimitRequests = 0;
  rateLimitStatus: 403 | 429 = 403;
  /** Writes whose operations never answer a poll, so their outcome stays unobserved. */
  holdMatch: ((method: string, path: string) => boolean) | undefined;
  readonly #held = new Set<string>();
  /** Refuses the first Compute request that matches, once, for the rate quota. */
  rateLimitMatch: ((method: string, path: string) => boolean) | undefined;
  #nextId = BigInt(computeInstanceId);
  #nextDiskId = 9000n;
  #nextAddress = 21;
  #nextInternalIp = 10;
  #nextOperation = 0;
  #clock = 0;
  readonly #replays = new Map<string, { request: string; operation: Operation }>();

  adapter() {
    return new GoogleCompute({
      project: "test-project",
      zone: "us-central1-a",
      network: "home-net",
      subnet: "home-subnet",
      diskType: "pd-balanced",
      diskSizeGb: 30,
      timeoutMs: 2000,
      actionTimeoutMs: 5000,
      baseUrl: new URL("https://compute.test/compute/v1/"),
      fetch: this.fetch,
      log: (entry) => this.logs.push(entry),
      wait: async (ms, signal) => {
        this.waitCalls.push(ms);
        signal.throwIfAborted();
        if (this.keepOperationsRunning) throw new Error("fake deadline");
      },
    });
  }

  readonly fetch: typeof fetch = async (input, options) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    const method = options?.method ?? "GET";
    const headers = new Headers(options?.headers);
    const body: unknown = typeof options?.body === "string" ? JSON.parse(options.body) : undefined;
    const path = url.pathname.replace(/^\/compute\/v1\//u, "");
    const req = { method, path, headers, body, query: url.searchParams };
    this.requests.push(req);
    if (url.hostname === "metadata.google.internal") {
      this.metadataCalls++;
      if (headers.get("metadata-flavor") !== "Google") throw new Error("Missing metadata flavor");
      if (this.rejectMetadata) return json({}, 403);
      return json({ access_token: this.token, expires_in: this.expiresIn, token_type: "Bearer" });
    }
    if (url.hostname !== "compute.test") throw new Error("Unexpected test endpoint");
    if (this.rejectComputeToken || headers.get("authorization") !== `Bearer ${this.token}`)
      return json({}, 401);
    const matched = this.rateLimitMatch?.(method, path) ?? false;
    if (matched) this.rateLimitMatch = undefined;
    if (matched || this.rateLimitRequests > 0) {
      if (!matched) this.rateLimitRequests--;
      // "If your project exceeds a rate quota, you receive a 403 error with the reason
      // rateLimitExceeded." https://cloud.google.com/compute/docs/api-rate-limits
      return json(
        {
          error: {
            code: this.rateLimitStatus,
            message: "Rate Limit Exceeded",
            errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }],
          },
        },
        this.rateLimitStatus,
      );
    }
    // Compute ignores a repeated requestId "if it has already been completed" and answers with
    // the original operation. Google does not document a different request under the same id;
    // the fake refuses it so a reused id cannot pass unnoticed.
    // https://cloud.google.com/compute/docs/reference/rest/v1/instances/insert
    const replayed = method !== "GET" && this.#replays.get(req.query.get("requestId") ?? "");
    if (replayed) {
      if (replayed.request !== requestKey(req)) return json({}, 400);
      return json(replayed.operation);
    }
    if (path.endsWith("/subnetworks/home-subnet"))
      return json({
        network: `https://compute.googleapis.com/compute/v1/${globalPath}/networks/home-net`,
        ...(this.dualStack ? { stackType: "IPV4_IPV6", ipv6AccessType: "EXTERNAL" } : {}),
      });
    if (path.includes("/operations")) return this.#operationRequest(req);
    if (path === "projects/test-project/aggregated/instances") {
      const zones: [string, Instance[]][] = [
        ["zones/us-central1-a", [...this.instances.values()]],
        ...this.otherZones,
      ];
      const page = this.#slice(zones, req.query);
      const partial = req.query.get("returnPartialSuccess") === "true";
      if (this.unreachable.length && !partial) return json({}, 503);
      return json({
        ...page,
        items: Object.fromEntries(page.items.map(([zone, instances]) => [zone, { instances }])),
        ...(this.unreachable.length && !page.nextPageToken
          ? { unreachables: this.unreachable }
          : {}),
      });
    }
    if (path.startsWith(`${globalPath}/firewalls`)) return this.#firewallRequest(req);
    if (path.startsWith(`${regionPath}/addresses`)) return this.#addressRequest(req);
    if (path.startsWith(`${zonePath}/disks`)) return this.#diskRequest(req);
    if (path.startsWith(`${zonePath}/instances`)) return this.#instanceRequest(req);
    throw new Error(`Unexpected fake Compute request ${method} ${path}`);
  };

  #page<T>(items: T[], query: URLSearchParams) {
    return json(this.#slice(items, query));
  }

  #slice<T>(items: T[], query: URLSearchParams) {
    const offset = Number(query.get("pageToken") ?? 0);
    return {
      items: items.slice(offset, offset + this.pageSize),
      ...(offset + this.pageSize < items.length
        ? { nextPageToken: String(offset + this.pageSize) }
        : {}),
    };
  }

  #operationRequest(req: RecordedRequest) {
    if (req.path.endsWith("/operations")) {
      const operations = [...this.operations.values()].map(({ operation }) => operation);
      if (req.query.get("orderBy") === "creationTimestamp desc")
        operations.sort((a, b) => (b.insertTime ?? "").localeCompare(a.insertTime ?? ""));
      return this.#page(operations, req.query);
    }
    const found = this.operations.get(req.path);
    if (!found) return json({}, 404);
    if (this.#held.has(found.operation.name)) return json({}, 503);
    if (!this.keepOperationsRunning) {
      if (found.advance) {
        found.advance();
        found.advance = undefined;
        found.operation.status = "RUNNING";
      } else this.complete(req.path);
    }
    return json(found.operation);
  }

  /** Adds a finished operation from some time ago, as Compute retains them for days. */
  addPastOperation(insertTime: string, clientOperationId = crypto.randomUUID()) {
    const operation: Operation = {
      name: `operation-${++this.#nextOperation}`,
      status: "DONE",
      insertTime,
      clientOperationId,
    };
    this.operations.set(`${zonePath}/operations/${operation.name}`, {
      operation,
      advance: undefined,
      finish: () => {},
    });
  }

  complete(path: string) {
    const found = this.operations.get(path);
    if (found && found.operation.status !== "DONE") {
      found.finish();
      found.operation.status = "DONE";
    }
  }

  #start(
    req: RecordedRequest,
    scope: string,
    finish: () => void,
    result: Partial<Operation> = {},
    advance?: () => void,
  ) {
    const clientOperationId = req.query.get("requestId");
    if (!clientOperationId || !/^[0-9a-f-]{36}$/u.test(clientOperationId))
      throw new Error("Missing requestId");
    const operation: Operation = {
      name: `operation-${++this.#nextOperation}`,
      status: advance ? "PENDING" : "RUNNING",
      insertTime: new Date(Date.now()).toISOString(),
      clientOperationId,
      ...result,
    };
    this.started.set(clientOperationId, operation);
    if (this.holdMatch?.(req.method, req.path)) this.#held.add(operation.name);
    this.#replays.set(clientOperationId, { request: requestKey(req), operation });
    this.operations.set(`${scope}/operations/${operation.name}`, { operation, advance, finish });
    return operation;
  }

  #firewallRequest(req: RecordedRequest) {
    if (req.method === "GET") {
      const current = this.firewalls.get(req.path.split("/").at(-1)!);
      return current ? json(current) : json({}, 404);
    }
    const body = req.body as { name: string };
    if (this.firewalls.has(body.name)) return json({}, 409);
    return json(this.#start(req, globalPath, () => this.firewalls.set(body.name, body)));
  }

  #addressRequest(req: RecordedRequest) {
    const name = req.path.split("/").at(-1)!;
    const usersOf = (address: Address) =>
      [...this.instances.values()]
        .filter(({ networkInterfaces }) =>
          networkInterfaces.some(({ accessConfigs }) =>
            (accessConfigs ?? []).some(({ natIP }) => natIP === address.address),
          ),
        )
        .map(
          ({ name: instanceName }) =>
            `https://compute.googleapis.com/compute/v1/${zonePath}/instances/${instanceName}`,
        );
    const response = (address: Address) => {
      const users = usersOf(address);
      return {
        ...address,
        users,
        addressType: "EXTERNAL",
        networkTier: "PREMIUM",
        status: users.length ? "IN_USE" : "RESERVED",
      };
    };
    if (req.method === "GET" && name === "addresses")
      return this.#page([...this.addresses.values()].map(response), req.query);
    if (req.method === "GET") {
      const entry = this.addresses.get(name);
      return entry ? json(response(entry)) : json({}, 404);
    }
    if (req.method === "DELETE") {
      const entry = this.addresses.get(name);
      if (!entry) return json({}, 404);
      if (usersOf(entry).length) return json({}, 400);
      return json(this.#start(req, regionPath, () => this.addresses.delete(name)));
    }
    const body = req.body as { name: string; labels: Labels };
    if (this.addresses.has(body.name)) return json({}, 409);
    if (this.nextAddressInsert === "quota") {
      this.nextAddressInsert = undefined;
      return json(
        { error: { code: 403, errors: [{ domain: "usageLimits", reason: "quotaExceeded" }] } },
        403,
      );
    }
    return json(
      this.#start(req, regionPath, () =>
        this.addresses.set(body.name, { ...body, address: `192.0.2.${this.#nextAddress++}` }),
      ),
    );
  }

  #diskRequest(req: RecordedRequest) {
    const name = req.path.slice(`${zonePath}/disks`.length).split("/")[1];
    const usersOf = (diskName: string) =>
      [...this.instances.values()]
        .filter(({ disks }) =>
          (disks ?? []).some(({ source }) => source?.endsWith(`/disks/${diskName}`)),
        )
        .map(
          ({ name: instanceName }) =>
            `https://compute.googleapis.com/compute/v1/${zonePath}/instances/${instanceName}`,
        );
    const response = (disk: Disk) => ({ ...disk, users: usersOf(disk.name) });
    if (req.method === "GET" && !name)
      return this.#page([...this.disks.values()].map(response), req.query);
    if (req.method === "GET") {
      const current = this.disks.get(name!);
      return current ? json(response(current)) : json({}, 404);
    }
    if (req.method === "DELETE") {
      const current = this.disks.get(name!);
      if (!current) return json({}, 404);
      if (usersOf(current.name).length) return json({}, 400);
      return json(
        this.#start(req, zonePath, () => this.disks.delete(current.name), {
          targetId: current.id,
          operationType: "delete",
        }),
      );
    }
    const body = req.body as { name: string; sizeGb: string; type: string; labels?: Labels };
    if (this.disks.has(body.name)) return json({}, 409);
    const id = String(++this.#nextDiskId);
    return json(
      this.#start(
        req,
        zonePath,
        () => {
          this.disks.set(body.name, {
            id,
            name: body.name,
            sizeGb: body.sizeGb,
            type: body.type,
            labels: body.labels ?? {},
          });
        },
        { targetId: id, operationType: "insert" },
      ),
    );
  }

  #instanceRequest(req: RecordedRequest) {
    const [name, action] = req.path.slice(`${zonePath}/instances`.length).split("/").slice(1);
    if (req.method === "GET" && !name) return this.#page([...this.instances.values()], req.query);
    const current = name ? this.instances.get(name) : undefined;
    if (req.method === "GET") return current ? json(current) : json({}, 404);
    if (req.method === "POST" && !name) return this.#insertInstance(req);
    if (!current) return json({}, 404);
    return json(
      this.#start(
        req,
        zonePath,
        () => {
          if (req.method === "DELETE") this.instances.delete(current.name);
          else if (action === "start") {
            current.lastStartTimestamp = this.#timestamp();
            this.#setStatus(current, "RUNNING");
          } else if (action === "stop") this.#setStatus(current, "TERMINATED");
          else if (action === "setTags") current.tags = req.body as Instance["tags"];
          else if (action === "setMetadata") {
            current.metadata = { ...(req.body as Metadata), fingerprint: "changed" };
          } else throw new Error(`Unexpected Compute action ${action}`);
        },
        { targetId: current.id, operationType: req.method === "DELETE" ? "delete" : action },
        action === "start" || action === "stop"
          ? () => this.#setStatus(current, action === "start" ? "STAGING" : "STOPPING")
          : undefined,
      ),
    );
  }

  #insertInstance(req: RecordedRequest) {
    const body = req.body as Pick<
      Instance,
      "name" | "labels" | "tags" | "metadata" | "networkInterfaces" | "disks"
    >;
    if (this.instances.has(body.name)) return json({}, 409);
    const behavior = this.nextInsert;
    this.nextInsert = undefined;
    if (behavior === "quota") return json({ message: "quota exceeded" }, 403);
    const id = String(this.#nextId--);
    const internalIp = `10.40.0.${this.#nextInternalIp++}`;
    const vm: Instance = {
      ...body,
      id,
      status: "PROVISIONING",
      tags: { ...body.tags, fingerprint: "tags-test" },
      metadata: { ...body.metadata, fingerprint: "metadata-test" },
      networkInterfaces: body.networkInterfaces.map((nic) => ({
        ...nic,
        accessConfigs: nic.accessConfigs ?? [],
        name: "nic0",
        networkIP: internalIp,
        ...(nic.ipv6AccessConfigs ? { ipv6AccessConfigs: [{ externalIpv6: computeIpv6 }] } : {}),
      })),
    };
    if (behavior !== "failure") {
      this.instances.set(body.name, vm);
      this.#setStatus(vm, "PROVISIONING");
    }
    const operation = this.#start(
      req,
      zonePath,
      () => {
        if (behavior === "failure") return;
        vm.lastStartTimestamp = this.#timestamp();
        this.#setStatus(vm, "RUNNING");
      },
      behavior === "failure"
        ? { targetId: id, httpErrorStatusCode: 400, error: { errors: [{ code: "FAILED" }] } }
        : { targetId: id },
      behavior !== "failure" ? () => this.#setStatus(vm, "STAGING") : undefined,
    );
    if (behavior === "lost") this.complete(`${zonePath}/operations/${operation.name}`);
    if (behavior === "lost" || behavior === "late") throw new Error("lost Compute reply");
    return json(operation);
  }

  #timestamp() {
    return new Date(Date.UTC(2026, 10, 20) + ++this.#clock * 1_000).toISOString();
  }

  #setStatus(instance: Instance, status: string) {
    instance.status = status;
    this.instanceStates.push({ name: instance.name, status });
  }
}
