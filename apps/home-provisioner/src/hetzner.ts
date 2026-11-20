import { setTimeout as delay } from "node:timers/promises";
import {
  CloudComputerGenerationSchema,
  CloudComputerIdSchema,
  type CloudComputerId,
} from "@opensteer/control-plane-protocol";
import { refused } from "@opensteer/core";
import { z } from "zod";
import { json, RemoteRequestError, request, type HttpOptions } from "./http.js";
import type { CreateVm, VmProvider, VmServer } from "./provider.js";

const homeLabel = "opensteer.com/cloud-computer";
const generationLabel = "opensteer.com/generation";
const managedLabel = "opensteer.com/managed-by";
const managedBy = "home-provisioner";
const firewallName = "opensteer-cloud-computers";
const sourceIps = ["0.0.0.0/0", "::/0"];
const rules = ["80", "443"].map((port) => ({
  direction: "in",
  protocol: "tcp",
  port,
  source_ips: sourceIps,
}));

const idSchema = z.number().int().positive();
const actionSchema = z.object({ id: idSchema, status: z.enum(["running", "success", "error"]) });
type Action = z.infer<typeof actionSchema>;
const actionResponse = z.object({ action: actionSchema });
const actionsResponse = z.object({ actions: z.array(actionSchema) });
const listMeta = z.object({ pagination: z.object({ next_page: idSchema.nullable() }) });
const labels = z.record(z.string(), z.string());
const vmStatus = z.enum([
  "running",
  "off",
  "initializing",
  "starting",
  "stopping",
  "deleting",
  "migrating",
  "rebuilding",
  "unknown",
]);
const vm = z.object({
  id: idSchema,
  name: z.string(),
  labels,
  status: vmStatus,
  public_net: z.object({
    ipv4: z.object({ ip: z.ipv4(), blocked: z.boolean() }).nullable(),
    ipv6: z
      .object({ ip: z.cidrv6().refine((ip) => ip.endsWith("/64")), blocked: z.boolean() })
      .nullable(),
    firewalls: z.array(z.object({ id: idSchema, status: z.enum(["applied", "pending"]) })),
  }),
});
type HetznerVm = z.infer<typeof vm>;

const firewall = z.object({
  id: idSchema,
  name: z.string(),
  labels,
  rules: z.array(
    z.object({
      direction: z.enum(["in", "out"]),
      protocol: z.string(),
      port: z.string().nullable(),
      source_ips: z.array(z.string()),
    }),
  ),
});
const serverResponse = z.object({ server: vm });
const serversResponse = z.object({ servers: z.array(vm), meta: listMeta });
const serverCreated = serverResponse.extend({
  action: actionSchema,
  next_actions: z.array(actionSchema),
});
const firewallsResponse = z.object({ firewalls: z.array(firewall), meta: listMeta });
const firewallCreated = actionsResponse.extend({ firewall });

interface HetznerOptions extends HttpOptions {
  readonly token: string;
  readonly actionTimeoutMs: number;
  readonly baseUrl?: URL;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class HetznerCloud implements VmProvider {
  readonly #options: HetznerOptions;
  readonly #baseUrl: URL;
  readonly #wait: NonNullable<HetznerOptions["wait"]>;
  #retryAt = 0;

  constructor(options: HetznerOptions) {
    this.#options = options;
    this.#baseUrl = options.baseUrl ?? new URL("https://api.hetzner.cloud/v1/");
    this.#wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }

  async ensureFirewall(signal: AbortSignal, check?: () => Promise<void>): Promise<number> {
    let current = await this.#findFirewall(signal);
    if (!current) {
      try {
        const result = await this.#request(
          "firewalls",
          firewallCreated,
          signal,
          "POST",
          {
            name: firewallName,
            labels: { [managedLabel]: managedBy },
            rules,
          },
          check,
        );
        await this.#actions("firewalls", result.actions, signal);
        return result.firewall.id;
      } catch (error) {
        if (!isConflict(error)) throw error;
        current = await this.#findFirewall(signal);
        if (!current) throw error;
      }
    }

    const matches =
      current.rules.length === rules.length &&
      rules.every((expected) =>
        current.rules.some(
          (actual) =>
            actual.direction === "in" &&
            actual.protocol === "tcp" &&
            actual.port === expected.port &&
            actual.source_ips.length === sourceIps.length &&
            sourceIps.every((range) => actual.source_ips.includes(range)),
        ),
      );
    if (!matches) {
      const result = await this.#request(
        `firewalls/${current.id}/actions/set_rules`,
        actionsResponse,
        signal,
        "POST",
        { rules },
        check,
      );
      await this.#actions("firewalls", result.actions, signal);
    }
    return current.id;
  }

  async #findFirewall(signal: AbortSignal) {
    const found = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = await this.#request(
        `firewalls?name=${firewallName}&per_page=50&page=${page}`,
        firewallsResponse,
        signal,
      );
      found.push(...result.firewalls);
      page = nextPage(page, result.meta);
    }

    if (
      found.length > 1 ||
      found.some((entry) => entry.name !== firewallName || entry.labels[managedLabel] !== managedBy)
    ) {
      throw refused("conflict", "The Hetzner firewall name is already in use");
    }
    return found[0];
  }

  async ensureFirewallAttached(
    server: VmServer,
    firewallId: number,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ) {
    const attachment = server.firewalls.find((entry) => entry.id === firewallId);
    if (attachment) return attachment.status === "applied";
    const result = await this.#request(
      `firewalls/${firewallId}/actions/apply_to_resources`,
      actionsResponse,
      signal,
      "POST",
      { apply_to: [{ type: "server", server: { id: server.id } }] },
      check,
    );
    await this.#actions("firewalls", result.actions, signal);
    const observed = await this.describe(server.id, signal);
    return (
      observed?.firewalls.some(({ id, status }) => id === firewallId && status === "applied") ??
      false
    );
  }

  async find(
    id: CloudComputerId,
    signal: AbortSignal,
    expected?: {
      generation: number;
      providerServerId?: number | undefined;
      previousProviderServerId?: number | undefined;
    },
  ): Promise<readonly VmServer[]> {
    const found = new Map(
      (await this.#find(id, signal))
        .filter((entry) => managedServer(entry)?.id === id)
        .map((entry) => [entry.id, server(entry)]),
    );
    if (!expected) return [...found.values()];
    for (const serverId of [expected.providerServerId, expected.previousProviderServerId]) {
      if (serverId && !found.has(serverId)) {
        const entry = await this.#describe(serverId, signal);
        if (entry && managedServer(entry)?.id !== id) {
          throw refused(
            "conflict",
            "Recorded Hetzner server identity does not match this Cloud Computer",
          );
        }
        if (entry) found.set(entry.id, server(entry));
      }
    }
    if (![...found.values()].some((entry) => entry.generation === expected.generation)) {
      const name = serverName(id, expected.generation);
      for (const entry of await this.#list({ name }, signal)) {
        if (entry.name === name) found.set(entry.id, server(entry));
      }
    }
    return [...found.values()];
  }

  async listManaged(signal: AbortSignal) {
    return (await this.#list({ label_selector: homeLabel }, signal)).flatMap((entry) => {
      const identity = managedServer(entry);
      return identity ? [{ id: identity.id, server: server(entry) }] : [];
    });
  }

  #find(id: CloudComputerId, signal: AbortSignal, generation?: number) {
    const label_selector =
      `${homeLabel}=${id}` + (generation === undefined ? "" : `,${generationLabel}=${generation}`);
    return this.#list({ label_selector }, signal);
  }

  async #list(filter: Record<string, string>, signal: AbortSignal) {
    const result: HetznerVm[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const query = new URLSearchParams({ ...filter, page: String(page), per_page: "50" });
      const response = await this.#request(`servers?${query}`, serversResponse, signal);
      result.push(...response.servers);
      page = nextPage(page, response.meta);
    }
    return result;
  }

  async create(
    input: CreateVm,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ): Promise<VmServer> {
    const name = serverName(input.id, input.generation);
    let created: z.infer<typeof serverCreated>;
    try {
      created = await this.#request(
        "servers",
        serverCreated,
        signal,
        "POST",
        {
          name,
          server_type: input.serverType,
          location: input.region,
          image: input.image,
          user_data: input.userData,
          labels: { [homeLabel]: input.id, [generationLabel]: String(input.generation) },
          firewalls: [{ firewall: input.firewallId }],
          public_net: { enable_ipv4: true, enable_ipv6: true },
          start_after_create: false,
        },
        check,
      );
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await this.#find(input.id, signal, input.generation);
      const match = existing[0];
      if (existing.length === 1 && match?.name === name) return server(match);
      const byName = (await this.#list({ name }, signal)).find((entry) => entry.name === name);
      if (byName) return server(byName);
      throw error;
    }

    if (
      created.server.name !== name ||
      created.server.labels[homeLabel] !== input.id ||
      created.server.labels[generationLabel] !== String(input.generation)
    ) {
      throw refused("conflict", "Hetzner returned a different Cloud Computer server");
    }
    await this.#actions("servers", [created.action, ...created.next_actions], signal);
    const current = await this.describe(created.server.id, signal);
    if (!current) throw refused("not_found", "The new Hetzner server is missing");
    return current;
  }

  async describe(id: number, signal: AbortSignal): Promise<VmServer | undefined> {
    const entry = await this.#describe(id, signal);
    return entry ? server(entry) : undefined;
  }

  async #describe(id: number, signal: AbortSignal) {
    try {
      const result = await this.#request(`servers/${id}`, serverResponse, signal);
      if (result.server.id !== id)
        throw refused("conflict", "Hetzner returned a different server ID");
      return result.server;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async powerOn(id: number, signal: AbortSignal, check?: () => Promise<void>) {
    await this.#serverAction(`servers/${id}/actions/poweron`, "POST", signal, check);
  }

  async powerOff(id: number, signal: AbortSignal, check?: () => Promise<void>) {
    const graceful = AbortSignal.timeout(Math.min(this.#options.actionTimeoutMs, 30_000));
    const deadline = AbortSignal.any([signal, graceful]);
    try {
      await this.#serverAction(`servers/${id}/actions/shutdown`, "POST", deadline, check);
      let current = await this.describe(id, deadline);
      while (current && current.status !== "off" && current.status !== "deleting") {
        await this.#wait(1_000, deadline);
        current = await this.describe(id, deadline);
      }
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (isNotFound(error)) return;
      if (error instanceof RemoteRequestError && [401, 403, 429].includes(error.status))
        throw error;
    }
    const current = await this.describe(id, signal);
    if (!current || current.status === "off" || current.status === "deleting") return;
    await this.#serverAction(`servers/${id}/actions/poweroff`, "POST", signal, check);
  }

  async delete(id: number, signal: AbortSignal, check?: () => Promise<void>) {
    try {
      await this.#serverAction(`servers/${id}`, "DELETE", signal, check);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  async #serverAction(
    path: string,
    method: string,
    signal: AbortSignal,
    check?: () => Promise<void>,
  ) {
    const { action } = await this.#request(path, actionResponse, signal, method, undefined, check);
    await this.#actions("servers", [action], signal);
  }

  async #actions(
    resource: "servers" | "firewalls",
    actions: readonly Action[],
    shutdown: AbortSignal,
  ) {
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(this.#options.actionTimeoutMs)]);
    for (const initial of actions) {
      let action = initial;
      while (action.status === "running") {
        await this.#wait(1_000, signal);
        const response = await this.#request(
          `${resource}/actions/${initial.id}`,
          actionResponse,
          signal,
        );
        action = response.action;
        if (action.id !== initial.id)
          throw refused("conflict", "Hetzner returned a different action");
      }
      if (action.status === "error")
        throw refused("internal", "Hetzner could not complete an action");
    }
  }

  async #request<T>(
    path: string,
    schema: z.ZodType<T>,
    shutdown: AbortSignal,
    method = "GET",
    body?: unknown,
    check?: () => Promise<void>,
  ): Promise<T> {
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(this.#options.timeoutMs)]);
    for (let attempt = 0; ; attempt++) {
      const waitMs = this.#retryAt - Date.now();
      if (waitMs >= this.#options.timeoutMs)
        throw new RemoteRequestError("Hetzner", 429, this.#retryAt);
      if (waitMs > 0) await this.#wait(waitMs, signal);
      await check?.();
      signal.throwIfAborted();
      try {
        return await request(
          "Hetzner",
          new URL(path, this.#baseUrl),
          this.#options,
          signal,
          json(schema),
          {
            method,
            body,
            headers: { authorization: `Bearer ${this.#options.token}` },
          },
        );
      } catch (error) {
        if (!(error instanceof RemoteRequestError) || error.status !== 429) throw error;
        this.#retryAt = Math.max(this.#retryAt, error.retryAt ?? 0);
        if (attempt === 1) throw error;
      }
    }
  }
}

function nextPage(page: number, meta: z.infer<typeof listMeta>): number | null {
  const next = meta.pagination.next_page;
  if (next !== null && next <= page) throw refused("internal", "Invalid Hetzner pagination");
  return next;
}

function isNotFound(error: unknown): boolean {
  return error instanceof RemoteRequestError && error.status === 404;
}

function isConflict(error: unknown): boolean {
  return error instanceof RemoteRequestError && (error.status === 409 || error.status === 422);
}

function serverName(id: CloudComputerId, generation: number) {
  return `os-${id.replace("_", "-")}-${generation}`;
}

function managedServer(input: HetznerVm) {
  const name = /^os-cc-([0-9a-f-]{36})-(\d+)$/u.exec(input.name);
  const id = CloudComputerIdSchema.safeParse(name ? `cc_${name[1]}` : input.labels[homeLabel]);
  const generation = CloudComputerGenerationSchema.safeParse(
    Number(name?.[2] ?? input.labels[generationLabel]),
  );
  return id.success && generation.success
    ? { id: id.data, generation: generation.data }
    : undefined;
}

function server(input: HetznerVm): VmServer {
  const identity = managedServer(input);
  if (!identity)
    throw refused("conflict", "A Hetzner server has an invalid Cloud Computer identity");
  const { ipv4, ipv6, firewalls } = input.public_net;
  let ipv6Address = null;
  if (ipv6 && !ipv6.blocked) {
    // Hetzner cloud-init assigns the first address of the Primary IPv6 /64.
    const network = ipv6.ip.slice(0, -3);
    const canonical = new URL(`http://[${network}]`).hostname.slice(1, -1);
    if (!canonical.endsWith("::")) throw refused("internal", "Invalid Hetzner IPv6 network");
    ipv6Address = `${canonical}1`;
  }
  return {
    id: input.id,
    generation: identity.generation,
    status:
      input.status === "off" || input.status === "running" || input.status === "deleting"
        ? input.status
        : "transitioning",
    ipv4: ipv4 && !ipv4.blocked ? ipv4.ip : null,
    ipv6: ipv6Address,
    firewalls,
  };
}
