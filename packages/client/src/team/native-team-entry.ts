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
  type TeamMember,
} from "@opensteer/protocol";
import { z } from "zod";
import {
  TeamEntryRefusedError,
  TeamIdentityGrantUnsupportedError,
  type HostOAuthState,
  type NativeOAuthManager,
} from "../auth/native-oauth.js";
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
  | "authorizationHeader"
  | "isTeamSignInSuppressed"
  | "resumeTeamSignIn"
  | "accountAuthorizationLease"
  | "beginHostSignIn"
  | "exchangeTeamSession"
  | "hostCredentialState"
  | "signOutHost"
  | "subscribeHostCredentials"
>;
type TeamEntryCatalog = Pick<
  DeploymentCatalogStore,
  "addPendingAccountDeployment" | "load" | "remove" | "upsert"
>;

/** Shared by device entry and an attachment's explicit authorization action. */
export async function authorizeTeamCredential(
  oauth: TeamEntryOAuth,
  connection: DeploymentConnection,
  invite: TeamInviteSecret | null,
  interactive: boolean,
): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member"> | null | false> {
  if (interactive) await oauth.resumeTeamSignIn(connection);
  else if (oauth.isTeamSignInSuppressed(connection)) return null;
  if (await oauth.authorizationHeader(connection)) return null;
  if (
    connection.capabilities?.includes("team-session-exchange-v1") &&
    (await oauth.accountAuthorizationLease())
  ) {
    try {
      return await oauth.exchangeTeamSession(connection, invite ?? undefined);
    } catch (error) {
      if (!(error instanceof TeamIdentityGrantUnsupportedError)) throw error;
    }
  }
  return false;
}

/**
 * Entering a team as the signed-in Account, where this device keeps its credentials (desktop
 * main, the phone). The team stays on the device as an Account entry until Account's directory
 * lists it, which happens shortly after membership is published.
 */
export class NativeTeamEntry {
  readonly #oauth: TeamEntryOAuth;
  readonly #catalog: TeamEntryCatalog;
  readonly #bootstrap: (connection: DeploymentConnection) => Promise<TeamMember>;

  constructor(options: {
    readonly oauth: TeamEntryOAuth;
    readonly catalog: TeamEntryCatalog;
    readonly bootstrap: (connection: DeploymentConnection) => Promise<TeamMember>;
  }) {
    this.#oauth = options.oauth;
    this.#catalog = options.catalog;
    this.#bootstrap = options.bootstrap;
  }

  async enter(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null,
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member">> {
    const entered = await this.ensureAuthorized(verified, invite);
    if (entered) return entered;
    const connection = (await this.#held(verified.discovery.deploymentId))!;
    return { admitted: false, member: await this.#bootstrap(connection) };
  }

  /**
   * A team whose server predates native team sessions, or whose Account can't vouch yet: kept as
   * if added by hand, then its own sign-in in the system browser, through `invite` when given so
   * the team admits the person there. Settles once the callback lands, or the flow is stopped or
   * expires.
   */
  async signIn(verified: VerifiedHostEndpoint, invite: TeamInviteSecret | null): Promise<void> {
    await this.ensureAuthorized(verified, invite);
  }

  async ensureAuthorized(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null = null,
    interactive = true,
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member"> | null> {
    const deploymentId = verified.discovery.deploymentId;
    const held = await this.#held(deploymentId);
    try {
      if (held) {
        const catalog = await this.#catalog.upsert(
          deploymentConnectionFromVerifiedEndpoints({
            accountAccess: held.accountAccess,
            endpoints: [verified],
            kind: "team",
            name: held.name,
            source: held.source,
          }),
        );
        const refreshed = catalog.deployments.find(
          (entry) => entry.authority.document.deploymentId === deploymentId,
        )!;
        const authorized = await authorizeTeamCredential(
          this.#oauth,
          refreshed,
          invite,
          interactive,
        );
        if (authorized !== false) return authorized;
        if (interactive) await this.#browserSignIn(refreshed, invite);
        return null;
      }
      const canExchange =
        verified.capabilities.includes("team-session-exchange-v1") &&
        (await this.#oauth.accountAuthorizationLease());
      const connection = canExchange
        ? await this.#keep(verified)
        : await this.#keepManual(verified);
      const authorized = await authorizeTeamCredential(
        this.#oauth,
        connection,
        invite,
        interactive,
      );
      if (authorized !== false) return authorized;
      if (interactive) await this.#browserSignIn(connection, invite);
      return null;
    } catch (error) {
      if (held === null) await this.#catalog.remove(deploymentId).catch(() => undefined);
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
    if (
      held &&
      (this.#oauth.isTeamSignInSuppressed(held) || (await this.#oauth.authorizationHeader(held)))
    )
      return;
    const verified = await verify();
    if (verified.discovery.deploymentId !== deploymentId)
      throw new Error("That address now answers as a different team.");
    await this.ensureAuthorized(verified, null, false);
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

  async #keepManual(verified: VerifiedHostEndpoint): Promise<DeploymentConnection> {
    const deploymentId = verified.discovery.deploymentId;
    const catalog = await this.#catalog.upsert(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [verified],
        kind: "team",
        name: new URL(verified.discovery.canonicalOrigin).hostname,
        source: { kind: "manual" },
      }),
    );
    const kept = catalog.deployments.find(
      (connection) => connection.authority.document.deploymentId === deploymentId,
    );
    if (!kept) throw new Error("The team couldn’t be kept on this device.");
    return kept;
  }

  async #browserSignIn(
    connection: DeploymentConnection,
    invite: TeamInviteSecret | null,
  ): Promise<void> {
    if (this.#oauth.hostCredentialState(connection).status === "signed-in") return;
    const deploymentId = connection.authority.document.deploymentId;
    let stop = () => {};
    const ended = new Promise<HostOAuthState>((resolve) => {
      let authorizing = false;
      stop = this.#oauth.subscribeHostCredentials((state) => {
        if (state.connection.authority.document.deploymentId !== deploymentId) return;
        if (state.status === "authorizing") authorizing = true;
        else if (authorizing) resolve(state);
      });
    });
    try {
      const begun = await this.#oauth.beginHostSignIn(connection, invite ?? undefined);
      const final = begun.status === "authorizing" ? await ended : begun;
      if (final.status !== "signed-in")
        throw new ClientOperationError(
          final.detail ?? "The team’s sign-in didn’t finish. Try again.",
          "blocked",
        );
    } finally {
      stop();
    }
  }

  async #keep(verified: VerifiedHostEndpoint): Promise<DeploymentConnection> {
    const lease = await this.#oauth.accountAuthorizationLease();
    if (!lease)
      throw new ClientOperationError(
        "Sign in to your Opensteer account to join a team.",
        "blocked",
      );
    const deploymentId = verified.discovery.deploymentId;
    const catalog = await this.#catalog.addPendingAccountDeployment(
      deploymentConnectionFromVerifiedEndpoints({
        accountAccess: null,
        endpoints: [verified],
        kind: "team",
        name: new URL(verified.discovery.canonicalOrigin).hostname,
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
