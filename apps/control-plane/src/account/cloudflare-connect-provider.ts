import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { createHmac } from "node:crypto";
import {
  ConnectOperationIdSchema,
  type ConnectOperationId,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import { z } from "zod";

const maximumResponseBytes = 1 * 1_024 * 1_024;
const defaultTimeoutMs = 15_000;
const CloudflareIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const TunnelIdSchema = z.uuid();
const TunnelTokenSchema = z.string().trim().min(32).max(16_384);
const TunnelSchema = z
  .object({
    id: TunnelIdSchema,
    name: z.string().min(1).max(256),
    config_src: z.literal("cloudflare"),
    metadata: z.record(z.string(), z.unknown()).nullish(),
  })
  .passthrough();
const DnsRecordSchema = z
  .object({
    comment: z.string().max(100).nullable().optional(),
    id: CloudflareIdSchema,
    name: z.string().min(1).max(255),
    content: z.string().min(1).max(255),
    type: z.literal("CNAME"),
    proxied: z.boolean().optional(),
  })
  .passthrough();
const WorkersRouteSchema = z
  .object({
    id: CloudflareIdSchema,
    pattern: z.string().min(1).max(1_024),
    script: z.string().min(1).max(256).nullish(),
  })
  .passthrough();
const ApiEnvelopeSchema = z
  .object({
    errors: z
      .array(
        z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough(),
      )
      .optional(),
    result: z.unknown(),
    success: z.literal(true),
  })
  .passthrough();

interface CloudflareConnectProviderConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly credentialDerivationSecret: string;
  readonly zoneId: string;
  readonly workersRouteBypass?: boolean;
  readonly fetch?: typeof globalThis.fetch;
  readonly requestTimeoutMs?: number;
}

export interface CloudflareConnectResource {
  readonly dnsRecordId: string;
  readonly hostname: string;
  readonly tunnelId: string;
  readonly tunnelName: string;
}

export interface ProvisionedCloudflareConnect extends CloudflareConnectResource {
  readonly connectorToken: string;
}

export interface EnsureCloudflareConnectInput {
  readonly deploymentId: string;
  readonly expected?: CloudflareConnectResource;
  readonly hostname: string;
  /** Loopback origin as interpreted on the machine running cloudflared. */
  readonly localOrigin: string;
}

export interface DeleteCloudflareConnectInput {
  readonly deploymentId: string;
  readonly expected?: CloudflareConnectResource;
  readonly hostname: string;
}

export interface ConnectResourceProvider {
  delete(input: DeleteCloudflareConnectInput): Promise<void>;
  ensure(input: EnsureCloudflareConnectInput): Promise<ProvisionedCloudflareConnect>;
  readConnectorToken(resource: CloudflareConnectResource): Promise<string>;
  rotateConnectorToken(
    resource: CloudflareConnectResource,
    operationId: ConnectOperationId,
  ): Promise<string>;
}

/**
 * Narrow Cloudflare resource adapter for Opensteer Connect.
 *
 * The API token remains inside the control plane. The only credential returned
 * to Desktop is the one-tunnel connector token.
 */
export class CloudflareConnectProvider implements ConnectResourceProvider {
  readonly #accountId: string;
  readonly #apiToken: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #credentialDerivationSecret: string;
  readonly #timeoutMs: number;
  readonly #zoneId: string;
  readonly #workersRouteBypass: boolean;

  constructor(config: CloudflareConnectProviderConfig) {
    this.#accountId = CloudflareIdSchema.parse(config.accountId);
    this.#zoneId = CloudflareIdSchema.parse(config.zoneId);
    this.#apiToken = z.string().trim().min(20).max(2_048).parse(config.apiToken);
    this.#workersRouteBypass = z.boolean().parse(config.workersRouteBypass ?? false);
    this.#credentialDerivationSecret = z
      .string()
      .min(32)
      .max(4_096)
      .parse(config.credentialDerivationSecret);
    this.#fetch = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = z
      .number()
      .int()
      .min(1_000)
      .max(60_000)
      .parse(config.requestTimeoutMs ?? defaultTimeoutMs);
  }

  async ensure(input: EnsureCloudflareConnectInput): Promise<ProvisionedCloudflareConnect> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const hostname = managedHostname(input.hostname);
    const localOrigin = loopbackOrigin(input.localOrigin);
    const tunnelName = `opensteer-${deploymentId.slice("dep_".length)}`;
    const dnsComment = dnsOwnershipComment(deploymentId);
    let tunnelId: string | undefined;
    let dnsRecordId: string | undefined;
    if (input.expected) {
      if (input.expected.hostname !== hostname || input.expected.tunnelName !== tunnelName) {
        throw new TypeError("Stored Connect resource does not match the Deployment identity");
      }
      tunnelId = TunnelIdSchema.parse(input.expected.tunnelId);
      dnsRecordId = CloudflareIdSchema.parse(input.expected.dnsRecordId);
      await this.#requireTunnel(tunnelId, tunnelName);
      await this.#requireDnsRecord(dnsRecordId, hostname, tunnelId, dnsComment);
    } else {
      const existingTunnel = await this.#findTunnel(tunnelName);
      if (existingTunnel) {
        tunnelId = existingTunnel.id;
      } else {
        const tunnel = await this.#createTunnel(tunnelName);
        tunnelId = tunnel.id;
      }
    }
    await this.#configureTunnel(tunnelId, hostname, localOrigin);
    if (!dnsRecordId) {
      const existingRecord = await this.#findDnsRecord(hostname, tunnelId, dnsComment);
      if (existingRecord) {
        dnsRecordId = existingRecord.id;
      } else {
        const record = await this.#createDnsRecord(hostname, tunnelId, dnsComment);
        dnsRecordId = record.id;
      }
    }
    if (this.#workersRouteBypass) await this.#ensureWorkersRouteBypass(hostname);
    const connectorToken = await this.#connectorToken(tunnelId);
    return {
      connectorToken,
      dnsRecordId,
      hostname,
      tunnelId,
      tunnelName,
    };
  }

  async rotateConnectorToken(
    resource: CloudflareConnectResource,
    operationIdInput: ConnectOperationId,
  ): Promise<string> {
    const tunnelId = TunnelIdSchema.parse(resource.tunnelId);
    const operationId = ConnectOperationIdSchema.parse(operationIdInput);
    await this.#requireTunnel(tunnelId, resource.tunnelName);
    await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}`,
      {
        method: "PATCH",
        body: {
          tunnel_secret: createHmac("sha256", this.#credentialDerivationSecret)
            .update(
              [
                "opensteer-connect-rotation:v2",
                this.#accountId,
                this.#zoneId,
                tunnelId,
                operationId,
              ].join(":"),
              "utf8",
            )
            .digest("base64"),
        },
      },
      TunnelSchema,
    );
    await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/connections`,
      { method: "DELETE" },
      z.unknown(),
    );
    return this.#connectorToken(tunnelId);
  }

  async readConnectorToken(resource: CloudflareConnectResource): Promise<string> {
    const tunnelId = TunnelIdSchema.parse(resource.tunnelId);
    await this.#requireTunnel(tunnelId, resource.tunnelName);
    return this.#connectorToken(tunnelId);
  }

  async delete(input: DeleteCloudflareConnectInput): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const hostname = managedHostname(input.hostname);
    const tunnelName = `opensteer-${deploymentId.slice("dep_".length)}`;
    const dnsComment = dnsOwnershipComment(deploymentId);
    let tunnelId: string | undefined;
    let dnsRecordId: string | undefined;
    let workersRouteId: string | undefined;
    if (input.expected) {
      if (input.expected.hostname !== hostname || input.expected.tunnelName !== tunnelName) {
        throw new TypeError("Stored Connect resource does not match the Deployment identity");
      }
      tunnelId = TunnelIdSchema.parse(input.expected.tunnelId);
      dnsRecordId = CloudflareIdSchema.parse(input.expected.dnsRecordId);
      const tunnelExists = await this.#requireTunnelIfPresent(tunnelId, tunnelName);
      if (!tunnelExists) tunnelId = undefined;
      const dnsExists = await this.#requireDnsRecordIfPresent(
        dnsRecordId,
        hostname,
        input.expected.tunnelId,
        dnsComment,
      );
      if (!dnsExists) dnsRecordId = undefined;
    } else {
      tunnelId = (await this.#findTunnel(tunnelName))?.id;
      const dnsRecord = await this.#findDnsRecordForDeletion(hostname, tunnelId, dnsComment);
      dnsRecordId = dnsRecord?.id;
    }
    if (this.#workersRouteBypass) {
      workersRouteId = (await this.#findWorkersRouteBypass(hostname))?.id;
    }
    if (dnsRecordId) {
      await this.#deleteIfPresent(`/zones/${this.#zoneId}/dns_records/${dnsRecordId}`);
    }
    if (workersRouteId) {
      await this.#deleteIfPresent(`/zones/${this.#zoneId}/workers/routes/${workersRouteId}`);
    }
    if (tunnelId) {
      await this.#deleteIfPresent(
        `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/connections`,
      );
      await this.#deleteIfPresent(`/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}`);
    }
  }

  async #createTunnel(name: string) {
    return this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel`,
      {
        method: "POST",
        body: {
          config_src: "cloudflare",
          name,
        },
      },
      TunnelSchema,
    );
  }

  async #findTunnel(name: string) {
    const tunnels = await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(name)}&per_page=2`,
      { method: "GET" },
      z.array(TunnelSchema).max(2),
    );
    if (tunnels.length > 1) throw new Error("Cloudflare tunnel name is not unique");
    const tunnel = tunnels[0];
    if (tunnel && tunnel.name !== name) {
      throw new Error("Cloudflare tunnel lookup returned a different identity");
    }
    return tunnel;
  }

  async #requireTunnel(tunnelId: string, name: string) {
    const tunnel = await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}`,
      { method: "GET" },
      TunnelSchema,
    );
    if (tunnel.name !== name) {
      throw new Error("Cloudflare tunnel identity does not match Opensteer state");
    }
    return tunnel;
  }

  async #requireTunnelIfPresent(tunnelId: string, name: string): Promise<boolean> {
    try {
      await this.#requireTunnel(tunnelId, name);
      return true;
    } catch (error) {
      if (error instanceof CloudflareResourceNotFoundError) return false;
      throw error;
    }
  }

  async #findDnsRecord(hostname: string, tunnelId: string, dnsComment: string) {
    const records = await this.#request(
      `/zones/${this.#zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=2`,
      { method: "GET" },
      z.array(DnsRecordSchema).max(2),
    );
    if (records.length > 1) throw new Error("Cloudflare DNS route is not unique");
    const record = records[0];
    if (
      record &&
      (record.name !== hostname ||
        record.content !== `${tunnelId}.cfargotunnel.com` ||
        record.comment !== dnsComment ||
        record.proxied !== true)
    ) {
      throw new Error("Cloudflare DNS name is already assigned to another resource");
    }
    return record;
  }

  async #findDnsRecordForDeletion(
    hostname: string,
    tunnelId: string | undefined,
    dnsComment: string,
  ) {
    const records = await this.#request(
      `/zones/${this.#zoneId}/dns_records?type=CNAME&name=${encodeURIComponent(hostname)}&per_page=2`,
      { method: "GET" },
      z.array(DnsRecordSchema).max(2),
    );
    if (records.length > 1) throw new Error("Cloudflare DNS route is not unique");
    const record = records[0];
    if (!record) return undefined;
    const content = /^(?<tunnelId>[0-9a-f-]{36})\.cfargotunnel\.com$/u.exec(record.content)?.groups
      ?.tunnelId;
    if (
      record.name !== hostname ||
      record.comment !== dnsComment ||
      record.proxied !== true ||
      !content ||
      !TunnelIdSchema.safeParse(content).success ||
      (tunnelId !== undefined && content !== tunnelId)
    ) {
      throw new Error("Cloudflare DNS name is assigned to another resource");
    }
    return record;
  }

  async #configureTunnel(tunnelId: string, hostname: string, localOrigin: string): Promise<void> {
    await this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/configurations`,
      {
        method: "PUT",
        body: {
          config: {
            ingress: [{ hostname, service: localOrigin }, { service: "http_status:404" }],
          },
        },
      },
      z.unknown(),
    );
  }

  async #createDnsRecord(hostname: string, tunnelId: string, dnsComment: string) {
    return this.#request(
      `/zones/${this.#zoneId}/dns_records`,
      {
        method: "POST",
        body: {
          comment: dnsComment,
          content: `${tunnelId}.cfargotunnel.com`,
          name: hostname,
          proxied: true,
          ttl: 1,
          type: "CNAME",
        },
      },
      DnsRecordSchema,
    );
  }

  async #ensureWorkersRouteBypass(hostname: string): Promise<void> {
    const pattern = workersRoutePattern(hostname);
    const existing = await this.#findWorkersRouteBypass(hostname);
    if (existing) return;
    const created = await this.#request(
      `/zones/${this.#zoneId}/workers/routes`,
      { method: "POST", body: { pattern } },
      WorkersRouteSchema,
    );
    if (created.pattern !== pattern || created.script) {
      throw new Error("Cloudflare Workers bypass route identity does not match Opensteer state");
    }
  }

  async #findWorkersRouteBypass(hostname: string) {
    const pattern = workersRoutePattern(hostname);
    const routes = await this.#request(
      `/zones/${this.#zoneId}/workers/routes`,
      { method: "GET" },
      z.array(WorkersRouteSchema).max(1_000),
    );
    const matching = routes.filter((route) => route.pattern === pattern);
    if (matching.length > 1) throw new Error("Cloudflare Workers route is not unique");
    const route = matching[0];
    if (route?.script) {
      throw new Error("Cloudflare Connect hostname is assigned to a Worker");
    }
    return route;
  }

  async #requireDnsRecord(
    recordId: string,
    hostname: string,
    tunnelId: string,
    dnsComment: string,
  ): Promise<void> {
    const record = await this.#request(
      `/zones/${this.#zoneId}/dns_records/${recordId}`,
      { method: "GET" },
      DnsRecordSchema,
    );
    if (
      record.name !== hostname ||
      record.content !== `${tunnelId}.cfargotunnel.com` ||
      record.comment !== dnsComment ||
      record.proxied !== true
    ) {
      throw new Error("Cloudflare DNS record does not match Opensteer state");
    }
  }

  async #requireDnsRecordIfPresent(
    recordId: string,
    hostname: string,
    tunnelId: string,
    dnsComment: string,
  ): Promise<boolean> {
    try {
      await this.#requireDnsRecord(recordId, hostname, tunnelId, dnsComment);
      return true;
    } catch (error) {
      if (error instanceof CloudflareResourceNotFoundError) return false;
      throw error;
    }
  }

  async #connectorToken(tunnelId: string): Promise<string> {
    return this.#request(
      `/accounts/${this.#accountId}/cfd_tunnel/${tunnelId}/token`,
      { method: "GET" },
      TunnelTokenSchema,
    );
  }

  async #deleteIfPresent(path: string): Promise<void> {
    try {
      await this.#request(path, { method: "DELETE" }, z.unknown());
    } catch (error) {
      if (error instanceof CloudflareResourceNotFoundError) return;
      throw error;
    }
  }

  async #request<T>(
    path: string,
    input: {
      readonly body?: unknown;
      readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    },
    resultSchema: z.ZodType<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`https://api.cloudflare.com/client/v4${path}`, {
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#apiToken}`,
          ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        },
        method: input.method,
        redirect: "error",
        signal: controller.signal,
      });
      const bytes = await readBoundedResponse(response, {
        maximumBytes: maximumResponseBytes,
        sizeError: () => new Error("Cloudflare response is too large"),
      });
      if (response.status === 404) throw new CloudflareResourceNotFoundError();
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new Error("Cloudflare returned an invalid response");
      }
      if (!response.ok) throw new Error("Cloudflare rejected the Connect operation");
      const envelope = ApiEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) throw new Error("Cloudflare returned an invalid response");
      const result = resultSchema.safeParse(envelope.data.result);
      if (!result.success) throw new Error("Cloudflare returned an invalid response");
      return result.data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Cloudflare Connect request timed out");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

class CloudflareResourceNotFoundError extends Error {
  constructor() {
    super("Cloudflare resource was not found");
    this.name = "CloudflareResourceNotFoundError";
  }
}

function managedHostname(value: string): string {
  const url = new URL(`https://${value}`);
  if (
    value !== value.toLowerCase() ||
    url.hostname !== value ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  ) {
    throw new TypeError("Connect hostname is invalid");
  }
  return value;
}

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (
    url.protocol !== "http:" ||
    !loopback ||
    !url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new TypeError("Connect local origin must be a bare HTTP loopback origin with a port");
  }
  return url.origin;
}

function dnsOwnershipComment(deploymentId: string): string {
  return `Opensteer Connect:${deploymentId}`;
}

function workersRoutePattern(hostname: string): string {
  return `${hostname}/*`;
}
