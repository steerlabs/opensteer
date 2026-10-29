import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { digestSecret } from "@opensteer/shared/secretDigest";
import {
  OpensteerError,
  type AuthenticatedSession,
  type AuthSessionId,
  type PersonalRemoteSessionDelivery,
} from "@opensteer/core";
import type { DatabaseSchema } from "@opensteer/database";
import {
  AccountHostSessionGrantClaimsSchema,
  AccountLinkGenerationSchema,
  type AccountHostSessionClientSurface,
  PersonalHostAccountLinkCompletionGrantClaimsSchema,
  PersonalHostAccountLinkChallengeIdSchema,
  PersonalHostAccessAuthoritySchema,
  PersonalHostAccessRouteDocumentSchema,
  PersonalHostAccountLinkProofEnvelopeSchema,
  RevokeConnectRequestSchema,
  type RevokeConnectRequest,
  type RevokeConnectResponse,
  personalHostAccessRouteEnvelopeSha256,
  type IssuePersonalHostAccountLinkChallengeResponse,
  type PersonalHostAccessAuthority,
  type PersonalHostAccessRouteDocument,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/control-plane-protocol";
import type { IdentityService, IssuedPersonalRemoteSession } from "@opensteer/identity";
import {
  ConfigurePersonalRemoteAccessRequestSchema,
  ApprovePersonalHostAccountLinkRequestSchema,
  ConsumePersonalHostAccountLinkRequestSchema,
  IssuePersonalPairingCodeResponseSchema,
  PersonalPairingCodeCredentialSchema,
  PersonalPairingCodeSchema,
  PersonalRemoteAccessStatusSchema,
  PublishPersonalConnectProjectionRequestSchema,
  RemotePersonalRemoteAccessStatusSchema,
  sessionExchangeDeliveryForClientSurface,
  ResumePersonalHostAccountLinkRequestSchema,
  type ConfigurePersonalRemoteAccessRequest,
  type IssuePersonalPairingCodeResponse,
  type PersonalPairingCodeCredential,
  type PersonalRemoteAccessStatus,
  type RemotePersonalRemoteAccessStatus,
} from "@opensteer/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type { AuthenticatedHostSession } from "../identity/auth.js";
import type { HostKeyPair } from "../identity/host-keys.js";
import { signHostDiscovery, signPersonalHostAccessRoute } from "../identity/host-keys.js";
import { signPersonalHostAccountLinkProof } from "../identity/host-keys.js";
import type { PersonalAccountGrantVerifier } from "./personal-account-grant-verifier.js";
import {
  AccountDirectoryClient,
  PersonalAccountLinkActivationExpiredError,
  PersonalAccountLinkCancelledError,
  PersonalAccountLinkNotFoundError,
} from "./account-directory-client.js";

/**
 * Which side of the machine boundary is asking. The owner's own computer sees
 * the whole link; a session that arrived over a signed access route sees only
 * whether the link is usable.
 */
export type PersonalRemoteAccessStatusCaller = "machine-local" | "remote";

/**
 * What an exchange arm hands back: the response headers the delivery needs —
 * a `Set-Cookie` for the cookie family, none for the header family — and the
 * issued session itself, which carries the credential only when there is
 * nowhere else to put it.
 */
export interface PersonalRemoteSessionExchange {
  readonly headers: Headers;
  readonly issued: IssuedPersonalRemoteSession;
}

const pairingCodeLifetimeMilliseconds = 10 * 60 * 1_000;
const maximumPendingPairingCodes = 64;
const sessionGrantReplayRetentionMilliseconds = 10 * 60 * 1_000;
const sessionExchangeRateWindowMilliseconds = 60_000;
const maximumSessionExchangesPerAccount = 30;
const maximumSessionExchangesPerIp = 60;

export interface PersonalRemoteSessionAuthenticator {
  authenticateRemoteCredential(credential: string): Promise<AuthenticatedSession | null>;
  authenticateRemoteSession(
    headers: Readonly<Record<string, string | readonly string[] | number | undefined>>,
    options?: { readonly mutation?: boolean },
  ): Promise<AuthenticatedSession | null>;
}

/**
 * Durable Personal reachability authority. The canonical Host remains
 * loopback-only; this service signs and fences optional HTTPS access routes.
 */
export class PersonalRemoteAccessService implements PersonalRemoteSessionAuthenticator {
  readonly #authority: PersonalHostAccessAuthority;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #identity: IdentityService;
  readonly #keys: Pick<HostKeyPair, "privateKey" | "publicKey">;
  readonly #grantVerifier: PersonalAccountGrantVerifier | undefined;
  readonly #now: () => Date;
  readonly #fetch: typeof globalThis.fetch;
  readonly #disconnectRunners: () => Promise<void>;

  constructor(options: {
    readonly authority: PersonalHostAccessAuthority;
    readonly database: Kysely<DatabaseSchema>;
    /**
     * Drops the computers that reached this Deployment over the route being
     * replaced. Injected because reachability is durable state and the Runner
     * registry is live state: this service owns the first and knows nothing
     * about the second.
     */
    readonly disconnectRunners?: () => Promise<void>;
    readonly identity: IdentityService;
    readonly keys: Pick<HostKeyPair, "privateKey" | "publicKey">;
    readonly grantVerifier?: PersonalAccountGrantVerifier;
    readonly fetch?: typeof globalThis.fetch;
    readonly now?: () => Date;
  }) {
    this.#authority = PersonalHostAccessAuthoritySchema.parse(options.authority);
    this.#database = options.database;
    this.#identity = options.identity;
    this.#keys = options.keys;
    this.#grantVerifier = options.grantVerifier;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#disconnectRunners = options.disconnectRunners ?? (async () => undefined);
  }

  /**
   * Whether this session was established at the keyboard of the computer that
   * runs this Host: the owner claim recorded a marker for it, and the caller
   * presented that session's own browser cookie.
   */
  async isMachineLocalSession(caller: AuthenticatedHostSession): Promise<boolean> {
    return this.#database
      .transaction()
      .execute((transaction) => machineLocalSession(transaction, caller));
  }

  status(caller: "machine-local"): Promise<PersonalRemoteAccessStatus>;
  status(caller: "remote"): Promise<RemotePersonalRemoteAccessStatus>;
  status(
    caller: PersonalRemoteAccessStatusCaller,
  ): Promise<PersonalRemoteAccessStatus | RemotePersonalRemoteAccessStatus>;
  async status(
    caller: PersonalRemoteAccessStatusCaller,
  ): Promise<PersonalRemoteAccessStatus | RemotePersonalRemoteAccessStatus> {
    const [state, account] = await Promise.all([
      this.#database
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom("personalRemoteAccountLink")
        .select(["issuer", "linkGeneration", "state", "subject"])
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirst(),
    ]);
    const shared = {
      generation: Number(state.generation),
      mode: state.mode,
      route: state.mode === "off" ? null : this.#signedRoute(state),
      schemaVersion: 2,
    } as const;
    if (caller === "remote") {
      return RemotePersonalRemoteAccessStatusSchema.parse({
        accountLink: account ? { state: account.state } : null,
        ...shared,
      });
    }
    return PersonalRemoteAccessStatusSchema.parse({
      accountLink: account
        ? {
            generation: account.linkGeneration,
            issuer: account.issuer,
            state: account.state,
            subject: account.subject,
          }
        : null,
      ...shared,
    });
  }

  async configure(
    caller: AuthenticatedHostSession,
    input: ConfigurePersonalRemoteAccessRequest | unknown,
  ): Promise<PersonalRemoteAccessStatus> {
    requireLocalOwner(caller.session);
    const request = ConfigurePersonalRemoteAccessRequestSchema.parse(input);
    let reconfigured = false;
    let ended: readonly AuthSessionId[] = [];
    await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      const current = await transaction
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const account = await transaction
        .selectFrom("personalRemoteAccountLink")
        .select(["singletonKey", "state"])
        .where("singletonKey", "=", "opensteer-account")
        .forShare()
        .executeTakeFirst();
      if (request.mode === "connect" && account?.state !== "active") {
        throw new OpensteerError({
          code: "conflict",
          message: "Link an Opensteer Account before enabling Connect",
        });
      }
      const unchanged =
        current.mode === request.mode && current.routeOrigin === request.routeOrigin;
      if (unchanged) return;
      const generation = Number(current.generation) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new OpensteerError({ code: "conflict", message: "Route generation is exhausted" });
      }
      // Revocation and the generation change commit together. A stale cookie
      // cannot outlive this transaction even if connector shutdown is delayed.
      ended = await revokeRemoteSessions(transaction);
      await transaction
        .selectFrom("personalRemotePairingCodes")
        .select("id")
        .orderBy("id", "asc")
        // FOR UPDATE: the following statements delete these rows.
        .forUpdate()
        .execute();
      await transaction.deleteFrom("personalRemotePairingCodes").execute();
      await transaction
        .selectFrom("personalRemoteSessionGrantUses")
        .select("grantId")
        .orderBy("grantId", "asc")
        // FOR UPDATE: the following statement deletes these rows.
        .forUpdate()
        .execute();
      await transaction.deleteFrom("personalRemoteSessionGrantUses").execute();
      await transaction
        .updateTable("personalRemoteAccess")
        .set({
          generation,
          mode: request.mode,
          routeOrigin: request.routeOrigin,
          updatedAt: this.#now(),
        })
        .where("singletonKey", "=", "personal")
        .executeTakeFirstOrThrow();
      reconfigured = true;
    });
    // Their browser and realtime connections end with the logins, after commit.
    this.#identity.announceSessionsEnded(ended);
    // After the commit, never inside it: the computers reached this Deployment
    // over the route this generation replaced, so the new generation has to be
    // durable before their connections are taken away. Nothing is revoked —
    // each of them reconnects when a route exists again, and until then its
    // shell sessions have ended as the disconnection they are.
    if (reconfigured) await this.#disconnectRunners();
    return this.status("machine-local");
  }

  async issuePairingCode(
    caller: AuthenticatedHostSession,
  ): Promise<IssuePersonalPairingCodeResponse> {
    requireLocalOwner(caller.session);
    const now = this.#now();
    const code = PersonalPairingCodeSchema.parse(`osp_${randomBytes(32).toString("base64url")}`);
    const expiresAt = new Date(now.getTime() + pairingCodeLifetimeMilliseconds);
    const result = await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      const state = await transaction
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .forShare()
        .executeTakeFirstOrThrow();
      if (state.mode !== "private" || state.routeOrigin === null) {
        throw new OpensteerError({
          code: "conflict",
          message: "Enable Private network access before creating a pairing code",
        });
      }
      await transaction
        .deleteFrom("personalRemotePairingCodes")
        .where((expression) =>
          expression.or([
            expression("expiresAt", "<=", now),
            expression("issuedBySessionId", "=", caller.session.id),
          ]),
        )
        .execute();
      const pending = await transaction
        .selectFrom("personalRemotePairingCodes")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("consumedAt", "is", null)
        .where("expiresAt", ">", now)
        .executeTakeFirstOrThrow();
      if (Number(pending.count) >= maximumPendingPairingCodes) {
        throw new OpensteerError({
          code: "timeout",
          message: "Too many pairing attempts; try again shortly",
          retryable: true,
        });
      }
      await transaction
        .insertInto("personalRemotePairingCodes")
        .values({
          consumedAt: null,
          createdAt: now,
          credentialHash: digestSecret(code),
          expiresAt,
          generation: state.generation,
          id: `prp_${randomUUID()}`,
          issuedBySessionId: caller.session.id,
        })
        .executeTakeFirstOrThrow();
      return Number(state.generation);
    });
    return IssuePersonalPairingCodeResponseSchema.parse({
      code,
      expiresAt: expiresAt.toISOString(),
      generation: result,
      schemaVersion: 1,
    });
  }

  /**
   * A pairing code has no Account grant behind it, so there is no signed
   * surface to derive delivery from: the operator carried the code to a client
   * only they chose, and that client says which presentation it can hold.
   */
  async exchangePairingCode(
    input: PersonalPairingCodeCredential | unknown,
    context: {
      readonly delivery: PersonalRemoteSessionDelivery;
      readonly routeOrigin: string | undefined;
      readonly userAgent: string | null;
    },
  ): Promise<PersonalRemoteSessionExchange> {
    const request = PersonalPairingCodeCredentialSchema.parse(input);
    const now = this.#now();
    const result = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const state = await transaction
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .forShare()
        .executeTakeFirstOrThrow();
      this.#assertCurrentRoute(state, request.expectedRoute, "private");
      if (state.routeOrigin !== context.routeOrigin) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Pairing must be completed through the signed Personal access route",
        });
      }
      await transaction
        .selectFrom("users")
        .select("id")
        .where("instanceRole", "=", "administrator")
        .where("disabledAt", "is", null)
        .orderBy("id", "asc")
        .forShare()
        .execute();
      const code = await transaction
        .selectFrom("personalRemotePairingCodes")
        .selectAll()
        .where("credentialHash", "=", digestSecret(request.code))
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (
        !code ||
        code.consumedAt !== null ||
        code.expiresAt <= now ||
        Number(code.generation) !== Number(state.generation)
      ) {
        throw invalidPairingCode();
      }
      const consumed = await transaction
        .updateTable("personalRemotePairingCodes")
        .set({ consumedAt: now })
        .where("id", "=", code.id)
        .where("consumedAt", "is", null)
        .executeTakeFirst();
      if (consumed.numUpdatedRows !== 1n) throw invalidPairingCode();
      return this.#identity.issuePersonalRemoteSession(transaction, {
        delivery: context.delivery,
        now,
        routeGeneration: state.generation,
        routeKind: "private",
        routeOrigin: state.routeOrigin!,
        userAgent: context.userAgent,
      });
    });
    return { headers: result.headers, issued: result.data };
  }

  async approveAccountLink(
    caller: AuthenticatedHostSession,
    input: IssuePersonalHostAccountLinkChallengeResponse | unknown,
  ) {
    requireLocalOwner(caller.session);
    const challenge = ApprovePersonalHostAccountLinkRequestSchema.parse(input);
    if (!this.#grantVerifier || challenge.account.issuer !== this.#grantVerifier.issuer) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Account-link issuer does not match this Personal Host",
      });
    }
    if (!constantTimeJsonEqual(challenge.authorityEnvelope.document, this.#authority)) {
      throw new OpensteerError({ code: "forbidden", message: "Account-link authority mismatch" });
    }
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirst();
    // One Personal Host holds one Account link, and this Host enforces that
    // itself rather than trusting the Account to have refused. A row in any
    // state — an activating link included — already owns the single slot, so
    // signing a proof for a different challenge would mint authority for a
    // second link. Re-approving the same challenge stays allowed: the crash
    // safe courier replays exactly that transcript.
    if (linked && linked.challengeId !== challenge.challengeId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Personal Host already holds an Opensteer Account link",
      });
    }
    await this.#database
      .transaction()
      .execute((transaction) => requireMachineLocalSession(transaction, caller));
    const issuedAt = this.#now();
    const expiresAt = new Date(
      Math.min(
        challenge.expiresAt ? Date.parse(challenge.expiresAt) : Number.MAX_SAFE_INTEGER,
        issuedAt.getTime() + 5 * 60_000,
      ),
    );
    return PersonalHostAccountLinkProofEnvelopeSchema.parse(
      signPersonalHostAccountLinkProof(this.#keys, {
        account: challenge.account,
        authority: this.#authority,
        challenge: {
          credentialSha256: createHash("sha256")
            .update(challenge.challengeCredential, "utf8")
            .digest("base64url"),
          id: challenge.challengeId,
        },
        documentVersion: 2,
        expiresAt: expiresAt.toISOString(),
        issuedAt: issuedAt.toISOString(),
        purpose: "opensteer-personal-host-account-link",
      }),
    );
  }

  async consumeAccountLink(
    caller: AuthenticatedHostSession,
    input: unknown,
  ): Promise<PersonalRemoteAccessStatus> {
    requireLocalOwner(caller.session);
    const request = ConsumePersonalHostAccountLinkRequestSchema.parse(input);
    const stored = await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      return transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirst();
    });
    if (stored) {
      assertStoredAccountLinkConsume(stored, request);
      await this.#activateAccountLink(stored);
      return this.status("machine-local");
    }

    if (!this.#grantVerifier) {
      throw new OpensteerError({
        code: "not_found",
        message: "Personal Account linking is unavailable",
      });
    }

    // A rejected completion grant is the one Account-link failure Desktop can
    // recover from on its own, by asking the Account for a fresh grant against
    // the same challenge. It is named so Desktop never has to infer it from a
    // failure that no refresh can fix.
    let claims;
    try {
      claims = PersonalHostAccountLinkCompletionGrantClaimsSchema.parse(
        await this.#grantVerifier.verifyLink(request.completionGrant),
      );
    } catch (error) {
      throw new OpensteerError({
        cause: error,
        code: "forbidden",
        message: "Account-link completion grant is invalid or expired",
        reason: "personal-account-link-grant-expired",
      });
    }
    if (!constantTimeJsonEqual(claims.authority, this.#authority)) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Account-link grant authority mismatch",
      });
    }
    const linked = await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      const existing = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (existing) {
        assertStoredAccountLinkConsume(existing, request);
        if (
          existing.issuer !== claims.account.issuer ||
          existing.subject !== claims.account.subject ||
          existing.challengeId !== claims.challengeId ||
          existing.grantId !== claims.jti
        ) {
          throw new OpensteerError({
            code: "conflict",
            message: "Personal Host is linked to another Account",
          });
        }
        return existing;
      }
      const now = this.#now();
      if (claims.linkGeneration !== request.linkGeneration) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Account-link generation does not match the completion grant",
        });
      }
      await transaction
        .insertInto("personalRemoteAccountLink")
        .values({
          challengeId: claims.challengeId,
          grantId: claims.jti,
          hostCredential: request.hostCredential,
          issuer: claims.account.issuer,
          linkGeneration: request.linkGeneration,
          linkedAt: now,
          singletonKey: "opensteer-account",
          state: "activating",
          subject: claims.account.subject,
          updatedAt: now,
        })
        .executeTakeFirstOrThrow();
      return transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirstOrThrow();
    });
    await this.#activateAccountLink(linked);
    return this.status("machine-local");
  }

  async resumeAccountLink(
    caller: AuthenticatedHostSession,
    input: unknown,
  ): Promise<PersonalRemoteAccessStatus> {
    requireLocalOwner(caller.session);
    ResumePersonalHostAccountLinkRequestSchema.parse(input);
    const stored = await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      return transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirst();
    });
    if (!stored) {
      throw new OpensteerError({
        code: "not_found",
        message: "Personal Account link was not found",
      });
    }
    await this.#activateAccountLink(stored);
    return this.status("machine-local");
  }

  async revokeAccountSessions(caller: AuthenticatedHostSession): Promise<void> {
    requireLocalOwner(caller.session);
    const ended = await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      return await revokeConnectRemoteSessions(transaction);
    });
    this.#identity.announceSessionsEnded(ended);
  }

  async removeAccountLink(caller: AuthenticatedHostSession): Promise<void> {
    requireLocalOwner(caller.session);
    await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      await requireConnectDisabled(transaction);
    });
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirst();
    if (!linked) return;

    // The Account registration must be removed while the Host still owns the
    // credential that authorizes that operation. Any failed or ambiguous
    // response leaves the local link intact so this exact idempotent request
    // can be retried. A definitive not-found is not such a response: the
    // Account has told this Host, under its own credential, that the record it
    // came to remove does not exist. Repeating the call cannot change that
    // answer, and refusing to finish would strand the owner's unlink behind a
    // step that is already complete, so local removal proceeds exactly as on
    // an acknowledged unlink.
    try {
      await this.#accountClient(linked).unlinkPersonalHost({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(linked.challengeId),
        linkGeneration: AccountLinkGenerationSchema.parse(linked.linkGeneration),
      });
    } catch (error) {
      if (!(error instanceof PersonalAccountLinkNotFoundError)) throw error;
    }

    let ended: readonly AuthSessionId[] = [];
    await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await lockRemoteAccess(transaction);
      await requireConnectDisabled(transaction);
      // Link removal is the authority boundary for Account-brokered access.
      // Repeating this deletion is harmless, and keeping it in the same lock
      // and transaction means unlink never depends on a prior Desktop step.
      ended = await revokeConnectRemoteSessions(transaction);
      const removed = await transaction
        .deleteFrom("personalRemoteAccountLink")
        .where("singletonKey", "=", "opensteer-account")
        .where("challengeId", "=", linked.challengeId)
        .where("grantId", "=", linked.grantId)
        .where("hostCredential", "=", linked.hostCredential)
        .where("issuer", "=", linked.issuer)
        .where("linkGeneration", "=", linked.linkGeneration)
        .where("subject", "=", linked.subject)
        .executeTakeFirst();
      if (removed.numDeletedRows === 1n) return;
      const current = await transaction
        .selectFrom("personalRemoteAccountLink")
        .select("singletonKey")
        .where("singletonKey", "=", "opensteer-account")
        .forShare()
        .executeTakeFirst();
      if (current) {
        throw new OpensteerError({
          code: "conflict",
          message: "Personal Account link changed while it was being removed",
        });
      }
    });
    this.#identity.announceSessionsEnded(ended);
  }

  async markHostedOAuthConnectionsForRepair(caller: AuthenticatedHostSession): Promise<void> {
    requireLocalOwner(caller.session);
    await this.#database.transaction().execute(async (transaction) => {
      await requireMachineLocalSession(transaction, caller);
      await transaction
        .updateTable("integrationConnections")
        .set({
          status: "needs-attention",
          statusDetail: "Link Opensteer Account or Use your own OAuth app",
          statusReason: null,
          updatedAt: this.#now(),
        })
        .where(sql<boolean>`application_source ->> 'kind' = 'hosted-oauth'`)
        .where("status", "!=", "revoked")
        .execute();
    });
  }

  /**
   * Whether this Deployment can honour Account-brokered session grants at all.
   * The verifier exists only once the Deployment is linked to an Account
   * issuer, so exchange routes derive their presence from this probe instead
   * of advertising an arm that would always refuse.
   */
  accountSessionExchangeEnabled(): boolean {
    return this.#grantVerifier !== undefined;
  }

  async exchangeAccountSessionGrant(input: {
    readonly clientAddress: string;
    readonly expectedRoute?: PersonalHostAccessRouteEnvelope | undefined;
    readonly grant: string;
    readonly portalOrigin?: string | undefined;
    readonly routeOrigin: string | undefined;
    readonly surface: AccountHostSessionClientSurface;
    readonly userAgent: string | null;
  }): Promise<PersonalRemoteSessionExchange> {
    if (!this.#grantVerifier) {
      throw new OpensteerError({
        code: "not_found",
        message: "Personal Account sessions are unavailable",
      });
    }
    const claims = AccountHostSessionGrantClaimsSchema.parse(
      await this.#grantVerifier.verifySession(input.grant),
    );
    if (
      claims.targetKind !== "personal-connect" ||
      claims.clientSurface !== input.surface ||
      !constantTimeJsonEqual(claims.authority, this.#authority) ||
      (input.surface === "browser"
        ? claims.portalOrigin !== input.portalOrigin
        : claims.portalOrigin !== undefined)
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Account Host session grant purpose or surface is invalid",
      });
    }
    if (
      input.routeOrigin !== claims.route.route.origin ||
      (input.expectedRoute && !constantTimeJsonEqual(claims.route, input.expectedRoute.document))
    ) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Account session exchange must use the signed Connect route",
      });
    }
    const now = this.#now();
    await this.#consumeSessionExchangeRateLimit(
      `account:${claims.account.issuer}:${claims.account.subject}`,
      maximumSessionExchangesPerAccount,
      now,
    );
    await this.#consumeSessionExchangeRateLimit(
      `ip:${input.clientAddress}`,
      maximumSessionExchangesPerIp,
      now,
    );
    const result = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const state = await transaction
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .forShare()
        .executeTakeFirstOrThrow();
      this.#assertCurrentRoute(state, claims.route, "connect");
      const currentRoute = this.#signedRoute(state);
      if (
        state.routeOrigin !== input.routeOrigin ||
        claims.routeGeneration !== Number(state.generation) ||
        claims.personalHostAccessRouteEnvelopeSha256 !==
          personalHostAccessRouteEnvelopeSha256(currentRoute) ||
        (input.expectedRoute && !constantTimeJsonEqual(currentRoute, input.expectedRoute))
      ) {
        throw new OpensteerError({ code: "forbidden", message: "Connect route changed" });
      }
      const linked = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .where("state", "=", "active")
        .forShare()
        .executeTakeFirst();
      if (
        !linked ||
        linked.issuer !== claims.account.issuer ||
        linked.subject !== claims.account.subject
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Account is not linked to this Host",
        });
      }
      await transaction
        .selectFrom("users")
        .select("id")
        .where("instanceRole", "=", "administrator")
        .where("disabledAt", "is", null)
        .orderBy("id", "asc")
        .forShare()
        .execute();
      // Verification has already rejected expired grants. Keep replay
      // tombstones well beyond the two-minute grant lifetime, then bound this
      // table without weakening one-use behavior for any still-valid token.
      await transaction
        .selectFrom("personalRemoteSessionGrantUses")
        .select("grantId")
        .where("consumedAt", "<", new Date(now.getTime() - sessionGrantReplayRetentionMilliseconds))
        .orderBy("grantId", "asc")
        // FOR UPDATE: delete expired replay tombstones in primary-key order.
        .forUpdate()
        .execute();
      await transaction
        .deleteFrom("personalRemoteSessionGrantUses")
        .where("consumedAt", "<", new Date(now.getTime() - sessionGrantReplayRetentionMilliseconds))
        .execute();
      const inserted = await transaction
        .insertInto("personalRemoteSessionGrantUses")
        .values({ consumedAt: now, generation: state.generation, grantId: claims.jti })
        .onConflict((conflict) => conflict.column("grantId").doNothing())
        .executeTakeFirst();
      if (inserted.numInsertedOrUpdatedRows !== 1n) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Account session grant was already used",
        });
      }
      return this.#identity.issuePersonalRemoteSession(transaction, {
        // Delivery follows the surface the Account signed, never anything the
        // caller asked for: the route already refused a request whose declared
        // delivery disagreed with this grant.
        delivery: sessionExchangeDeliveryForClientSurface(claims.clientSurface),
        now,
        routeGeneration: state.generation,
        routeKind: "connect",
        routeOrigin: state.routeOrigin!,
        userAgent: input.userAgent,
      });
    });
    return { headers: result.headers, issued: result.data };
  }

  async #consumeSessionExchangeRateLimit(
    rawKey: string,
    maximum: number,
    now: Date,
  ): Promise<void> {
    const key = `account-host-session:${createHash("sha256").update(rawKey).digest("hex")}`;
    const allowed = await this.#database.transaction().execute(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`.execute(transaction);
      const current = await transaction
        .selectFrom("authRateLimits")
        .selectAll()
        .where("key", "=", key)
        .executeTakeFirst();
      const nowMilliseconds = now.getTime();
      const count =
        current &&
        nowMilliseconds - Number(current.lastRequest) < sessionExchangeRateWindowMilliseconds
          ? current.count + 1
          : 1;
      if (current) {
        await transaction
          .updateTable("authRateLimits")
          .set({ count, lastRequest: nowMilliseconds })
          .where("id", "=", current.id)
          .executeTakeFirstOrThrow();
      } else {
        await transaction
          .insertInto("authRateLimits")
          .values({ id: randomUUID(), key, count, lastRequest: nowMilliseconds })
          .executeTakeFirstOrThrow();
      }
      return count <= maximum;
    });
    if (!allowed) {
      throw new OpensteerError({
        code: "resource_exhausted",
        message: "Account session exchange rate limit exceeded",
      });
    }
  }

  async publishConnectProjection(caller: AuthenticatedHostSession, input: unknown): Promise<void> {
    requireLocalOwner(caller.session);
    const request = PublishPersonalConnectProjectionRequestSchema.parse(input);
    await this.#database
      .transaction()
      .execute((transaction) => requireMachineLocalSession(transaction, caller));
    const status = await this.status("machine-local");
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!linked) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Connect projection requires a linked Opensteer Account",
      });
    }
    if (request.state === "disabled" && status.mode === "connect") {
      throw new OpensteerError({
        code: "conflict",
        message: "Disable the Connect route before publishing Connect as disabled",
      });
    }
    if (request.state !== "disabled" && (status.mode !== "connect" || !status.route)) {
      throw new OpensteerError({ code: "conflict", message: "A signed Connect route is required" });
    }
    if (
      request.state !== "disabled" &&
      !constantTimeJsonEqual(status.route, request.expectedAccessRoute)
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "The Personal Connect route changed before it could be published",
      });
    }
    const client = this.#accountClient(linked);
    await client.publishPersonalConnect({
      accessRoute: request.state === "disabled" ? null : status.route,
      generation: status.generation,
      state: request.state,
    });
  }

  /**
   * Runtime-internal: the Host re-asserts its signed identity to the Account on
   * every start, so there is no session to authorize and nothing to require
   * beyond an active link. An unlinked Host has nothing to publish, and it
   * needs no later attempt either: activation seeds the Account's copy from
   * this same signed document, so the next start is the next refresh.
   */
  async publishAccountAuthority(): Promise<"published" | "unlinked"> {
    if (!this.#grantVerifier) return "unlinked";
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!linked) return "unlinked";
    await this.#accountClient(linked).publishAuthority();
    return "published";
  }

  async revokeConnectResource(
    caller: AuthenticatedHostSession,
    input: RevokeConnectRequest | unknown,
  ): Promise<RevokeConnectResponse> {
    requireLocalOwner(caller.session);
    const request = RevokeConnectRequestSchema.parse(input);
    if (request.hostInstanceId !== this.#authority.hostInstanceId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Personal Host authority changed before Connect could be revoked",
      });
    }
    await this.#database
      .transaction()
      .execute((transaction) => requireMachineLocalSession(transaction, caller));
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!linked) {
      throw new OpensteerError({
        code: "conflict",
        message: "Link an Opensteer Account before revoking Connect",
      });
    }
    return this.#accountClient(linked).revokePersonalConnect(request);
  }

  #accountClient(link: { readonly issuer: string; readonly hostCredential: string }) {
    if (!this.#grantVerifier || link.issuer !== this.#grantVerifier.issuer) {
      throw new OpensteerError({
        code: "not_found",
        message: "Opensteer Account isn’t available for this deployment.",
      });
    }
    return new AccountDirectoryClient({
      authorityEnvelope: signHostDiscovery(this.#keys, this.#authority),
      controlApiOrigin: new URL(link.issuer),
      deployment: {
        activeHostInstanceId: this.#authority.hostInstanceId,
        lifecycle: "active",
      },
      fetch: this.#fetch,
      hostCredential: link.hostCredential,
    });
  }

  async #activateAccountLink(link: {
    readonly challengeId: string;
    readonly hostCredential: string;
    readonly issuer: string;
    readonly linkGeneration: string;
  }): Promise<void> {
    try {
      const client = this.#accountClient(link);
      await client.activatePersonalAccountLink({
        challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(link.challengeId),
        linkGeneration: AccountLinkGenerationSchema.parse(link.linkGeneration),
      });
      // Activation seeds the Account's copy from the challenge, which was signed
      // when the link was requested. The Host that exists now is the one other
      // devices must verify, so the link is not active until the current
      // document is published; both calls are idempotent, so a lost response
      // simply replays them.
      await client.publishAuthority();
      await this.#database
        .updateTable("personalRemoteAccountLink")
        .set({ state: "active", updatedAt: this.#now() })
        .where("singletonKey", "=", "opensteer-account")
        .where("challengeId", "=", link.challengeId)
        .where("hostCredential", "=", link.hostCredential)
        .where("linkGeneration", "=", link.linkGeneration)
        .executeTakeFirstOrThrow();
    } catch (error) {
      // Three central answers, three different things the owner must do, so
      // they stay three errors rather than one prose message the Desktop would
      // have to guess at. None of them is retryable from here: the reservation
      // this Host holds a credential for is gone or unusable.
      if (error instanceof PersonalAccountLinkActivationExpiredError) {
        throw new OpensteerError({
          cause: error,
          code: "conflict",
          message: "The Opensteer Account link expired before it was activated",
          reason: "personal-account-link-reservation-expired",
        });
      }
      if (error instanceof PersonalAccountLinkCancelledError) {
        throw new OpensteerError({
          cause: error,
          code: "conflict",
          message: "The Opensteer Account link was cancelled",
          reason: "personal-account-link-cancelled",
        });
      }
      if (error instanceof PersonalAccountLinkNotFoundError) {
        throw new OpensteerError({
          cause: error,
          code: "not_found",
          message: "Opensteer Account holds no link for this Personal Host",
          reason: "personal-account-link-not-found",
        });
      }
      throw error;
    }
  }

  accessRoute(): Promise<PersonalHostAccessRouteEnvelope | null> {
    return this.#database
      .selectFrom("personalRemoteAccess")
      .selectAll()
      .where("singletonKey", "=", "personal")
      .executeTakeFirstOrThrow()
      .then((state) => (state.mode === "off" ? null : this.#signedRoute(state)));
  }

  async authenticateRemoteSession(
    headers: Readonly<Record<string, string | readonly string[] | number | undefined>>,
    options: { readonly mutation?: boolean } = {},
  ): Promise<AuthenticatedSession | null> {
    return this.#identity.authenticatePersonalRemoteSession(toWebHeaders(headers), options);
  }

  async authenticateRemoteCredential(credential: string): Promise<AuthenticatedSession | null> {
    return this.#identity.authenticatePersonalRemoteCredential(credential);
  }

  #signedRoute(state: {
    readonly generation: number | string;
    readonly mode: "off" | "connect" | "private";
    readonly routeOrigin: string | null;
  }): PersonalHostAccessRouteEnvelope {
    if (state.mode === "off" || state.routeOrigin === null) {
      throw new Error("An inactive Personal route cannot be signed");
    }
    return signPersonalHostAccessRoute(this.#keys, {
      authority: this.#authority,
      documentVersion: 2,
      purpose: "opensteer-personal-access-route",
      route: {
        generation: Number(state.generation),
        kind: state.mode,
        origin: state.routeOrigin,
      },
    });
  }

  #assertCurrentRoute(
    state: {
      readonly generation: number | string;
      readonly mode: "off" | "connect" | "private";
      readonly routeOrigin: string | null;
    },
    expected: PersonalHostAccessRouteDocument,
    kind: "connect" | "private",
  ): void {
    if (state.mode !== kind || state.routeOrigin === null) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Personal access route is stale or invalid",
      });
    }
    const current = this.#signedRoute(state).document;
    const parsed = PersonalHostAccessRouteDocumentSchema.parse(expected);
    if (!constantTimeJsonEqual(current, parsed)) {
      throw new OpensteerError({
        code: "forbidden",
        message: "Personal access route is stale or invalid",
      });
    }
  }
}

function assertStoredAccountLinkConsume(
  stored: { readonly hostCredential: string; readonly linkGeneration: string },
  request: { readonly hostCredential: string; readonly linkGeneration: string },
): void {
  if (
    stored.hostCredential !== request.hostCredential ||
    stored.linkGeneration !== request.linkGeneration
  ) {
    throw new OpensteerError({
      code: "conflict",
      message: "Personal Host is linked to another Account",
    });
  }
}

async function lockRemoteAccess(transaction: Transaction<DatabaseSchema>): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended('personal-remote-access', 0))`.execute(
    transaction,
  );
}

/** The logins it deleted, to be announced once the transaction commits. */
async function revokeRemoteSessions(
  transaction: Transaction<DatabaseSchema>,
): Promise<readonly AuthSessionId[]> {
  await transaction
    .selectFrom("authSessions")
    .select("id")
    .where("id", "in", transaction.selectFrom("personalRemoteSessions").select("authSessionId"))

    .orderBy("id", "asc")
    // FOR UPDATE: fence the exact ordered deletion set.
    .forUpdate()
    .execute();
  const rows = await transaction
    .deleteFrom("authSessions")
    .where("id", "in", transaction.selectFrom("personalRemoteSessions").select("authSessionId"))
    .returning("id")
    .execute();
  return rows.map((row) => row.id);
}

async function revokeConnectRemoteSessions(
  transaction: Transaction<DatabaseSchema>,
): Promise<readonly AuthSessionId[]> {
  await transaction
    .selectFrom("authSessions")
    .select("id")
    .where(
      "id",
      "in",
      transaction
        .selectFrom("personalRemoteSessions")
        .select("authSessionId")
        .where("routeKind", "=", "connect"),
    )

    .orderBy("id", "asc")
    // FOR UPDATE: fence the exact ordered deletion set.
    .forUpdate()
    .execute();
  const rows = await transaction
    .deleteFrom("authSessions")
    .where(
      "id",
      "in",
      transaction
        .selectFrom("personalRemoteSessions")
        .select("authSessionId")
        .where("routeKind", "=", "connect"),
    )
    .returning("id")
    .execute();
  return rows.map((row) => row.id);
}

async function requireConnectDisabled(transaction: Transaction<DatabaseSchema>): Promise<void> {
  const state = await transaction
    .selectFrom("personalRemoteAccess")
    .select("mode")
    .where("singletonKey", "=", "personal")
    .forShare()
    .executeTakeFirstOrThrow();
  if (state.mode === "connect") {
    throw new OpensteerError({
      code: "conflict",
      message: "Disable the Connect route before unlinking the Opensteer Account",
    });
  }
}

/**
 * "At the keyboard" is two facts, both positive. The marker says this session
 * was established by spending the process-launch capability only the
 * application on this computer holds. The credential says the caller is that
 * session's own browser cookie: a native access token names the browser
 * session that authorized it, so a marker alone would travel off the computer
 * with the token.
 */
async function machineLocalSession(
  transaction: Transaction<DatabaseSchema>,
  caller: AuthenticatedHostSession,
): Promise<boolean> {
  if (caller.credentialKind !== "browser-cookie") return false;
  const marker = await transaction
    .selectFrom("machineLocalSessions")
    .select("authSessionId")
    .where("authSessionId", "=", caller.session.id)
    .forShare()
    .executeTakeFirst();
  return marker !== undefined;
}

async function requireMachineLocalSession(
  transaction: Transaction<DatabaseSchema>,
  caller: AuthenticatedHostSession,
): Promise<void> {
  if (await machineLocalSession(transaction, caller)) return;
  throw new OpensteerError({
    code: "forbidden",
    message: "Remote access settings can be changed only on the Personal computer",
  });
}

function requireLocalOwner(session: AuthenticatedSession): void {
  if (session.user.instanceRole !== "administrator") {
    throw new OpensteerError({ code: "forbidden", message: "Personal owner access required" });
  }
}

function invalidPairingCode(): OpensteerError {
  return new OpensteerError({ code: "forbidden", message: "Pairing code is invalid or expired" });
}

function constantTimeJsonEqual(left: unknown, right: unknown): boolean {
  const a = Buffer.from(JSON.stringify(left));
  const b = Buffer.from(JSON.stringify(right));
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function toWebHeaders(
  input: Readonly<Record<string, string | readonly string[] | number | undefined>>,
): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, String(value));
    }
  }
  return headers;
}
