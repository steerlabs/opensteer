import type { DeploymentId, TeamInviteSecret } from "@opensteer/core";
import {
  hostKeyFingerprint,
  teamApiVersion,
  teamApiVersionHeader,
} from "@opensteer/deployment-authority";
import {
  HostApiErrorSchema,
  TeamEntryRefusalReasonSchema,
  TeamInvitePreviewResponseSchema,
  teamInvitePreviewPath,
  type TeamInvitePreviewResponse,
  type TeamSessionExchangeResponse,
} from "@opensteer/protocol";
import { z } from "zod";
import { TeamEntryRefusedError, type NativeOAuthManager } from "../auth/native-oauth.js";
import {
  deploymentConnectionFromVerifiedEndpoints,
  verifyAccessEndpoint,
  type DeploymentCatalogStore,
  type DeploymentConnection,
  type VerifiedHostEndpoint,
} from "../connections/deployment-catalog.js";
import { ClientOperationError } from "../connections/operation-error.js";
import type { VerifiedTeam } from "./team-coordinator.js";

export function verifiedTeam(verified: VerifiedHostEndpoint): VerifiedTeam {
  return {
    authority: {
      deploymentId: verified.discovery.deploymentId,
      hostInstanceId: verified.discovery.hostInstanceId,
      canonicalOrigin: verified.discovery.canonicalOrigin,
      hostKeyFingerprint: hostKeyFingerprint(verified.discoveryEnvelope.publicKey.spki),
    },
    capabilities: verified.capabilities,
  };
}

/** A team Host at an origin, verified through its signed discovery. Sends no credential. */
export async function verifyTeamEndpoint(
  origin: string,
  options: { readonly fetch: typeof globalThis.fetch; readonly signal?: AbortSignal },
): Promise<VerifiedHostEndpoint> {
  const verified = await verifyAccessEndpoint({
    fetch: options.fetch,
    kind: "canonical",
    origin,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (verified.discovery.deploymentShape.kind !== "team")
    throw new Error("That link isn't for a team. Ask whoever sent it for the team's invite link.");
  return verified;
}

/** What an invite is for, before anyone joins with it. Consumes nothing. */
export async function previewTeamInvite(
  origin: string,
  invite: TeamInviteSecret,
  fetch: typeof globalThis.fetch,
): Promise<TeamInvitePreviewResponse> {
  const response = await fetch(new URL(teamInvitePreviewPath, origin).toString(), {
    body: JSON.stringify(invite),
    cache: "no-store",
    credentials: "omit",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      [teamApiVersionHeader]: String(teamApiVersion),
    },
    method: "POST",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return TeamInvitePreviewResponseSchema.parse(body);
  const error = z.object({ error: HostApiErrorSchema }).safeParse(body).data?.error;
  const reason = TeamEntryRefusalReasonSchema.safeParse(error?.reason).data;
  if (error && reason) throw new TeamEntryRefusedError(reason, error.message);
  throw new ClientOperationError(
    error?.message ?? "The team couldn’t be reached. Try again.",
    response.status >= 500 ? "transient" : "blocked",
  );
}

type TeamEntryOAuth = Pick<
  NativeOAuthManager,
  "accountAuthorizationLease" | "exchangeTeamSession" | "hostCredentialState" | "signOutHost"
>;
type TeamEntryCatalog = Pick<DeploymentCatalogStore, "addPendingAccountDeployment" | "load" | "remove">;

/**
 * Entering a team as the signed-in Account, where this device keeps its credentials (desktop
 * main, the phone). The team stays on the device as an Account entry until Account's directory
 * lists it, which happens shortly after membership is published.
 */
export class NativeTeamEntry {
  readonly #oauth: TeamEntryOAuth;
  readonly #catalog: TeamEntryCatalog;

  constructor(options: { readonly oauth: TeamEntryOAuth; readonly catalog: TeamEntryCatalog }) {
    this.#oauth = options.oauth;
    this.#catalog = options.catalog;
  }

  async enter(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null,
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member">> {
    const held = await this.#held(verified.discovery.deploymentId);
    const connection = await this.#keep(verified, held);
    try {
      return await this.#oauth.exchangeTeamSession(connection, invite ?? undefined);
    } catch (error) {
      // Someone the team turned away keeps no entry for it.
      if (held === null)
        await this.#catalog.remove(verified.discovery.deploymentId).catch(() => undefined);
      throw error;
    }
  }

  /**
   * After a restart, before Account's directory lists a team entered here: the entry again, and a
   * session again only if its credential is gone. Teams the directory lists need nothing.
   */
  async restore(
    deploymentId: DeploymentId,
    verify: () => Promise<VerifiedHostEndpoint>,
  ): Promise<void> {
    const held = await this.#held(deploymentId);
    if (held && (held.source.kind === "manual" || held.accountAccess !== null)) return;
    const verified = await verify();
    if (verified.discovery.deploymentId !== deploymentId)
      throw new Error("That address now answers as a different team.");
    const connection = await this.#keep(verified, held);
    if (this.#oauth.hostCredentialState(connection).status === "signed-in") return;
    await this.#oauth.exchangeTeamSession(connection);
  }

  /** Drops this device's credential and entry for the team. */
  async forget(deploymentId: DeploymentId): Promise<void> {
    const held = await this.#held(deploymentId);
    if (held === null) return;
    await this.#oauth.signOutHost(held).catch(() => undefined);
    await this.#catalog.remove(deploymentId);
  }

  async #held(deploymentId: DeploymentId): Promise<DeploymentConnection | null> {
    return (
      (await this.#catalog.load()).deployments.find(
        (connection) => connection.authority.document.deploymentId === deploymentId,
      ) ?? null
    );
  }

  async #keep(
    verified: VerifiedHostEndpoint,
    held: DeploymentConnection | null,
  ): Promise<DeploymentConnection> {
    // A team the person added by hand stays exactly as they added it.
    if (held?.source.kind === "manual") return held;
    const lease = await this.#oauth.accountAuthorizationLease();
    if (!lease)
      throw new ClientOperationError("Sign in to your Opensteer account to join a team.", "blocked");
    const deploymentId = verified.discovery.deploymentId;
    const catalog = await this.#catalog.addPendingAccountDeployment(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: held?.accountAccess ?? null,
        endpoints: [verified],
        kind: "team",
        name: held?.name ?? new URL(verified.discovery.canonicalOrigin).hostname,
        source: { kind: "account", issuer: lease.issuer, subject: lease.subject },
      }),
    );
    const kept = catalog.deployments.find(
      (connection) => connection.authority.document.deploymentId === deploymentId,
    );
    if (!kept) throw new Error("The team couldn’t be kept on this device.");
    return kept;
  }
}
