import {
  generateOAuthBrokerEphemeralKeyPair,
  openOAuthBrokerPayload,
} from "@opensteer/integration-auth";
import {
  PersonalRemoteAdministration,
  requirePersonalAdministrator,
} from "./personal-remote-administration.js";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { digestSecret } from "@opensteer/shared/secretDigest";
import {
  OpensteerError,
  type AuthenticatedSession,
  type AuthSessionId,
  type PersonalRemoteSessionDelivery,
} from "@opensteer/core";
import { requestSettlementActor, type DatabaseSchema } from "@opensteer/database";
import {
  AccountHostSessionGrantClaimsSchema,
  AccountLinkGenerationSchema,
  type AccountHostSessionClientSurface,
  PersonalHostAccountLinkCompletionGrantClaimsSchema,
  PersonalHostAccountLinkCompletionPayloadSchema,
  personalHostAccountLinkCompletionContext,
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
  sessionExchangeDeliveryForClientSurface,
  ResumePersonalHostAccountLinkRequestSchema,
  type ConfigurePersonalRemoteAccessRequest,
  type IssuePersonalPairingCodeResponse,
  type PersonalPairingCodeCredential,
  type PersonalRemoteAccessStatus,
} from "@opensteer/protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
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
 * What an exchange arm hands back: the response headers the delivery needs —
 * a `Set-Cookie` for the cookie family, none for the header family — and the
 * issued session itself, which carries the credential only when there is
 * nowhere else to put it.
 */
export interface PersonalRemoteSessionExchange {
  readonly headers: Headers;
  readonly issued: IssuedPersonalRemoteSession;
}

type AccountLink = Selectable<DatabaseSchema["personalRemoteAccountLink"]>;
type AccountOperation = NonNullable<AccountLink["accountOperation"]>;
type AccountOperationInput = AccountOperation extends infer Operation
  ? Operation extends AccountOperation
    ? Omit<Operation, "id">
    : never
  : never;

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
  readonly administration: PersonalRemoteAdministration;
  readonly #authority: PersonalHostAccessAuthority;
  readonly #database: Kysely<DatabaseSchema>;
  readonly #identity: IdentityService;
  readonly #keys: Pick<HostKeyPair, "privateKey" | "publicKey">;
  readonly #grantVerifier: PersonalAccountGrantVerifier | undefined;
  readonly #now: () => Date;
  readonly #fetch: typeof globalThis.fetch;
  readonly #accountOperations = new Map<string, Promise<RevokeConnectResponse | undefined>>();
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
    this.administration = new PersonalRemoteAdministration({
      authorityEnvelope: signHostDiscovery(options.keys, options.authority),
      database: options.database,
      readAccess: () => this.status(),
      resumeAccountOperation: (intent) => this.#resumeAccountOperation(intent.action === "unlink"),
      accountIssuer: options.grantVerifier?.issuer ?? null,
    });
    this.#authority = PersonalHostAccessAuthoritySchema.parse(options.authority);
    this.#database = options.database;
    this.#identity = options.identity;
    this.#keys = options.keys;
    this.#grantVerifier = options.grantVerifier;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
    this.#disconnectRunners = options.disconnectRunners ?? (async () => undefined);
  }

  status(): Promise<PersonalRemoteAccessStatus> {
    return this.#readStatus(this.#database);
  }

  async #readStatus(database: Kysely<DatabaseSchema>): Promise<PersonalRemoteAccessStatus> {
    const state = await database
      .selectFrom("personalRemoteAccess")
      .leftJoin("personalRemoteAccountLink", (join) =>
        join.on("personalRemoteAccountLink.singletonKey", "=", "opensteer-account"),
      )
      .selectAll("personalRemoteAccess")
      .select([
        "personalRemoteAccountLink.issuer as accountIssuer",
        "personalRemoteAccountLink.linkGeneration as accountGeneration",
        "personalRemoteAccountLink.state as accountState",
        "personalRemoteAccountLink.subject as accountSubject",
      ])
      .where("personalRemoteAccess.singletonKey", "=", "personal")
      .executeTakeFirstOrThrow();
    const shared = {
      generation: Number(state.generation),
      mode: state.mode,
      route: state.mode === "off" ? null : this.#signedRoute(state),
      schemaVersion: 2,
    } as const;
    return PersonalRemoteAccessStatusSchema.parse({
      accountLink: state.accountIssuer
        ? {
            generation: state.accountGeneration,
            issuer: state.accountIssuer,
            state: state.accountState,
            subject: state.accountSubject,
          }
        : null,
      ...shared,
    });
  }

  async configure(
    caller: { readonly session: AuthenticatedSession },
    input: ConfigurePersonalRemoteAccessRequest | unknown,
    afterResponse?: (effect: () => void) => void,
  ): Promise<PersonalRemoteAccessStatus> {
    requirePersonalAdministrator(caller.session);
    const request = ConfigurePersonalRemoteAccessRequestSchema.parse(input);
    let reconfigured = false;
    let ended: readonly AuthSessionId[] = [];
    await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const current = await transaction
        .selectFrom("personalRemoteAccess")
        .selectAll()
        .where("singletonKey", "=", "personal")
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const account = await transaction
        .selectFrom("personalRemoteAccountLink")
        .select(["singletonKey", "state", "accountOperation"])
        .where("singletonKey", "=", "opensteer-account")
        .forShare()
        .executeTakeFirst();
      if (
        request.mode === "connect" &&
        (account?.state !== "active" || account.accountOperation?.kind === "unlink")
      ) {
        throw new OpensteerError({
          code: "conflict",
          message: "Link an Opensteer Account before enabling Connect",
        });
      }
      const unchanged =
        current.mode === request.mode && current.routeOrigin === request.routeOrigin;
      if (unchanged) {
        await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
        return;
      }
      const generation = Number(current.generation) + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new OpensteerError({ code: "conflict", message: "Route generation is exhausted" });
      }
      // Revocation and the generation change commit together. A stale cookie
      // cannot outlive this transaction even if connector shutdown is delayed.
      ended = await revokeRemoteSessions(transaction, caller.session);
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
    const announce = () => this.#identity.announceSessionsEnded(ended);
    if (afterResponse) afterResponse(announce);
    else announce();
    // After the commit, never inside it: the computers reached this Deployment
    // over the route this generation replaced, so the new generation has to be
    // durable before their connections are taken away. Nothing is revoked —
    // each of them reconnects when a route exists again, and until then its
    // shell sessions have ended as the disconnection they are.
    if (reconfigured) {
      this.administration.changed();
      await this.#disconnectRunners();
    }
    return this.status();
  }

  async issuePairingCode(caller: {
    readonly session: AuthenticatedSession;
  }): Promise<IssuePersonalPairingCodeResponse> {
    requirePersonalAdministrator(caller.session);
    const now = this.#now();
    const code = PersonalPairingCodeSchema.parse(`osp_${randomBytes(32).toString("base64url")}`);
    const expiresAt = new Date(now.getTime() + pairingCodeLifetimeMilliseconds);
    const result = await this.#database.transaction().execute(async (transaction) => {
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
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
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
    caller: { readonly session: AuthenticatedSession },
    input: IssuePersonalHostAccountLinkChallengeResponse | unknown,
  ) {
    requirePersonalAdministrator(caller.session);
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
    const issuedAt = this.#now();
    await this.purgeExpiredAccountLinkKeys();
    const completionKeys = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const existing = await transaction
        .selectFrom("personalAccountLinkKeys")
        .selectAll()
        .where("challengeId", "=", challenge.challengeId)
        .executeTakeFirst();
      const linked = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .executeTakeFirst();
      if (linked) {
        throw new OpensteerError({
          code: "conflict",
          message: "Personal Host already holds an Opensteer Account link",
        });
      }
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
      if (existing) return existing;
      const keys = generateOAuthBrokerEphemeralKeyPair();
      return transaction
        .insertInto("personalAccountLinkKeys")
        .values({
          challengeId: challenge.challengeId,
          ...keys,
          // The Account retains an unactivated reservation for one day, including crash recovery.
          expiresAt: new Date(
            Math.min(Date.parse(challenge.expiresAt), issuedAt.getTime() + 5 * 60_000) +
              24 * 60 * 60_000,
          ),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
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
        documentVersion: 3,
        completionPublicKey: completionKeys.publicKey,
        expiresAt: expiresAt.toISOString(),
        issuedAt: issuedAt.toISOString(),
        purpose: "opensteer-personal-host-account-link",
      }),
    );
  }

  async consumeAccountLink(
    caller: { readonly session: AuthenticatedSession },
    input: unknown,
  ): Promise<PersonalRemoteAccessStatus> {
    requirePersonalAdministrator(caller.session);
    const request = ConsumePersonalHostAccountLinkRequestSchema.parse(input);
    const grantVerifier = this.#grantVerifier;
    if (!grantVerifier)
      throw new OpensteerError({
        code: "not_found",
        message: "Personal Account linking is unavailable",
      });
    await this.purgeExpiredAccountLinkKeys();
    // Reading and decrypting does not consume the key. JWKS can require a network
    // fetch, so only the later fenced transaction may consume this exact key.
    const existing = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirst();
    const keys = existing
      ? undefined
      : await this.#database
          .selectFrom("personalAccountLinkKeys")
          .selectAll()
          .where("challengeId", "=", request.challengeId)
          .executeTakeFirst();
    let completion:
      | {
          payload: import("@opensteer/control-plane-protocol").PersonalHostAccountLinkCompletionPayload;
          claims: import("@opensteer/control-plane-protocol").PersonalHostAccountLinkCompletionGrantClaims;
        }
      | undefined;
    if (!existing) {
      if (!keys || keys.expiresAt <= this.#now()) throw expiredAccountCompletion();
      let payload;
      try {
        payload = PersonalHostAccountLinkCompletionPayloadSchema.parse(
          openOAuthBrokerPayload(
            request.sealedCompletion,
            keys.privateKey,
            personalHostAccountLinkCompletionContext(
              this.#authority,
              request.challengeId,
              request.linkGeneration,
            ),
          ),
        );
      } catch {
        throw new OpensteerError({
          code: "forbidden",
          message: "Account-link sealed completion is invalid",
        });
      }
      let claims;
      try {
        claims = PersonalHostAccountLinkCompletionGrantClaimsSchema.parse(
          await grantVerifier.verifyLink(payload.completionGrant),
        );
      } catch {
        throw new OpensteerError({
          code: "forbidden",
          message: "Account-link completion grant is invalid or expired",
          reason: "personal-account-link-grant-expired",
        });
      }
      if (
        !constantTimeJsonEqual(claims.authority, this.#authority) ||
        claims.challengeId !== request.challengeId ||
        claims.linkGeneration !== request.linkGeneration ||
        payload.linkGeneration !== request.linkGeneration ||
        payload.resultExpiresAt !== request.resultExpiresAt ||
        Date.parse(payload.resultExpiresAt) <= this.#now().getTime()
      ) {
        throw new OpensteerError({
          code: "forbidden",
          message: "Account-link completion binding is invalid or expired",
        });
      }
      completion = { payload, claims };
    }
    const linked = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const current = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      const pendingKeys = current
        ? []
        : await transaction
            .selectFrom("personalAccountLinkKeys")
            .selectAll()
            .orderBy("challengeId", "asc")
            .forUpdate()
            .execute();
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
      if (current) {
        assertStoredAccountLinkConsume(current, request);
        if (current.state === "active") return current;
        return this.#admitAccountOperation(transaction, current, { kind: "activate" });
      }
      const key = pendingKeys.find((pending) => pending.challengeId === request.challengeId);
      if (
        !completion ||
        !keys ||
        !key ||
        key.privateKey !== keys.privateKey ||
        key.publicKey !== keys.publicKey ||
        key.expiresAt <= this.#now()
      )
        throw expiredAccountCompletion();
      if (
        Date.parse(completion.payload.resultExpiresAt) <= this.#now().getTime() ||
        completion.claims.exp * 1000 <= this.#now().getTime()
      )
        throw expiredAccountCompletion();
      await transaction.deleteFrom("personalAccountLinkKeys").execute();
      return transaction
        .insertInto("personalRemoteAccountLink")
        .values({
          accountOperation: { id: randomUUID(), kind: "activate" },
          challengeId: completion.claims.challengeId,
          grantId: completion.claims.jti,
          hostCredential: completion.payload.hostCredential,
          issuer: completion.claims.account.issuer,
          linkGeneration: request.linkGeneration,
          linkedAt: this.#now(),
          singletonKey: "opensteer-account",
          state: "activating",
          subject: completion.claims.account.subject,
          updatedAt: this.#now(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
    this.administration.changed();
    if (linked.accountOperation?.kind === "activate") await this.#executeAccountOperation(linked);
    return this.status();
  }

  async resumeAccountLink(
    caller: { readonly session: AuthenticatedSession },
    input: unknown,
  ): Promise<PersonalRemoteAccessStatus> {
    requirePersonalAdministrator(caller.session);
    ResumePersonalHostAccountLinkRequestSchema.parse(input);
    const linked = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const stored = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
      if (!stored)
        throw new OpensteerError({
          code: "not_found",
          message: "Personal Account link was not found",
        });
      return this.#admitAccountOperation(transaction, stored, { kind: "activate" });
    });
    await this.#executeAccountOperation(linked);
    return this.status();
  }

  async revokeAccountSessions(
    caller: { readonly session: AuthenticatedSession },
    afterResponse?: (effect: () => void) => void,
  ): Promise<void> {
    requirePersonalAdministrator(caller.session);
    const ended = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      return await revokeRemoteSessions(transaction, caller.session, { routeKind: "connect" });
    });
    const announce = () => this.#identity.announceSessionsEnded(ended);
    if (afterResponse) afterResponse(announce);
    else announce();
  }

  async removeAccountLink(
    caller: { readonly session: AuthenticatedSession },
    afterResponse?: (effect: () => void) => void,
  ): Promise<void> {
    requirePersonalAdministrator(caller.session);
    const linked = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      await requireConnectDisabled(transaction);
      await transaction
        .selectFrom("personalAccountLinkKeys")
        .select("challengeId")
        .orderBy("challengeId", "asc")
        .forUpdate()
        .execute();
      const stored = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .forNoKeyUpdate()
        .executeTakeFirst();
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
      await transaction.deleteFrom("personalAccountLinkKeys").execute();
      return stored
        ? this.#admitAccountOperation(transaction, stored, { kind: "unlink" })
        : undefined;
    });
    if (linked) await this.#executeAccountOperation(linked, afterResponse);
  }

  async markHostedOAuthConnectionsForRepair(caller: {
    readonly session: AuthenticatedSession;
  }): Promise<void> {
    requirePersonalAdministrator(caller.session);
    await this.#database.transaction().execute(async (transaction) => {
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
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
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

  async publishConnectProjection(
    caller: { readonly session: AuthenticatedSession },
    input: unknown,
  ): Promise<void> {
    requirePersonalAdministrator(caller.session);
    const request = PublishPersonalConnectProjectionRequestSchema.parse(input);
    const admitted = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const status = await this.#readStatus(transaction);
      const linked = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .where("state", "=", "active")
        .forNoKeyUpdate()
        .executeTakeFirst();
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
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
        throw new OpensteerError({
          code: "conflict",
          message: "A signed Connect route is required",
        });
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
      return this.#admitAccountOperation(transaction, linked, {
        kind: "projection",
        projection: {
          accessRoute: request.state === "disabled" ? null : status.route,
          generation: status.generation,
          state: request.state,
        },
      });
    });
    await this.#executeAccountOperation(admitted);
  }

  async purgeExpiredAccountLinkKeys(): Promise<void> {
    await this.#database
      .deleteFrom("personalAccountLinkKeys")
      .where("expiresAt", "<=", this.#now())
      .execute();
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
    await this.#resumeAccountOperation();
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirst();
    if (!linked || linked.state !== "active") return "unlinked";
    await this.#accountClient(linked).publishAuthority();
    return "published";
  }

  async revokeConnectResource(
    caller: { readonly session: AuthenticatedSession },
    input: RevokeConnectRequest | unknown,
  ): Promise<RevokeConnectResponse> {
    requirePersonalAdministrator(caller.session);
    const request = RevokeConnectRequestSchema.parse(input);
    if (request.hostInstanceId !== this.#authority.hostInstanceId) {
      throw new OpensteerError({
        code: "conflict",
        message: "Personal Host authority changed before Connect could be revoked",
      });
    }
    const admitted = await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      const linked = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .where("state", "=", "active")
        .forNoKeyUpdate()
        .executeTakeFirst();
      await requestSettlementActor(transaction, caller.session.user.id, caller.session.id);
      if (!linked) {
        throw new OpensteerError({
          code: "conflict",
          message: "Link an Opensteer Account before revoking Connect",
        });
      }
      return this.#admitAccountOperation(transaction, linked, { kind: "revoke", request });
    });
    const result = await this.#executeAccountOperation(admitted);
    if (!result) throw new Error("Connect revocation did not return an acknowledgement");
    return result;
  }

  async connectCredentialForExecutor(
    input:
      | import("@opensteer/control-plane-protocol").ProvisionConnectRequest
      | import("@opensteer/control-plane-protocol").RotateConnectCredentialRequest,
    rotate: boolean,
  ) {
    const link = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .where("state", "=", "active")
      .executeTakeFirst();
    if (!link || link.accountOperation?.kind === "unlink")
      throw new OpensteerError({
        code: "conflict",
        message: "Link an Opensteer Account before enabling Connect",
      });
    return this.#accountClient(link).connectCredential(input, rotate);
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

  async #admitAccountOperation(
    transaction: Transaction<DatabaseSchema>,
    link: AccountLink,
    input: AccountOperationInput,
  ): Promise<AccountLink> {
    // The caller has acquired the access/link locks and the shared session
    // fence. Commit the exact external step before releasing that authority.
    if (link.accountOperation) {
      const { id: _id, ...pending } = link.accountOperation;
      if (isDeepStrictEqual(pending, input)) return link;
      // Unlink may cancel an activation whose response was lost. Its finalizer
      // cannot resurrect the link once this step has replaced it.
      if (input.kind !== "unlink" || pending.kind !== "activate")
        throw new OpensteerError({
          code: "conflict",
          message: "An Account change is awaiting acknowledgement. Use Recover to resume it.",
        });
    }
    const accountOperation: AccountOperation = { ...input, id: randomUUID() };
    await transaction
      .updateTable("personalRemoteAccountLink")
      .set({ accountOperation, updatedAt: this.#now() })
      .where("singletonKey", "=", "opensteer-account")
      .where("linkGeneration", "=", link.linkGeneration)
      .executeTakeFirstOrThrow();
    return { ...link, accountOperation };
  }

  async #resumeAccountOperation(cancellingActivation = false): Promise<void> {
    const linked = await this.#database
      .selectFrom("personalRemoteAccountLink")
      .selectAll()
      .where("singletonKey", "=", "opensteer-account")
      .executeTakeFirst();
    if (cancellingActivation && linked?.accountOperation?.kind === "activate") return;
    if (linked?.accountOperation) await this.#executeAccountOperation(linked);
  }

  async #executeAccountOperation(
    link: AccountLink,
    afterResponse?: (effect: () => void) => void,
  ): Promise<RevokeConnectResponse | undefined> {
    if (!link.accountOperation) return;
    const id = link.accountOperation.id;
    const running = this.#accountOperations.get(id);
    if (running) return running;
    const execution = this.#runAccountOperation(link, afterResponse);
    this.#accountOperations.set(id, execution);
    try {
      return await execution;
    } finally {
      this.#accountOperations.delete(id);
    }
  }

  async #runAccountOperation(
    link: AccountLink,
    afterResponse?: (effect: () => void) => void,
  ): Promise<RevokeConnectResponse | undefined> {
    const operation = link.accountOperation;
    if (!operation) return;
    const client = this.#accountClient(link);
    let result: RevokeConnectResponse | undefined;
    if (operation.kind === "activate") await this.#activateAccountLink(link);
    else if (operation.kind === "unlink") {
      // Keep the only credential capable of retrying an ambiguous unlink until
      // Account acknowledgement. A definitive not-found is acknowledgement too.
      try {
        await client.unlinkPersonalHost({
          challengeId: PersonalHostAccountLinkChallengeIdSchema.parse(link.challengeId),
          linkGeneration: AccountLinkGenerationSchema.parse(link.linkGeneration),
        });
      } catch (error) {
        if (!(error instanceof PersonalAccountLinkNotFoundError)) throw error;
      }
    } else if (operation.kind === "projection")
      await client.publishPersonalConnect(operation.projection);
    else
      result = await client.revokePersonalConnect(
        RevokeConnectRequestSchema.parse(operation.request),
      );

    let ended: readonly AuthSessionId[] = [];
    let staleProjection = false;
    await this.#database.transaction().execute(async (transaction) => {
      await lockRemoteAccess(transaction);
      if (operation.kind === "unlink") await requireConnectDisabled(transaction);
      if (operation.kind === "projection") {
        const status = await this.#readStatus(transaction);
        staleProjection = status.generation !== operation.projection.generation;
      }
      const current = await transaction
        .selectFrom("personalRemoteAccountLink")
        .selectAll()
        .where("singletonKey", "=", "opensteer-account")
        .forUpdate()
        .executeTakeFirst();
      if (!current && operation.kind === "unlink") return;
      if (
        !current ||
        current.challengeId !== link.challengeId ||
        current.linkGeneration !== link.linkGeneration ||
        current.grantId !== link.grantId ||
        current.hostCredential !== link.hostCredential ||
        current.issuer !== link.issuer ||
        current.subject !== link.subject
      )
        throw accountLinkChanged();
      if (!current.accountOperation) return; // Another replay finalized this same step.
      if (current.accountOperation.id !== operation.id) throw accountLinkChanged();
      if (operation.kind === "unlink") {
        ended = await revokeRemoteSessions(transaction, undefined, { routeKind: "connect" });
        await transaction
          .deleteFrom("personalRemoteAccountLink")
          .where("singletonKey", "=", "opensteer-account")
          .where("linkGeneration", "=", link.linkGeneration)
          .executeTakeFirst();
      } else {
        await transaction
          .updateTable("personalRemoteAccountLink")
          .set({
            accountOperation: null,
            ...(operation.kind === "activate" ? { state: "active" as const } : {}),
            updatedAt: this.#now(),
          })
          .where("singletonKey", "=", "opensteer-account")
          .where("linkGeneration", "=", link.linkGeneration)
          .executeTakeFirstOrThrow();
      }
    });
    this.administration.changed();
    if (ended.length) {
      const announce = () => this.#identity.announceSessionsEnded(ended);
      if (afterResponse) afterResponse(announce);
      else announce();
    }
    if (staleProjection)
      throw new OpensteerError({
        code: "conflict",
        message: "The Personal Connect route changed while it was being published",
      });
    return result;
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

function expiredAccountCompletion(): OpensteerError {
  return new OpensteerError({
    code: "forbidden",
    message:
      "Account-link completion has expired or was already consumed. Start Account linking again.",
  });
}

function accountLinkChanged(): OpensteerError {
  return new OpensteerError({
    code: "conflict",
    message: "Personal Account link changed while its Account operation was running",
  });
}

function assertStoredAccountLinkConsume(
  stored: { readonly challengeId: string; readonly linkGeneration: string },
  request: { readonly challengeId: string; readonly linkGeneration: string },
): void {
  if (
    stored.challengeId !== request.challengeId ||
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
  session: AuthenticatedSession | undefined,
  options: {
    readonly routeKind?: "connect";
  } = {},
): Promise<readonly AuthSessionId[]> {
  let remoteSessions = transaction.selectFrom("personalRemoteSessions").select("authSessionId");
  if (options.routeKind) remoteSessions = remoteSessions.where("routeKind", "=", options.routeKind);
  await transaction
    .selectFrom("authSessions")
    .select("id")
    .where((expression) =>
      expression.or([
        ...(session ? [expression("id", "=", session.id)] : []),
        expression("id", "in", remoteSessions),
      ]),
    )
    .orderBy("id", "asc")
    // FOR UPDATE: reserve the deletion set and caller together before validating the caller.
    .forUpdate()
    .execute();
  if (session) await requestSettlementActor(transaction, session.user.id, session.id);
  const rows = await transaction
    .deleteFrom("authSessions")
    .where("id", "in", remoteSessions)
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
