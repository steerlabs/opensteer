import { createHash, randomUUID } from "node:crypto";
import {
  ConnectOperationIdSchema,
  type ConnectOperationId,
} from "@opensteer/control-plane-protocol";
import { DeploymentIdSchema } from "@opensteer/core";
import { z } from "zod";
import {
  connectResourceNotFoundMessage,
  connectTunnelName,
  dnsOwnershipComment,
  loopbackOrigin,
  managedHostname,
  type CloudflareConnectResource,
  type ConnectResourceProvider,
  type DeleteCloudflareConnectInput,
  type EnsureCloudflareConnectInput,
  type ProvisionedCloudflareConnect,
} from "./cloudflare-connect-provider.js";

/**
 * The account service's tunnel provider for a machine with no Cloudflare credential: the first-run
 * journey in a VM and the provider contract test. It keeps Cloudflare's side of a Connect route in
 * memory and answers every call the way `CloudflareConnectProvider` does: the same input checks
 * and names (its own exported helpers), the same deterministic identity on a retry, the same
 * refusals for a stored resource that doesn't match, the same "not found" for one that is gone.
 *
 * What it cannot be is Cloudflare: no tunnel exists anywhere, so its connector token starts no
 * connector a phone outside can reach. It is never built from configuration; only code that
 * hands it to `startControlPlane` uses it.
 */
export class MemoryConnectProvider implements ConnectResourceProvider {
  readonly #tunnels = new Map<
    string,
    { readonly id: string; readonly name: string; ingress: string | null; secret: number }
  >();
  readonly #records = new Map<
    string,
    { readonly id: string; readonly hostname: string; readonly content: string; comment: string }
  >();
  /** Every call, in order, with what it was asked: the journey's evidence of what was provisioned. */
  readonly calls: { readonly call: string; readonly deploymentId?: string }[] = [];

  async ensure(input: EnsureCloudflareConnectInput): Promise<ProvisionedCloudflareConnect> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    this.calls.push({ call: "ensure", deploymentId });
    const hostname = managedHostname(input.hostname);
    const localOrigin = loopbackOrigin(input.localOrigin);
    const tunnelName = connectTunnelName(deploymentId);
    const dnsComment = dnsOwnershipComment(deploymentId);
    let tunnel;
    let record;
    if (input.expected) {
      if (input.expected.hostname !== hostname || input.expected.tunnelName !== tunnelName) {
        throw new TypeError("Stored Connect resource does not match the Deployment identity");
      }
      tunnel = this.#requireTunnel(TunnelIdSchema.parse(input.expected.tunnelId), tunnelName);
      record = this.#requireRecord(
        CloudflareIdSchema.parse(input.expected.dnsRecordId),
        hostname,
        tunnel.id,
        dnsComment,
      );
    } else {
      // A retry after a lost answer finds what the first attempt made, by its name.
      tunnel = [...this.#tunnels.values()].find((candidate) => candidate.name === tunnelName);
      if (!tunnel) {
        tunnel = { id: randomUUID(), ingress: null, name: tunnelName, secret: 0 };
        this.#tunnels.set(tunnel.id, tunnel);
      }
    }
    tunnel.ingress = localOrigin;
    if (!record) {
      record = [...this.#records.values()].find((candidate) => candidate.hostname === hostname);
      if (
        record &&
        (record.content !== `${tunnel.id}.cfargotunnel.com` || record.comment !== dnsComment)
      ) {
        throw new Error("Cloudflare DNS name is already assigned to another resource");
      }
      if (!record) {
        record = {
          comment: dnsComment,
          content: `${tunnel.id}.cfargotunnel.com`,
          hostname,
          id: randomUUID().replaceAll("-", ""),
        };
        this.#records.set(record.id, record);
      }
    }
    return {
      connectorToken: this.#token(tunnel),
      dnsRecordId: record.id,
      hostname,
      tunnelId: tunnel.id,
      tunnelName,
    };
  }

  async rotateConnectorToken(
    resource: CloudflareConnectResource,
    operationId: ConnectOperationId,
  ): Promise<string> {
    const tunnelId = TunnelIdSchema.parse(resource.tunnelId);
    ConnectOperationIdSchema.parse(operationId);
    this.calls.push({ call: "rotateConnectorToken" });
    const tunnel = this.#requireTunnel(tunnelId, resource.tunnelName);
    // A new tunnel secret: every token issued before it stops working.
    tunnel.secret += 1;
    return this.#token(tunnel);
  }

  async readConnectorToken(resource: CloudflareConnectResource): Promise<string> {
    const tunnelId = TunnelIdSchema.parse(resource.tunnelId);
    this.calls.push({ call: "readConnectorToken" });
    return this.#token(this.#requireTunnel(tunnelId, resource.tunnelName));
  }

  async delete(input: DeleteCloudflareConnectInput): Promise<void> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    this.calls.push({ call: "delete", deploymentId });
    const hostname = managedHostname(input.hostname);
    const tunnelName = connectTunnelName(deploymentId);
    if (input.expected) {
      if (input.expected.hostname !== hostname || input.expected.tunnelName !== tunnelName) {
        throw new TypeError("Stored Connect resource does not match the Deployment identity");
      }
      this.#records.delete(CloudflareIdSchema.parse(input.expected.dnsRecordId));
      this.#tunnels.delete(TunnelIdSchema.parse(input.expected.tunnelId));
      return;
    }
    for (const [id, record] of this.#records)
      if (record.hostname === hostname) this.#records.delete(id);
    for (const [id, tunnel] of this.#tunnels)
      if (tunnel.name === tunnelName) this.#tunnels.delete(id);
  }

  #requireTunnel(tunnelId: string, name: string) {
    const tunnel = this.#tunnels.get(tunnelId);
    if (!tunnel) throw new Error(connectResourceNotFoundMessage);
    if (tunnel.name !== name) {
      throw new Error("Cloudflare tunnel identity does not match Opensteer state");
    }
    return tunnel;
  }

  #requireRecord(recordId: string, hostname: string, tunnelId: string, comment: string) {
    const record = this.#records.get(recordId);
    if (!record) throw new Error(connectResourceNotFoundMessage);
    if (
      record.hostname !== hostname ||
      record.content !== `${tunnelId}.cfargotunnel.com` ||
      record.comment !== comment
    ) {
      throw new Error("Cloudflare DNS record does not match Opensteer state");
    }
    return record;
  }

  /** Shaped as a connector token is (opaque, base64), derived from the tunnel and its secret. */
  #token(tunnel: { readonly id: string; readonly secret: number }): string {
    return createHash("sha256")
      .update(`opensteer-memory-connect:${tunnel.id}:${tunnel.secret}`)
      .digest("base64");
  }
}

const CloudflareIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const TunnelIdSchema = z.uuid();
