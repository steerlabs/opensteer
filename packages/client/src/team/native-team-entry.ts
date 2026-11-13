import { teamEntryRefusalOutcome } from "@opensteer/protocol";
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
  type TeamEntryLease,
  type NativeOAuthManager,
} from "../auth/native-oauth.js";
import {
  HostVersionMismatchError,
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
  | "teamEntryLease"
  | "authorizationHeader"
  | "refreshTeamAuthorization"
  | "isTeamSignInSuppressed"
  | "resumeTeamSignIn"
  | "accountIdentity"
  | "accountAuthorizationLease"
  | "beginHostSignIn"
  | "exchangeTeamSession"
  | "signOutHost"
  | "subscribeHostCredentials"
>;
type TeamEntryCatalog = Pick<
  DeploymentCatalogStore,
  "addPendingAccountDeployment" | "load" | "remove" | "upsert"
>;

export type TeamEntryOutcome =
  | { readonly status: "authorized"; readonly admitted: boolean; readonly member?: TeamMember }
  | { readonly status: "join-required"; readonly error: TeamEntryRefusedError }
  | {
      readonly status:
        "retryable" | "update-required" | "sign-in-required" | "suppressed" | "superseded";
      readonly error?: unknown;
    };

// Entry owners on the same OAuth manager share browser and refresh work.
const entryAttempts = new WeakMap<
  TeamEntryOAuth,
  Map<
    DeploymentId,
    {
      mode: "passive" | "interactive";
      invite: TeamInviteSecret | null;
      promise: Promise<TeamEntryOutcome>;
    }
  >
>();

export class NativeTeamEntry {
  readonly #oauth: TeamEntryOAuth;
  readonly #catalog: TeamEntryCatalog;
  readonly #bootstrap: (connection: DeploymentConnection) => Promise<TeamMember>;
  readonly #verify: (origin: string) => Promise<VerifiedHostEndpoint>;

  constructor(options: {
    readonly oauth: TeamEntryOAuth;
    readonly catalog: TeamEntryCatalog;
    readonly bootstrap: (connection: DeploymentConnection) => Promise<TeamMember>;
    readonly verify: (origin: string) => Promise<VerifiedHostEndpoint>;
  }) {
    this.#oauth = options.oauth;
    this.#catalog = options.catalog;
    this.#bootstrap = options.bootstrap;
    this.#verify = options.verify;
  }

  authorize(input: {
    readonly deploymentId: DeploymentId;
    readonly origin: string;
    readonly mode: "passive" | "interactive";
    readonly invite?: TeamInviteSecret | null;
    readonly recover?: { readonly authorization: string | null | undefined };
  }): Promise<TeamEntryOutcome> {
    return this.#enqueue(input, this.#oauth.teamEntryLease(input.deploymentId));
  }

  async #enqueue(
    input: Parameters<NativeTeamEntry["authorize"]>[0],
    lease: TeamEntryLease,
  ): Promise<TeamEntryOutcome> {
    try {
      lease.assertCurrent();
      let attempts = entryAttempts.get(this.#oauth);
      if (!attempts) entryAttempts.set(this.#oauth, (attempts = new Map()));
      const held = attempts.get(input.deploymentId);
      if (held) {
        if (input.mode === "passive" && held.mode === "interactive")
          return this.#passiveDuringBrowser(input, held.promise, lease);
        if (
          input.mode === "passive" ||
          (held.mode === "interactive" && sameInvite(held.invite, input.invite))
        )
          return await held.promise.then(async (outcome) => {
            lease.assertCurrent();
            if (!input.recover || outcome.status !== "authorized") return outcome;
            const connection = await this.#held(input.deploymentId);
            lease.assertCurrent();
            if (!connection) return { status: "retryable" };
            const authorization = await this.#oauth.authorizationHeader(connection);
            lease.assertCurrent();
            if (authorization && authorization !== input.recover.authorization) return outcome;
            return this.#enqueue(input, lease);
          });
        const outcome = await held.promise;
        lease.assertCurrent();
        return outcome.status === "authorized" && !input.invite
          ? outcome
          : this.#enqueue(input, lease);
      }
      const promise = this.#authorize(input).finally(() => {
        if (attempts.get(input.deploymentId)?.promise === promise)
          attempts.delete(input.deploymentId);
      });
      attempts.set(input.deploymentId, { mode: input.mode, invite: input.invite ?? null, promise });
      return promise;
    } catch (error) {
      try {
        lease.assertCurrent();
      } catch {
        return { status: "superseded" };
      }
      throw error;
    }
  }

  async #passiveDuringBrowser(
    input: Parameters<NativeTeamEntry["authorize"]>[0],
    pending: Promise<TeamEntryOutcome>,
    lease: TeamEntryLease,
  ): Promise<TeamEntryOutcome> {
    const entry = lease;
    try {
      const connection = await this.#held(input.deploymentId);
      entry.assertCurrent();
      if (connection && !this.#oauth.isTeamSignInSuppressed(connection)) {
        const authorization = input.recover
          ? await this.#oauth.refreshTeamAuthorization(connection, input.recover.authorization)
          : await this.#oauth.authorizationHeader(connection);
        entry.assertCurrent();
        if (authorization && (!input.recover || authorization !== input.recover.authorization))
          return { status: "authorized", admitted: false };
      }
    } catch (error) {
      try {
        lease.assertCurrent();
      } catch {
        return { status: "superseded" };
      }
      return { status: "retryable", error };
    }
    return pending.then(() => this.#enqueue(input, lease));
  }

  async #authorize(input: Parameters<NativeTeamEntry["authorize"]>[0]): Promise<TeamEntryOutcome> {
    const entry = this.#oauth.teamEntryLease(input.deploymentId, input.mode === "interactive");
    let createdRevision: number | undefined;
    try {
      if (input.recover) {
        const held = await this.#held(input.deploymentId);
        entry.assertCurrent();
        if (held) {
          if (this.#oauth.isTeamSignInSuppressed(held)) return { status: "suppressed" };
          const refreshed = await this.#oauth.refreshTeamAuthorization(
            held,
            input.recover.authorization,
          );
          entry.assertCurrent();
          if (refreshed && refreshed !== input.recover.authorization && !input.invite)
            return { status: "authorized", admitted: false };
        }
      }
      const verified = await this.#verify(input.origin);
      entry.assertCurrent();
      if (verified.discovery.deploymentId !== input.deploymentId)
        throw new Error("That address now answers as a different team.");
      const held = await this.#held(input.deploymentId);
      entry.assertCurrent();
      const identity = this.#oauth.accountIdentity();
      const connectionInput = deploymentConnectionFromVerifiedEndpoints({
        accountAccess: held?.accountAccess ?? null,
        endpoints: [verified],
        kind: "team",
        name: held?.name ?? new URL(input.origin).hostname,
        source:
          held?.source ??
          (identity && verified.capabilities.includes("team-session-exchange-v1")
            ? { kind: "account", issuer: identity.issuer, subject: identity.subject }
            : { kind: "manual" }),
      });
      const catalog = await (held || connectionInput.source.kind !== "account"
        ? this.#catalog.upsert(connectionInput)
        : this.#catalog.addPendingAccountDeployment(connectionInput));
      if (!held) createdRevision = catalog.revision;
      entry.assertCurrent();
      const connection = catalog.deployments.find(
        ({ authority }) => authority.document.deploymentId === input.deploymentId,
      )!;
      if (input.mode === "interactive") await this.#oauth.resumeTeamSignIn(connection, entry);
      else if (this.#oauth.isTeamSignInSuppressed(connection)) return { status: "suppressed" };
      entry.assertCurrent();
      const existing = await this.#oauth.authorizationHeader(connection);
      entry.assertCurrent();
      if (existing && (!input.recover || existing !== input.recover.authorization) && !input.invite)
        return { status: "authorized", admitted: false };
      if (
        verified.capabilities.includes("team-session-exchange-v1") &&
        (await this.#oauth.accountAuthorizationLease())
      ) {
        entry.assertCurrent();
        try {
          const result = await this.#oauth.exchangeTeamSession(
            connection,
            input.invite ?? undefined,
            entry,
          );
          entry.assertCurrent();
          return { status: "authorized", ...result };
        } catch (error) {
          if (!(error instanceof TeamIdentityGrantUnsupportedError)) throw error;
        }
      }
      entry.assertCurrent();
      if (input.mode === "passive") return { status: "sign-in-required" };
      await this.#browserSignIn(connection, input.invite ?? null, entry);
      entry.assertCurrent();
      return { status: "authorized", admitted: false };
    } catch (error) {
      try {
        entry.assertCurrent();
      } catch {
        return { status: "superseded" };
      }
      if (createdRevision !== undefined)
        await this.#catalog.remove(input.deploymentId, createdRevision).catch(() => undefined);
      if (error instanceof TeamEntryRefusedError)
        return {
          status:
            teamEntryRefusalOutcome(error.reason) === "membership" ? "join-required" : "retryable",
          error,
        };
      return {
        status: error instanceof HostVersionMismatchError ? "update-required" : "retryable",
        error,
      };
    }
  }

  async enter(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null,
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member">> {
    const result = await this.ensureAuthorized(verified, invite);
    if (result) return result;
    return this.bootstrap(verified.discovery.deploymentId);
  }

  async bootstrap(
    deploymentId: DeploymentId,
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member">> {
    const entry = this.#oauth.teamEntryLease(deploymentId);
    const connection = (await this.#held(deploymentId))!;
    entry.assertCurrent();
    const member = await this.#bootstrap(connection);
    entry.assertCurrent();
    return { admitted: false, member };
  }

  async ensureAuthorized(
    verified: VerifiedHostEndpoint,
    invite: TeamInviteSecret | null = null,
    interactive = true,
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member"> | null> {
    const outcome = await this.authorize({
      deploymentId: verified.discovery.deploymentId,
      origin: verified.discovery.canonicalOrigin,
      mode: interactive ? "interactive" : "passive",
      invite,
    });
    assertTeamEntryOutcome(outcome);
    return outcome.status === "authorized" && outcome.member
      ? { admitted: outcome.admitted, member: outcome.member }
      : null;
  }

  async restore(deploymentId: DeploymentId, origin: string): Promise<void> {
    assertTeamEntryOutcome(await this.authorize({ deploymentId, origin, mode: "passive" }));
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

  async #browserSignIn(
    connection: DeploymentConnection,
    invite: TeamInviteSecret | null,
    entry: TeamEntryLease,
  ): Promise<void> {
    entry.assertCurrent();
    const deploymentId = connection.authority.document.deploymentId;
    let stop = () => {};
    let stopAbort = () => {};
    const ended = new Promise<HostOAuthState>((resolve) => {
      let authorizing = false;
      stop = this.#oauth.subscribeHostCredentials((state) => {
        if (state.connection.authority.document.deploymentId !== deploymentId) return;
        if (state.status === "authorizing") authorizing = true;
        else if (authorizing) resolve(state);
      });
    });
    try {
      const browser = this.#oauth
        .beginHostSignIn(connection, invite ?? undefined, entry)
        .then((begun) => (begun.status === "authorizing" ? ended : begun));
      const final = await Promise.race([
        browser,
        ended,
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(entry.signal.reason);
          stopAbort = () => entry.signal.removeEventListener("abort", abort);
          if (entry.signal.aborted) abort();
          else entry.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      if (final.status !== "signed-in")
        throw new ClientOperationError(
          final.detail ?? "The team’s sign-in didn’t finish. Try again.",
          "blocked",
        );
    } finally {
      stop();
      stopAbort();
    }
  }
}

export function assertTeamEntryOutcome(outcome: TeamEntryOutcome): void {
  if (outcome.status === "authorized" || outcome.status === "suppressed") return;
  throw (
    ("error" in outcome && outcome.error) ||
    new ClientOperationError(
      outcome.status === "sign-in-required"
        ? "Sign in to this team."
        : "Team authorization changed. Try again.",
      outcome.status === "sign-in-required" ? "blocked" : "transient",
    )
  );
}

function sameInvite(a: TeamInviteSecret | null, b: TeamInviteSecret | null | undefined): boolean {
  return a?.selector === b?.selector && a?.verifier === b?.verifier;
}
