import { TeamRuntimeOwner } from "../team/team-runtime-owner.js";
import {
  NativeTeamEntry,
  assertTeamEntryOutcome,
  verifyTeamEndpoint,
} from "../team/native-team-entry.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64Url, decodeBase64Url } from "@opensteer/shared/base64url";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import {
  IdentityEmailSchema,
  bareServiceOrigin,
  isSecureOrLoopbackOrigin,
  opensteerAccountDeleteOAuthScopes,
  opensteerAccountOAuthScopes,
  opensteerHostOAuthScopes,
  teamInviteSignInUrl,
  type DeploymentId,
  type TeamInviteSecret,
} from "@opensteer/core";
import {
  ControlPlaneAccountIdSchema,
  IssueTeamIdentityGrantResponseSchema,
  accountTeamIdentityGrantsPath,
  type ControlPlaneAccountId,
  type IssueTeamIdentityGrantRequest,
  type IssueTeamIdentityGrantResponse,
} from "@opensteer/control-plane-protocol";
import {
  HostApiErrorSchema,
  TeamEntryRefusalReasonSchema,
  TeamSessionExchangeRequestSchema,
  TeamSessionExchangeResponseSchema,
  teamSessionExchangePath,
  type TeamEntryRefusalReason,
  type TeamSessionExchangeRequest,
  type TeamSessionExchangeResponse,
} from "@opensteer/protocol";
import {
  hostAuthorityIdentityMatches,
  hostKeyFingerprint,
  teamApiVersion,
  teamApiVersionHeader,
  teamOAuthVersionParameter,
} from "@opensteer/deployment-authority";
import {
  DesktopAccountAuthStateSchema,
  hasAsciiControl,
  type DesktopAccountAuthState,
} from "@opensteer/protocol/desktop";
import { z } from "zod";
import {
  ClientOperationError,
  transientHttpStatus,
  unrefTimer,
} from "../connections/operation-error.js";
import type {
  DeploymentCatalogStore,
  AccountDeploymentConnectionSource,
  DeploymentConnection,
} from "../connections/deployment-catalog.js";
import { resolveConnection } from "../connections/connection-resolver.js";
import type { HostCredentialProvider } from "../connections/host-attachment-fence.js";
import type { NativeOAuthIdentity } from "./oauth-identity.js";
import {
  AccountCredentialSchema,
  HostCredentialSchema,
  emptyProtectedAuthState,
  type AccountCredential,
  type HostCredential,
  type ProtectedAuthState,
  type ProtectedAuthStore,
} from "./protected-auth-store.js";

/**
 * The token endpoint answered and refused the grant. It is the one refresh
 * failure that says a credential is dead; a refresh that never got an answer
 * says nothing about the credential at all.
 */
class OAuthGrantRefusedError extends Error {}

/** The token endpoint answered without a verdict on the grant, so the credential stands. */
class OAuthTokenEndpointFailedError extends ClientOperationError {
  constructor() {
    super("The authorization server could not complete the token exchange.", "transient");
  }
}

// RFC 6749 §5.2: the verdicts that the grant or its client can never be used again.
const OAuthGrantRefusalSchema = z.object({ error: z.enum(["invalid_grant", "invalid_client"]) });

/** A team Host turned the person away: not a member, or an invite that no longer works. */
export class TeamEntryRefusedError extends ClientOperationError {
  readonly reason: TeamEntryRefusalReason;

  constructor(reason: TeamEntryRefusalReason, message: string) {
    super(message, "blocked");
    this.name = "TeamEntryRefusedError";
    this.reason = reason;
  }
}

/**
 * The Account answered from a release before team identity grants, so it can't vouch for anyone
 * at a team yet. The team's own sign-in still works; this is never the team refusing someone.
 */
export class TeamIdentityGrantUnsupportedError extends ClientOperationError {
  static readonly reason = "team-identity-grant-unsupported";
  readonly reason = TeamIdentityGrantUnsupportedError.reason;

  constructor() {
    super("Sign in to the team to finish joining.", "blocked");
    this.name = "TeamIdentityGrantUnsupportedError";
  }
}

/** Whether a team Host can be entered with the Account's identity alone, without a browser. */
export function supportsTeamSessionExchange(connection: DeploymentConnection): boolean {
  return (
    connection.kind === "team" &&
    (connection.capabilities ?? []).includes("team-session-exchange-v1")
  );
}

/** Whether a team's invite page continues to this app's sign-in once it proved the invite. */
export function supportsTeamInviteContinuation(connection: DeploymentConnection): boolean {
  return (
    connection.kind === "team" &&
    (connection.capabilities ?? []).includes("team-invite-native-continuation-v1")
  );
}

const authorizationFlowLifetimeMs = 5 * 60_000;
const accessTokenRefreshSkewMs = 60_000;
const idTokenExpiryHorizonMs = 5_000;
const maximumOAuthResponseBytes = 128 * 1_024;
const maximumPendingAuthorizationFlows = 8;
const defaultOAuthNetworkTimeoutMs = 30_000;
const accountAuthorizationExpiredDetail =
  "Your Opensteer Account authorization expired. Sign in again.";
const accountUnreachableDetail =
  "Your Opensteer account couldn’t be reached. Check your connection and try again.";
const accountRenewalFailedDetail =
  "Your Opensteer account couldn’t renew your sign-in. Try again in a moment.";
const hostUnreachableDetail =
  "This server couldn’t be reached. Check your connection and try again.";
const hostRenewalFailedDetail = "This server couldn’t renew your sign-in. Try again in a moment.";
const revocationUnconfirmedDetail =
  "Signed out locally; server-side revocation could not be confirmed.";
const hostAuthorizationTimedOutDetail = "Authorization timed out. Sign in again.";

type NativeOAuthFlow =
  | {
      readonly callback: string;
      readonly createdAt: number;
      readonly issuerOrigin: string;
      readonly generation: number;
      readonly kind: "account";
      /**
       * Present only when the flow re-verifies one already signed-in subject.
       * The pinned subject is what the callback must return; the issuer is
       * already pinned by the flow's own `issuerOrigin`.
       */
      readonly reauthorization: { readonly subject: ControlPlaneAccountId } | null;
      readonly state: string;
      readonly verifier: string;
    }
  | {
      readonly callback: string;
      readonly connection: DeploymentConnection;
      readonly createdAt: number;
      readonly signal: AbortSignal;
      readonly kind: "host";
      readonly accountIdentity: HostCredential["accountIdentity"];
      readonly state: string;
      readonly verifier: string;
    };

type HostNativeOAuthFlow = Extract<NativeOAuthFlow, { readonly kind: "host" }>;

type AccountAuthStateListener = (state: DesktopAccountAuthState) => void;
type OAuthFetch = (input: string, init: RequestInit) => Promise<Response>;

type HostOAuthStatus = "authorizing" | "error" | "signed-in" | "signed-out";

export interface HostOAuthState {
  readonly connection: DeploymentConnection;
  readonly detail: string | null;
  /** The attachment key this state belongs to, so no observer re-resolves it. */
  readonly key: string;
  readonly status: HostOAuthStatus;
  readonly viewLoginId?: string;
}

export interface TeamEntryFence {
  readonly signal: AbortSignal;
  assertCurrent(): void;
}

/**
 * One live Account authorization capability. Its signal is invalidated before
 * sign-out, identity replacement, or credential rejection starts destructive
 * cleanup, so Account-derived effects cannot commit after that boundary.
 */
interface AccountAuthorizationLease {
  readonly authorization: string;
  readonly issuer: string;
  readonly signal: AbortSignal;
  readonly subject: ControlPlaneAccountId;
}

/** Token authorization, independent of the team runtime and interactive entry attempts. */
interface AccountSession {
  readonly controller: AbortController;
  readonly credential: AccountCredential;
}

type HostOAuthStateListener = (state: HostOAuthState) => void;

const OAuthTokenResponseSchema = z
  .object({
    access_token: z.string().min(16).max(65_536),
    expires_in: z.number().int().min(1).max(31_536_000),
    id_token: z.string().min(16).max(65_536).optional(),
    refresh_token: z.string().min(16).max(65_536).optional(),
    scope: z.string().min(1).max(4_096).optional(),
    token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  })
  .passthrough();

export class NativeOAuthManager implements HostCredentialProvider {
  readonly #beforeAccountIdentityChange: (
    next: AccountDeploymentConnectionSource | null,
  ) => Promise<void>;
  readonly #beforeAccountChange: () => Promise<void>;
  readonly #accountChangedTeams = new Set<string>();
  readonly #identityListeners = new Set<() => void>();
  readonly #onAccountIdentityChange: () => void;
  readonly #beforeHostChange: (connection: DeploymentConnection) => Promise<void>;
  readonly #accountOrigin: string | null;
  readonly #accountSessions: {
    removeAllAccountIdentities(): Promise<void>;
    removeOtherAccountIdentities(source: AccountDeploymentConnectionSource): Promise<void>;
  };
  readonly #catalog: Pick<
    DeploymentCatalogStore,
    "load" | "upsert" | "addPendingAccountDeployment" | "remove"
  >;
  readonly #fetch: OAuthFetch;
  readonly #accountListeners = new Set<AccountAuthStateListener>();
  readonly #flowExpiries = new Map<string, () => void>();
  readonly #signedOutTeams = new Set<DeploymentId>();
  readonly #hostListeners = new Set<HostOAuthStateListener>();
  readonly #networkTimeoutMs: number;
  readonly #now: () => Date;
  readonly #oauth: NativeOAuthIdentity;
  readonly #openExternal: (url: string, callback?: string) => Promise<void>;
  readonly #pending = new Map<string, NativeOAuthFlow>();
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #refreshes = new Map<string, Promise<string | null>>();
  readonly #scheduleExpiry: (callback: () => void, delayMilliseconds: number) => () => void;
  readonly #store: ProtectedAuthStore;
  #accountDetail: string | null = null;
  #accountFlowGeneration = 0;
  #accountSession: AccountSession | null = null;
  #teamRuntime = new TeamRuntimeOwner(null);

  readonly teamRuntime = (): TeamRuntimeOwner => this.#teamRuntime;
  #pendingAccountWrite: AccountCredential | null = null;
  readonly #pendingHostWrites = new Map<DeploymentId, HostCredential>();
  #hostCredentials: readonly HostCredential[] = [];
  #hostDetails = new Map<string, string>();
  #disposed = false;
  readonly #hostControllers = new Map<DeploymentId, AbortController>();
  #initialized = false;
  readonly #credentialMutations = new MutationQueue();
  #storageError: string | null = null;

  constructor(options: {
    readonly beforeAccountIdentityChange?: (
      next: AccountDeploymentConnectionSource | null,
    ) => Promise<void>;
    readonly beforeAccountChange?: () => Promise<void>;
    readonly onAccountIdentityChange?: () => void;
    readonly beforeHostChange?: (connection: DeploymentConnection) => Promise<void>;
    readonly accountOrigin: URL | string | null;
    readonly accountSessions: {
      removeAllAccountIdentities(): Promise<void>;
      removeOtherAccountIdentities(source: AccountDeploymentConnectionSource): Promise<void>;
    };
    readonly catalog: Pick<
      DeploymentCatalogStore,
      "load" | "upsert" | "addPendingAccountDeployment" | "remove"
    >;
    readonly fetch?: OAuthFetch;
    readonly now?: () => Date;
    readonly networkTimeoutMs?: number;
    readonly oauth: NativeOAuthIdentity;
    readonly openExternal: (url: string, callback?: string) => Promise<void>;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly scheduleExpiry?: (callback: () => void, delayMilliseconds: number) => () => void;
    readonly store: ProtectedAuthStore;
  }) {
    this.#beforeAccountIdentityChange =
      options.beforeAccountIdentityChange ?? (async () => undefined);
    this.#beforeAccountChange = options.beforeAccountChange ?? (async () => undefined);
    this.#onAccountIdentityChange = options.onAccountIdentityChange ?? (() => undefined);
    this.#beforeHostChange = options.beforeHostChange ?? (async () => undefined);
    this.#accountOrigin =
      options.accountOrigin === null
        ? null
        : bareServiceOrigin(options.accountOrigin, "OAuth issuer");
    this.#accountSessions = options.accountSessions;
    this.#catalog = options.catalog;
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#now = options.now ?? (() => new Date());
    this.#networkTimeoutMs = boundedOAuthNetworkTimeout(
      options.networkTimeoutMs ?? defaultOAuthNetworkTimeoutMs,
    );
    this.#oauth = options.oauth;
    this.#openExternal = options.openExternal;
    this.#randomBytes = options.randomBytes ?? secureRandomBytes;
    this.#scheduleExpiry =
      options.scheduleExpiry ??
      ((callback, delayMilliseconds) => {
        const timer = setTimeout(callback, delayMilliseconds);
        unrefTimer(timer);
        return () => clearTimeout(timer);
      });
    this.#store = options.store;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    this.#initialized = true;
    try {
      this.#adoptProtectedState(await this.#store.load());
      this.#storageError = null;
    } catch (error) {
      this.#storageError = publicError(error, "Protected credential storage is unavailable.");
      this.#adoptProtectedState(emptyProtectedAuthState());
    }
    await this.#emitAccount();
  }

  subscribe(listener: AccountAuthStateListener): () => void {
    this.#accountListeners.add(listener);
    return () => this.#accountListeners.delete(listener);
  }

  subscribeHostCredentials(listener: HostOAuthStateListener): () => void {
    this.#hostListeners.add(listener);
    return () => this.#hostListeners.delete(listener);
  }

  async state(): Promise<DesktopAccountAuthState> {
    this.#assertInitialized();
    this.#expirePendingFlows();
    const accountPending = [...this.#pending.values()].some(({ kind }) => kind === "account");
    const accountIdentity = accountIdentityOf(this.#accountSession);
    const accountSignedIn = accountIdentity !== null;
    const storageDetail = this.#storageError;
    return DesktopAccountAuthStateSchema.parse({
      account: storageDetail
        ? { available: false, detail: storageDetail, identity: null, status: "error" }
        : this.#accountOrigin === null
          ? {
              available: false,
              detail: "Opensteer Account sign-in isn't available yet.",
              identity: null,
              status: "signed-out",
            }
          : accountPending
            ? {
                available: true,
                detail: "Complete authorization in your browser.",
                identity: accountIdentity,
                status: "authorizing",
              }
            : this.#accountDetail
              ? {
                  available: true,
                  detail: this.#accountDetail,
                  identity: accountIdentity,
                  status: accountSignedIn ? "signed-in" : "error",
                }
              : {
                  available: true,
                  detail: null,
                  identity: accountIdentity,
                  status: accountSignedIn ? "signed-in" : "signed-out",
                },
      schemaVersion: 2,
    });
  }

  hostCredentialState(connection: DeploymentConnection): HostOAuthState {
    this.#assertInitialized();
    this.#expirePendingFlows();
    const key = hostAttachmentKey(connection);
    const pending = [...this.#pending.values()].some(
      (flow) => flow.kind === "host" && hostAttachmentKey(flow.connection) === key,
    );
    const credential = this.#hostCredential(connection.authority.document.deploymentId);
    const detail =
      this.#storageError ??
      this.#hostDetails.get(key) ??
      (this.#accountChangedTeams.has(connection.authority.document.deploymentId)
        ? "Changing your Account signed this device out of the team."
        : null) ??
      (credential && !credentialMatchesConnection(credential, connection)
        ? "Saved authorization no longer matches this Host identity."
        : null);
    return {
      connection: structuredClone(connection),
      ...(credential?.viewLoginId ? { viewLoginId: credential.viewLoginId } : {}),
      detail: pending ? "Complete authorization in your browser." : detail,
      key,
      status: this.#storageError
        ? "error"
        : pending
          ? "authorizing"
          : credential && credentialMatchesConnection(credential, connection)
            ? "signed-in"
            : detail
              ? "error"
              : "signed-out",
    };
  }

  /** Local continuity only; never returns a credential or refreshes one. */
  hostViewLoginId(connection: DeploymentConnection): string | undefined {
    const credential = this.#hostCredential(connection.authority.document.deploymentId);
    return credential && credentialMatchesConnection(credential, connection)
      ? credential.viewLoginId
      : undefined;
  }

  accountViewLoginId(): string | undefined {
    return this.#accountSession?.credential.viewLoginId;
  }

  /** Called only after a current authenticated bootstrap, inside the credential owner's queue. */
  async initializeViewLoginIds(
    connection: DeploymentConnection,
    isCurrent: () => boolean,
  ): Promise<void> {
    const host = this.#hostCredential(connection.authority.document.deploymentId);
    const account = this.#accountSession;
    await this.#mutateCredentials(async () => {
      if (this.#disposed || !isCurrent()) return;
      if (
        host &&
        !host.viewLoginId &&
        this.#hostCredential(host.deploymentId) === host &&
        credentialMatchesConnection(host, connection)
      ) {
        const next = { ...host, viewLoginId: globalThis.crypto.randomUUID() };
        const state = await this.#store.setHost(next);
        if (!this.#disposed && isCurrent() && this.#hostCredential(host.deploymentId) === host) {
          this.#pendingHostWrites.delete(host.deploymentId);
          this.#adoptHostCredentials(state.hosts);
        }
      }
      if (!isCurrent() || this.#disposed) return;
      if (
        connection.source.kind === "account" &&
        account &&
        !account.credential.viewLoginId &&
        this.#accountSession === account &&
        account.credential.issuerOrigin === connection.source.issuer &&
        account.credential.subject === connection.source.subject
      ) {
        const next = { ...account.credential, viewLoginId: globalThis.crypto.randomUUID() };
        await this.#store.setAccount(next);
        if (!this.#disposed && isCurrent() && this.#accountSession === account) {
          this.#replaceAccountSession({ ...account, credential: next });
        }
      }
    });
  }

  async beginAccountSignIn(): Promise<DesktopAccountAuthState> {
    return this.#beginAccountAuthorization(null);
  }

  async beginAccountReauthorization(): Promise<DesktopAccountAuthState> {
    await this.#ensureStorageReady();
    if (this.#accountOrigin === null) {
      throw new Error("Opensteer Account sign-in isn't available yet.");
    }
    const session = this.#accountSession;
    if (!session) {
      throw new Error("Sign in to your Opensteer Account before verifying it again.");
    }
    return this.#beginAccountAuthorization({ subject: session.credential.subject });
  }

  /**
   * Opens a browser flow. Only the flow fence advances here: the live Account
   * session keeps working until a callback actually commits a new identity.
   */
  async #beginAccountAuthorization(
    reauthorization: { readonly subject: ControlPlaneAccountId } | null,
  ): Promise<DesktopAccountAuthState> {
    await this.#beforeAccountChange();
    await this.#ensureStorageReady();
    if (this.#accountOrigin === null) {
      throw new Error("Opensteer Account sign-in isn't available yet.");
    }
    this.#accountDetail = null;
    this.#removePending((flow) => flow.kind === "account");
    const flow: NativeOAuthFlow = {
      callback: this.#oauth.accountCallback,
      createdAt: this.#now().getTime(),
      generation: this.#advanceAccountFlowGeneration(),
      issuerOrigin: this.#accountOrigin,
      kind: "account",
      reauthorization,
      state: this.#newState(),
      verifier: this.#randomValue(64),
    };
    await this.#begin(
      flow,
      accountEndpoints(this.#accountOrigin),
      accountAuthorizationScopes(flow),
    );
    return this.state();
  }

  /**
   * The team's own sign-in in the system browser. With `invite`, the browser opens the team's
   * invite page first, which proves the invite there and continues to this sign-in, so a person
   * who isn't a member yet is admitted when the team's callback lands. Only a team advertising
   * `team-invite-native-continuation-v1` takes `invite`; elsewhere the person joins in the browser
   * first.
   */
  async beginHostSignIn(
    connectionInput: DeploymentConnection,
    invite?: TeamInviteSecret,
    entry = this.teamEntryFence(connectionInput.authority.document.deploymentId, true),
  ): Promise<HostOAuthState> {
    const connection = structuredClone(connectionInput);
    if (connection.kind !== "team") {
      throw new Error("Only a team server uses deployment-native OAuth.");
    }
    if (invite && !supportsTeamInviteContinuation(connection))
      throw new Error("Join this team in the browser first, then sign in to it here.");
    // Claimed before the first await. Protected storage can take long enough
    // for a person to leave the flow, and only this fence sees that boundary.
    entry.assertCurrent();
    const accountIdentity = this.#currentAccountIdentity();
    await this.resumeTeamSignIn(connection);
    entry.assertCurrent();
    await this.#beforeHostChange(connection);
    await this.#ensureStorageReady();
    entry.assertCurrent();
    const key = hostAttachmentKey(connection);
    this.#hostDetails.delete(key);
    this.#removePending(
      (flow) => flow.kind === "host" && hostAttachmentKey(flow.connection) === key,
    );
    const flow: NativeOAuthFlow = {
      callback: this.#oauth.hostCallback,
      connection,
      createdAt: this.#now().getTime(),
      signal: entry.signal,
      kind: "host",
      accountIdentity,
      state: this.#newState(),
      verifier: this.#randomValue(64),
    };
    await this.#begin(
      flow,
      hostEndpoints(connection.authority.document.canonicalOrigin),
      opensteerHostOAuthScopes,
      invite,
    );
    return this.hostCredentialState(connection);
  }

  subscribeAccountIdentityChanges(listener: () => void): () => void {
    this.#identityListeners.add(listener);
    return () => {
      this.#identityListeners.delete(listener);
    };
  }

  teamEntryFence(deploymentId: DeploymentId, claim = false): TeamEntryFence {
    if (claim) this.#advanceHostEntry(deploymentId);
    let controller = this.#hostControllers.get(deploymentId);
    if (!controller) this.#hostControllers.set(deploymentId, (controller = new AbortController()));
    const owner = this.#teamRuntime;
    const signal = AbortSignal.any([controller.signal, owner.signal]);
    return { signal, assertCurrent: () => signal.throwIfAborted() };
  }

  isTeamSignInSuppressed(connection: DeploymentConnection): boolean {
    return this.#signedOutTeams.has(connection.authority.document.deploymentId);
  }

  async resumeTeamSignIn(
    connection: DeploymentConnection,
    entry = this.teamEntryFence(connection.authority.document.deploymentId),
  ): Promise<void> {
    entry.assertCurrent();
    await this.#mutateCredentials(async () => {
      entry.assertCurrent();
      this.#signedOutTeams.delete(connection.authority.document.deploymentId);
      await this.#store.setTeamSignOutSuppression?.(
        connection.authority.document.deploymentId,
        false,
      );
    });
  }

  async signInTeam(
    connection: DeploymentConnection,
    invite?: TeamInviteSecret,
    interactive = true,
  ): Promise<HostOAuthState> {
    const outcome = await this.#teamEntry().authorize({
      deploymentId: connection.authority.document.deploymentId,
      origin: connection.authority.document.canonicalOrigin,
      mode: interactive ? "interactive" : "passive",
      invite: invite ?? null,
    });
    assertTeamEntryOutcome(outcome);
    return this.hostCredentialState(connection);
  }

  #teamEntry(): NativeTeamEntry {
    return new NativeTeamEntry({
      oauth: this,
      catalog: this.#catalog,
      verify: (origin) =>
        verifyTeamEndpoint(origin, {
          fetch: (input, init) => this.#fetch(String(input), init ?? {}),
        }),
      bootstrap: async () => {
        throw new Error("Entry bootstrap belongs to the attachment.");
      },
    });
  }

  /**
   * Signs this application in to a team without a browser: Account signs who the person is for
   * this exact team Host, and the team Host decides membership, admitting through `invite` when
   * one is given. The tokens are stored and refreshed exactly like a browser sign-in's. Only for a
   * team advertising `team-session-exchange-v1`; others keep `beginHostSignIn`.
   */
  async exchangeTeamSession(
    connection: DeploymentConnection,
    invite?: TeamInviteSecret,
    entry = this.teamEntryFence(connection.authority.document.deploymentId, true),
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member">> {
    entry.assertCurrent();
    const lease = await this.accountAuthorizationLease();
    entry.assertCurrent();
    if (!lease) throw new ClientOperationError("Account authorization changed.", "transient");
    if (this.isTeamSignInSuppressed(connection))
      throw new ClientOperationError("Signing in to this team was interrupted.", "transient");
    const exchange = async () => {
      const { assertion } = await this.issueTeamIdentityGrant(
        connection.authority.document.deploymentId,
        this.#teamIdentityRequest(connection),
      );
      entry.assertCurrent();
      if (lease.signal.aborted)
        throw new ClientOperationError("Account authorization changed.", "transient");
      return this.#exchangeTeamAssertion(
        connection,
        { assertion, ...(invite ? { invite } : {}) },
        { lease, signal: entry.signal },
      );
    };
    try {
      return await exchange();
    } catch (error) {
      if (!(error instanceof TeamEntryRefusedError) || error.reason !== "assertion-expired")
        throw error;
      entry.assertCurrent();
      return exchange();
    }
  }

  #teamIdentityRequest(connection: DeploymentConnection): IssueTeamIdentityGrantRequest {
    const document = connection.authority.document;
    return {
      expectedAuthority: {
        canonicalOrigin: document.canonicalOrigin,
        deploymentId: document.deploymentId,
        hostInstanceId: document.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(connection.authority.publicKey.spki),
      },
      surface: this.#oauth.application,
    };
  }

  /** Account's signed statement of who this person is, for one exact team Host and this app. */
  async issueTeamIdentityGrant(
    deploymentId: DeploymentId,
    request: IssueTeamIdentityGrantRequest,
  ): Promise<IssueTeamIdentityGrantResponse> {
    const lease = await this.accountAuthorizationLease();
    if (!lease) {
      throw new ClientOperationError(
        "Sign in to your Opensteer account to join a team.",
        "blocked",
      );
    }
    const post = (authorization: string) =>
      this.#postJson(
        new URL(accountTeamIdentityGrantsPath(deploymentId), lease.issuer).toString(),
        request,
        { authorization },
        lease.signal,
      );
    let response = await post(lease.authorization);
    if (response.status === 401 && !lease.signal.aborted) {
      const session = this.#accountSession;
      if (session?.controller.signal === lease.signal) {
        const authorization =
          `Bearer ${session.credential.accessToken}` !== lease.authorization
            ? `Bearer ${session.credential.accessToken}`
            : await this.#serializedRefresh("account", () => this.#refreshAccountSession(session));
        if (authorization && !lease.signal.aborted) response = await post(authorization);
      }
    }
    if (!response.ok) {
      if (response.status === 409)
        throw new TeamEntryRefusedError(
          "authority-changed",
          "The team authority changed. Open its address again.",
        );
      // A route the Account doesn't have answers without Account's own error body.
      if (
        response.status === 404 &&
        !z.object({ error: z.object({ code: z.string() }) }).safeParse(response.body).success
      )
        throw new TeamIdentityGrantUnsupportedError();
      throw new ClientOperationError(
        accountUnreachableDetail,
        transientHttpStatus(response.status) ? "transient" : "blocked",
      );
    }
    return IssueTeamIdentityGrantResponseSchema.parse(response.body);
  }

  /** The exchange half of `exchangeTeamSession`, for a caller already holding the assertion. */
  async #exchangeTeamAssertion(
    connectionInput: DeploymentConnection,
    request: TeamSessionExchangeRequest,
    context: { readonly lease: AccountAuthorizationLease; readonly signal: AbortSignal },
  ): Promise<Pick<TeamSessionExchangeResponse, "admitted" | "member">> {
    const connection = structuredClone(connectionInput);
    if (!supportsTeamSessionExchange(connection)) {
      throw new Error("This team can't be entered without a browser sign-in.");
    }
    const authority = connection.authority;
    const deploymentId = authority.document.deploymentId;
    const origin = authority.document.canonicalOrigin;
    const current = () =>
      !context.signal.aborted && !this.#disposed && !context.lease.signal.aborted;
    await this.#ensureStorageReady();
    if (!current())
      throw new ClientOperationError("Team authorization changed. Try again.", "transient");
    const exchanged = await this.#postJson(
      `${origin}${teamSessionExchangePath}`,
      TeamSessionExchangeRequestSchema.parse(request),
      { [teamApiVersionHeader]: String(teamApiVersion) },
      AbortSignal.any([context.signal, context.lease.signal]),
    );
    if (!exchanged.ok) throw teamExchangeFailure(exchanged.status, exchanged.body);
    const entered = TeamSessionExchangeResponseSchema.parse(exchanged.body);
    let credential: HostCredential;
    try {
      credential = HostCredentialSchema.parse({
        ...tokenCredentialFields(
          entered.tokens,
          entered.tokens.refresh_token,
          opensteerHostOAuthScopes,
          this.#now(),
        ),
        accountIdentity: { issuer: context.lease.issuer, subject: context.lease.subject },
        viewLoginId:
          this.#hostCredential(deploymentId)?.viewLoginId ?? globalThis.crypto.randomUUID(),
        canonicalOrigin: origin,
        deploymentId,
        hostInstanceId: authority.document.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(authority.publicKey.spki),
      });
    } catch (error) {
      await this.#revokeLateCredential(hostEndpoints(origin), entered.tokens.refresh_token, origin);
      throw error;
    }
    const committed = await this.#mutateCredentials(async () => {
      if (!current()) return false;
      const state = await this.#store.setHost(credential);
      this.#pendingHostWrites.delete(deploymentId);
      this.#adoptHostCredentials(state.hosts);
      if (!current()) {
        this.#adoptHostCredentials((await this.#store.clearHost(deploymentId)).hosts);
        return false;
      }
      this.#removePending(
        (flow) =>
          flow.kind === "host" && flow.connection.authority.document.deploymentId === deploymentId,
      );
      this.#hostDetails.delete(hostAttachmentKey(connection));
      this.#accountChangedTeams.delete(deploymentId);
      return true;
    }).catch(async (error: unknown) => {
      await this.#revokeLateCredential(hostEndpoints(origin), credential.refreshToken, origin);
      throw error;
    });
    if (!committed) {
      await this.#revokeLateCredential(hostEndpoints(origin), credential.refreshToken, origin);
      throw new ClientOperationError("Signing in to this team was interrupted.", "transient");
    }
    this.#emitHost(connection);
    return { admitted: entered.admitted, member: entered.member };
  }

  /** Stops one Deployment's pending or exchanging browser authorization. */
  abandonHostSignIn(deploymentId: DeploymentId): void {
    if (!this.#initialized || this.#disposed) return;
    const belongsToDeployment = (flow: NativeOAuthFlow): boolean =>
      flow.kind === "host" && flow.connection.authority.document.deploymentId === deploymentId;
    const abandoned: HostNativeOAuthFlow[] = [];
    for (const flow of this.#pending.values()) {
      if (flow.kind === "host" && belongsToDeployment(flow)) abandoned.push(flow);
    }
    this.#advanceHostEntry(deploymentId);
    this.#removePending(belongsToDeployment);
    for (const flow of abandoned) {
      this.#hostDetails.delete(hostAttachmentKey(flow.connection));
      this.#emitHost(flow.connection);
    }
  }

  async handleCallback(rawUrl: string): Promise<boolean> {
    this.#assertInitialized();
    this.#expirePendingFlows();
    const callback = parseOAuthCallback(rawUrl, this.#oauth);
    if (!callback) return false;
    const flow = this.#pending.get(callback.state);
    if (!flow || flow.callback !== callback.callback) return true;
    this.#pending.delete(callback.state); // Consume before any network work: codes are single-use.
    this.#clearFlowExpiry(callback.state);
    let uncommittedCredential:
      | {
          readonly endpoints: OAuthEndpoints;
          readonly refreshToken: string;
          readonly resource: string;
        }
      | undefined;
    try {
      const expectedIssuer =
        flow.kind === "account"
          ? flow.issuerOrigin
          : flow.connection.authority.document.canonicalOrigin;
      if (callback.issuer !== expectedIssuer) {
        throw new Error("The authorization callback issuer did not match the requested service.");
      }
      if (callback.error) {
        throw new Error(
          callback.error === "access_denied"
            ? "Authorization was denied."
            : "Authorization could not be completed.",
        );
      }
      if (!callback.code) throw new Error("The authorization callback did not include a code.");
      if (flow.kind === "account") {
        const tokens = await this.#exchangeAuthorizationCode(
          accountEndpoints(flow.issuerOrigin),
          flow.callback,
          flow.verifier,
          callback.code,
          flow.issuerOrigin,
          accountAuthorizationScopes(flow),
        );
        const { idToken, ...credentialTokens } = tokens;
        // Claimed from here on: every later failure must revoke it remotely.
        uncommittedCredential = {
          endpoints: accountEndpoints(flow.issuerOrigin),
          refreshToken: credentialTokens.refreshToken,
          resource: flow.issuerOrigin,
        };
        if (!idToken) {
          throw new Error("The Account authorization server omitted an ID token.");
        }
        const identity = accountIdentityFromIdToken({
          clientId: this.#oauth.clientId,
          idToken,
          issuer: flow.issuerOrigin,
          now: this.#now(),
          reauthorizedAfter: flow.reauthorization ? flow.createdAt : null,
        });
        if (flow.reauthorization && identity.subject !== flow.reauthorization.subject) {
          throw new Error(
            "That verification returned a different Opensteer Account. Sign out before switching accounts.",
          );
        }
        const credential = AccountCredentialSchema.parse({
          ...credentialTokens,
          viewLoginId: globalThis.crypto.randomUUID(),
          ...(identity.email ? { email: identity.email } : {}),
          issuerOrigin: flow.issuerOrigin,
          subject: identity.subject,
        });
        const previousCredential = this.#accountSession?.credential ?? null;
        const committed = await this.#mutateCredentials(async () => {
          if (!this.#isFlowCurrent(flow)) return false;
          if (
            !previousCredential ||
            previousCredential.issuerOrigin !== credential.issuerOrigin ||
            previousCredential.subject !== credential.subject
          ) {
            this.#accountSession?.controller.abort(new Error("The Account identity changed."));
            this.#replaceTeamRuntime({
              issuer: credential.issuerOrigin,
              subject: credential.subject,
            });
            void this.#emitAccount();
            await this.#beforeAccountIdentityChange(accountSource(credential));
            if (!this.#isFlowCurrent(flow)) return false;
          }
          await this.#accountSessions.removeOtherAccountIdentities(accountSource(credential));
          this.#adoptHostCredentials((await this.#store.setAccount(credential)).hosts);
          // Committing the new identity is what ends the previous one.
          this.#replaceAccountSession(newAccountSession(credential));
          this.#accountDetail = null;
          return true;
        });
        if (!committed) {
          await this.#revokeLateCredential(
            accountEndpoints(flow.issuerOrigin),
            credential.refreshToken,
            flow.issuerOrigin,
          );
          uncommittedCredential = undefined;
        } else {
          uncommittedCredential = undefined;
          if (
            previousCredential &&
            previousCredential.issuerOrigin === flow.issuerOrigin &&
            previousCredential.refreshToken !== credential.refreshToken
          ) {
            void this.#revokeLateCredential(
              accountEndpoints(flow.issuerOrigin),
              previousCredential.refreshToken,
              flow.issuerOrigin,
            );
          }
        }
      } else {
        const origin = flow.connection.authority.document.canonicalOrigin;
        const tokens = await this.#exchangeAuthorizationCode(
          hostEndpoints(origin),
          flow.callback,
          flow.verifier,
          callback.code,
          origin,
          opensteerHostOAuthScopes,
        );
        const { idToken: _idToken, ...credentialTokens } = tokens;
        const credential = HostCredentialSchema.parse({
          ...credentialTokens,
          accountIdentity: flow.accountIdentity,
          viewLoginId: globalThis.crypto.randomUUID(),
          canonicalOrigin: origin,
          deploymentId: flow.connection.authority.document.deploymentId,
          hostInstanceId: flow.connection.authority.document.hostInstanceId,
          hostKeyFingerprint: hostKeyFingerprint(flow.connection.authority.publicKey.spki),
        });
        uncommittedCredential = {
          endpoints: hostEndpoints(origin),
          refreshToken: credential.refreshToken,
          resource: origin,
        };
        const committed = await this.#mutateCredentials(async () => {
          if (!this.#isFlowCurrent(flow)) return false;
          const state = await this.#store.setHost(credential);
          this.#pendingHostWrites.delete(credential.deploymentId);
          this.#adoptHostCredentials(state.hosts);
          if (!this.#isFlowCurrent(flow)) {
            this.#adoptHostCredentials(
              (await this.#store.clearHost(credential.deploymentId)).hosts,
            );
            return false;
          }
          this.#hostDetails.delete(hostAttachmentKey(flow.connection));
          this.#accountChangedTeams.delete(credential.deploymentId);
          return true;
        });
        if (committed) {
          uncommittedCredential = undefined;
        } else {
          await this.#revokeLateCredential(hostEndpoints(origin), credential.refreshToken, origin);
          uncommittedCredential = undefined;
        }
      }
    } catch (error) {
      if (uncommittedCredential) {
        await this.#revokeLateCredential(
          uncommittedCredential.endpoints,
          uncommittedCredential.refreshToken,
          uncommittedCredential.resource,
        );
      }
      if (flow.kind === "account" && this.#accountSession?.controller.signal.aborted)
        this.#replaceAccountSession(null);
      const detail = publicError(error, "Authorization could not be completed.");
      if (this.#isFlowCurrent(flow)) {
        if (flow.kind === "account") this.#accountDetail = detail;
        else this.#hostDetails.set(hostAttachmentKey(flow.connection), detail);
      }
    }
    if (flow.kind === "account") await this.#emitAccount();
    else this.#emitHost(flow.connection);
    return true;
  }

  async authorizationHeader(connection: DeploymentConnection): Promise<string | null> {
    this.#assertStorageReady();
    // Personal connections ride the partition session cookie, so they must
    // never also carry a self-hosted bearer token.
    if (connection.kind !== "team") return null;
    const owner = this.#teamRuntime;
    await owner.run(() => this.#retryCredentialWrite(connection.authority.document.deploymentId));
    const credential = this.#hostCredential(connection.authority.document.deploymentId);
    if (!credential || !credentialMatchesConnection(credential, connection)) {
      return null;
    }
    if (
      Date.parse(credential.accessTokenExpiresAt) >
      this.#now().getTime() + accessTokenRefreshSkewMs
    ) {
      return `Bearer ${credential.accessToken}`;
    }
    return this.#refreshHostCredential(connection, credential);
  }

  /**
   * Refreshes Host-native OAuth only after the Host returned an actual 401. A team that takes the
   * Account's identity is entered again without a browser once refreshing cannot help.
   */
  async recoverHostAuthorization(
    connection: DeploymentConnection,
    rejectedAuthorization?: string | null,
  ): Promise<boolean> {
    const outcome = await this.#teamEntry().authorize({
      deploymentId: connection.authority.document.deploymentId,
      origin: connection.authority.document.canonicalOrigin,
      mode: "passive",
      recover: { authorization: rejectedAuthorization },
    });
    if (outcome.status === "suppressed" || outcome.status === "sign-in-required") return false;
    assertTeamEntryOutcome(outcome);
    const authorization = await this.authorizationHeader(connection);
    return (
      outcome.status === "authorized" && !!authorization && authorization !== rejectedAuthorization
    );
  }

  async refreshTeamAuthorization(
    connection: DeploymentConnection,
    rejectedAuthorization?: string | null,
  ): Promise<string | null> {
    this.#assertStorageReady();
    const credential = this.#hostCredential(connection.authority.document.deploymentId);
    if (!credential || !credentialMatchesConnection(credential, connection)) return null;
    if (
      rejectedAuthorization !== undefined &&
      rejectedAuthorization !== `Bearer ${credential.accessToken}`
    )
      return this.authorizationHeader(connection);
    return this.#refreshHostCredential(connection, credential);
  }

  async #refreshHostCredential(
    connection: DeploymentConnection,
    credential: HostCredential,
  ): Promise<string | null> {
    const deploymentId = connection.authority.document.deploymentId;
    const key = hostAttachmentKey(connection);
    const owner = this.#teamRuntime;
    return this.#serializedRefresh(`host:${deploymentId}:${credential.refreshToken}`, async () => {
      const current = this.#hostCredential(deploymentId);
      if (
        !current ||
        current.refreshToken !== credential.refreshToken ||
        !credentialMatchesConnection(current, connection)
      ) {
        return null;
      }
      let refreshed: OAuthCredentialFields;
      try {
        refreshed = await this.#refreshCredential(
          hostEndpoints(credential.canonicalOrigin),
          credential.refreshToken,
          credential.canonicalOrigin,
          opensteerHostOAuthScopes,
        );
      } catch (error) {
        // As for the Account: an unanswered refresh keeps the credential.
        if (error instanceof OAuthGrantRefusedError) {
          owner.assertCurrent();
          await this.#mutateCredentials(async () => {
            owner.assertCurrent();
            if (this.#hostCredential(deploymentId)?.refreshToken !== credential.refreshToken)
              return;
            this.#pendingHostWrites.delete(deploymentId);
            this.#hostCredentials = this.#hostCredentials.filter(
              (host) => host.deploymentId !== deploymentId,
            );
            this.#adoptHostCredentials((await this.#store.clearHost(deploymentId)).hosts);
          });
          this.#emitHost(connection);
          return null;
        }
        throw new ClientOperationError(
          error instanceof OAuthTokenEndpointFailedError
            ? hostRenewalFailedDetail
            : hostUnreachableDetail,
          "transient",
          { cause: error },
        );
      }
      let next: HostCredential;
      try {
        next = HostCredentialSchema.parse({ ...credential, ...refreshed });
      } catch {
        return null;
      }
      const committed = await this.#mutateCredentials(async () => {
        if (
          owner.signal.aborted ||
          this.#hostCredential(deploymentId)?.refreshToken !== credential.refreshToken
        ) {
          return false;
        }
        let state: ProtectedAuthState | undefined;
        try {
          state = await this.#store.setHost(next);
        } catch {
          // Rotation already invalidated the old token; storage cannot undo it.
        }
        if (
          owner.signal.aborted ||
          this.#hostCredential(deploymentId)?.refreshToken !== credential.refreshToken
        ) {
          return false;
        }
        this.#pendingHostWrites.delete(deploymentId);
        if (state) this.#adoptHostCredentials(state.hosts);
        else {
          this.#hostCredentials = [
            ...this.#hostCredentials.filter((candidate) => candidate.deploymentId !== deploymentId),
            next,
          ];
          this.#pendingHostWrites.set(deploymentId, next);
        }
        this.#hostDetails.delete(key);
        return true;
      });
      if (!committed) {
        await this.#revokeLateCredential(
          hostEndpoints(credential.canonicalOrigin),
          next.refreshToken,
          credential.canonicalOrigin,
        );
        return null;
      }
      this.#emitHost(connection);
      return `Bearer ${next.accessToken}`;
    });
  }

  async accountAuthorizationHeader(): Promise<string | null> {
    const session = await this.#usableAccountSession();
    return session ? `Bearer ${session.credential.accessToken}` : null;
  }

  async accountAuthorizationLease(): Promise<AccountAuthorizationLease | null> {
    const session = await this.#usableAccountSession();
    if (!session) return null;
    return {
      authorization: `Bearer ${session.credential.accessToken}`,
      issuer: session.credential.issuerOrigin,
      signal: session.controller.signal,
      subject: session.credential.subject,
    };
  }

  accountIdentity(): {
    readonly email?: string;
    readonly issuer: string;
    readonly subject: ControlPlaneAccountId;
  } | null {
    this.#assertInitialized();
    return accountIdentityOf(this.#accountSession);
  }

  /**
   * The live session with an access token that is still usable, refreshing it
   * first when it is not. One reader returns the whole session so a caller can
   * never pair one identity's token with another identity's signal.
   */
  async #usableAccountSession(): Promise<AccountSession | null> {
    this.#assertStorageReady();
    await this.#retryCredentialWrite();
    const session = this.#accountSession;
    if (!session || session.controller.signal.aborted) return null;
    if (
      Date.parse(session.credential.accessTokenExpiresAt) >
      this.#now().getTime() + accessTokenRefreshSkewMs
    ) {
      return session;
    }
    if (
      (await this.#serializedRefresh("account", () => this.#refreshAccountSession(session))) ===
      null
    ) {
      return null;
    }
    const refreshed = this.#accountSession;
    return refreshed?.controller === session.controller ? refreshed : null;
  }

  async #refreshAccountSession(session: AccountSession): Promise<string | null> {
    const credential = session.credential;
    const issuerOrigin = credential.issuerOrigin;
    let refreshed: OAuthCredentialFields;
    try {
      refreshed = await this.#refreshCredential(
        accountEndpoints(issuerOrigin),
        credential.refreshToken,
        issuerOrigin,
        opensteerAccountOAuthScopes,
      );
    } catch (error) {
      // Only the Account refusing the grant says the credential is dead. A
      // refresh that never got an answer — a laptop waking onto no network, an
      // outage, a rate limit — keeps the session for the next request to retry.
      if (error instanceof OAuthGrantRefusedError) {
        await this.#expireAccountSession(session, accountAuthorizationExpiredDetail);
        return null;
      }
      if (this.#accountSession !== session) return null;
      throw new ClientOperationError(
        error instanceof OAuthTokenEndpointFailedError
          ? accountRenewalFailedDetail
          : accountUnreachableDetail,
        "transient",
        { cause: error },
      );
    }
    let next: AccountCredential;
    try {
      next = AccountCredentialSchema.parse({ ...credential, ...refreshed });
    } catch {
      await this.#expireAccountSession(session, accountAuthorizationExpiredDetail);
      return null;
    }
    let detailCleared = false;
    const committed = await this.#mutateCredentials(async () => {
      if (this.#accountSession !== session) return false;
      let state: ProtectedAuthState | undefined;
      try {
        state = await this.#store.setAccount(next);
      } catch {
        // Keep the rotated credential until protected storage accepts it.
      }
      if (this.#accountSession !== session) return false;
      if (state) this.#adoptHostCredentials(state.hosts);
      // Same identity, so the outstanding capability is carried forward.
      this.#replaceAccountSession({ controller: session.controller, credential: next });
      if (!state) this.#pendingAccountWrite = next;
      detailCleared = this.#accountDetail !== null;
      this.#accountDetail = null;
      return true;
    });
    if (!committed) {
      await this.#revokeLateCredential(
        accountEndpoints(issuerOrigin),
        next.refreshToken,
        issuerOrigin,
      );
      return null;
    }
    // A rotated token is invisible state: listeners hear from a refresh only
    // when it cleared something they were showing.
    if (detailCleared) await this.#emitAccount();
    return `Bearer ${next.accessToken}`;
  }

  /**
   * Drops the Account credential after the control plane refused it, so the
   * renderer's Account re-authorization surface is what the operator sees
   * instead of a Host sign-in gate the Deployment can never satisfy.
   */
  async notifyAccountCredentialRejected(): Promise<void> {
    if (!this.#initialized || this.#disposed || this.#storageError) return;
    const session = this.#accountSession;
    if (!session) return;
    await this.#expireAccountSession(session, accountAuthorizationExpiredDetail);
  }

  assertAccountSource(source: AccountDeploymentConnectionSource): void {
    const session = this.#accountSession;
    if (
      !session ||
      session.controller.signal.aborted ||
      session.credential.issuerOrigin !== source.issuer ||
      session.credential.subject !== source.subject
    )
      throw new Error("Sign in to this Account before setting up this Mac.");
  }

  async signOutAccount(): Promise<DesktopAccountAuthState> {
    this.#assertStorageReady();
    this.#removePending((flow) => flow.kind === "account");
    const flowGeneration = this.#advanceAccountFlowGeneration();
    const credential = this.#accountSession?.credential ?? null;
    // The capability dies before any cleanup awaits, so nothing issued during
    // sign-out can outlive the identity it was issued for.
    const invalidation = this.#beforeAccountChange();
    this.#replaceAccountSession(null);
    void this.#emitAccount();
    await invalidation;
    await this.#beforeAccountIdentityChange(null);
    if (this.#accountFlowGeneration !== flowGeneration) return this.state();
    this.#accountDetail = null;
    await this.#emitAccount();
    let detail: string | null = null;
    try {
      await this.#clearPersistedAccount();
    } catch (error) {
      detail = publicError(error, "Signed out locally; the saved credential could not be removed.");
    }
    try {
      await this.#mutateCredentials(() => this.#accountSessions.removeAllAccountIdentities());
    } catch (error) {
      detail ??= publicError(
        error,
        "Signed out locally; connected deployments could not be released.",
      );
    }
    if (credential) {
      try {
        await this.#revoke(
          accountEndpoints(credential.issuerOrigin),
          credential.refreshToken,
          credential.issuerOrigin,
        );
      } catch {
        detail ??= revocationUnconfirmedDetail;
      }
    }
    // Only the sign-out that is still the current Account state may report on it.
    if (
      detail !== null &&
      this.#accountSession === null &&
      this.#accountFlowGeneration === flowGeneration
    ) {
      this.#accountDetail = detail;
    }
    await this.#emitAccount();
    return this.state();
  }

  async signOutHost(connection: DeploymentConnection): Promise<HostOAuthState> {
    this.#assertStorageReady();
    const deploymentId = connection.authority.document.deploymentId;
    const key = hostAttachmentKey(connection);
    const credential = this.#hostCredential(deploymentId);
    this.#signedOutTeams.add(deploymentId);
    this.#removePending(
      (flow) =>
        flow.kind === "host" && flow.connection.authority.document.deploymentId === deploymentId,
    );
    const signal = this.teamEntryFence(deploymentId, true).signal;
    this.#hostCredentials = this.#hostCredentials.filter(
      (candidate) => candidate.deploymentId !== deploymentId,
    );
    this.#pendingHostWrites.delete(deploymentId);
    this.#hostDetails.delete(key);
    this.#emitHost(connection);
    await this.#beforeHostChange(connection);
    await this.#mutateCredentials(async () => {
      // A sign-in that finished after this sign-out began owns the stored credential now.
      if (signal.aborted) return;
      await this.#store.setTeamSignOutSuppression?.(deploymentId, true);
      this.#adoptHostCredentials((await this.#store.clearHost(deploymentId)).hosts);
    });
    this.#emitHost(connection);
    if (credential) {
      try {
        await this.#revoke(
          hostEndpoints(credential.canonicalOrigin),
          credential.refreshToken,
          credential.canonicalOrigin,
        );
      } catch {
        if (!signal.aborted && !this.#hostCredential(deploymentId)) {
          this.#hostDetails.set(key, revocationUnconfirmedDetail);
        }
      }
    }
    this.#emitHost(connection);
    return this.hostCredentialState(connection);
  }

  /** Removes credentials whose Deployment authority is no longer in the verified catalog. */
  async reconcileCatalog(): Promise<void> {
    this.#assertInitialized();
    if (this.#storageError) return;
    await this.#reconcileCatalogReady();
  }

  async #reconcileCatalogReady(): Promise<void> {
    const catalog = await this.#catalog.load();
    const connections = new Map(
      catalog.deployments.map((connection) => [
        connection.authority.document.deploymentId,
        connection,
      ]),
    );
    const stale = this.#hostCredentials.filter((credential) => {
      const connection = connections.get(credential.deploymentId);
      return !connection || !credentialMatchesConnection(credential, connection);
    });
    if (stale.length === 0) return;
    for (const credential of stale) {
      this.#advanceHostEntry(credential.deploymentId);
      this.#removePending(
        (flow) =>
          flow.kind === "host" &&
          flow.connection.authority.document.deploymentId === credential.deploymentId,
      );
    }
    await this.#mutateCredentials(async () => {
      const state = await this.#store.clearHosts(stale.map(({ deploymentId }) => deploymentId));
      for (const credential of stale) this.#pendingHostWrites.delete(credential.deploymentId);
      this.#adoptHostCredentials(state.hosts);
    });
    for (const credential of stale) {
      void this.#revokeLateCredential(
        hostEndpoints(credential.canonicalOrigin),
        credential.refreshToken,
        credential.canonicalOrigin,
      );
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#teamRuntime.retire();
    this.#replaceAccountSession(null);
    for (const controller of this.#hostControllers.values()) controller.abort();
    this.#hostControllers.clear();
    for (const cancel of this.#flowExpiries.values()) cancel();
    this.#flowExpiries.clear();
    this.#pending.clear();
    this.#refreshes.clear();
    this.#hostCredentials = [];
    this.#pendingHostWrites.clear();
    this.#accountListeners.clear();
    this.#hostListeners.clear();
    this.#identityListeners.clear();
  }

  async #begin(
    flow: NativeOAuthFlow,
    endpoints: OAuthEndpoints,
    scopes: readonly string[],
    invite?: TeamInviteSecret,
  ): Promise<void> {
    this.#pending.set(flow.state, flow);
    if (flow.kind === "host") this.#armHostFlowExpiry(flow);
    if (flow.kind === "account") await this.#emitAccount();
    else this.#emitHost(flow.connection);
    try {
      const authorization = authorizationUrl(endpoints, flow, scopes, this.#oauth.clientId);
      await this.#openExternal(
        invite ? teamInviteSignInUrl(authorization, invite) : authorization,
        flow.callback,
      );
    } catch (error) {
      this.#clearFlowExpiry(flow.state);
      this.#pending.delete(flow.state);
      const detail = publicError(error, "The system browser could not be opened.");
      if (this.#isFlowCurrent(flow)) {
        if (flow.kind === "account") this.#accountDetail = detail;
        else this.#hostDetails.set(hostAttachmentKey(flow.connection), detail);
      }
      if (flow.kind === "account") await this.#emitAccount();
      else this.#emitHost(flow.connection);
      throw error;
    }
  }

  #armHostFlowExpiry(flow: HostNativeOAuthFlow): void {
    const cancel = this.#scheduleExpiry(() => {
      this.#flowExpiries.delete(flow.state);
      if (this.#pending.get(flow.state) !== flow) return;
      this.#pending.delete(flow.state);
      this.#expireHostFlow(flow);
    }, authorizationFlowLifetimeMs);
    this.#flowExpiries.set(flow.state, cancel);
  }

  #expireHostFlow(flow: HostNativeOAuthFlow): void {
    if (this.#disposed) return;
    this.#hostDetails.set(hostAttachmentKey(flow.connection), hostAuthorizationTimedOutDetail);
    this.#emitHost(flow.connection);
  }

  #clearFlowExpiry(state: string): void {
    const cancel = this.#flowExpiries.get(state);
    if (!cancel) return;
    this.#flowExpiries.delete(state);
    cancel();
  }

  async #exchangeAuthorizationCode(
    endpoints: OAuthEndpoints,
    callback: string,
    verifier: string,
    code: string,
    resource: string,
    scopes: readonly string[],
  ): Promise<OAuthCredentialFields> {
    const response = await this.#tokenRequest(endpoints.token, {
      client_id: this.#oauth.clientId,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: callback,
      resource,
    });
    if (!response.refresh_token)
      throw new Error("The authorization server omitted a refresh token.");
    return {
      ...tokenCredentialFields(response, response.refresh_token, scopes, this.#now()),
      ...(response.id_token === undefined ? {} : { idToken: response.id_token }),
    };
  }

  async #refreshCredential(
    endpoints: OAuthEndpoints,
    refreshToken: string,
    resource: string,
    scopes: readonly string[],
  ): Promise<OAuthCredentialFields> {
    // RFC 6749 §6: a refresh without an explicit scope inherits whatever the
    // grant carries, so one elevated re-verification would otherwise elevate
    // the long-lived credential forever.
    const response = await this.#tokenRequest(endpoints.token, {
      client_id: this.#oauth.clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource,
      scope: scopes.join(" "),
    });
    return tokenCredentialFields(
      response,
      response.refresh_token ?? refreshToken,
      scopes,
      this.#now(),
    );
  }

  async #tokenRequest(endpoint: string, form: Record<string, string>) {
    const response = await this.#postForm(endpoint, form, true);
    if (response.ok && response.body !== undefined) {
      return OAuthTokenResponseSchema.parse(response.body);
    }
    // RFC 6749 §5.2 answers a refused grant with 400, or 401 for the client. A
    // bare 400 or 401 can come from a proxy or a misconfigured server instead.
    if (
      (response.status === 400 || response.status === 401) &&
      OAuthGrantRefusalSchema.safeParse(response.body).success
    ) {
      throw new OAuthGrantRefusedError("The authorization server rejected the token exchange.");
    }
    throw new OAuthTokenEndpointFailedError();
  }

  async #revoke(endpoints: OAuthEndpoints, token: string, resource: string): Promise<void> {
    const response = await this.#postForm(
      endpoints.revoke,
      {
        client_id: this.#oauth.clientId,
        resource,
        token,
        token_type_hint: "refresh_token",
      },
      false,
    );
    if (!response.ok) {
      throw new Error("Server-side authorization revocation failed.");
    }
  }

  async #postForm(
    endpoint: string,
    form: Record<string, string>,
    acceptJson: boolean,
  ): Promise<{ readonly body?: unknown; readonly ok: boolean; readonly status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("The authorization server timed out.")),
      this.#networkTimeoutMs,
    );
    unrefTimer(timeout);
    try {
      const response = await this.#fetch(endpoint, {
        body: new URLSearchParams(form).toString(),
        cache: "no-store",
        credentials: "omit",
        headers: {
          ...(acceptJson ? { accept: "application/json" } : {}),
          "content-type": "application/x-www-form-urlencoded",
          ...(new URL(endpoint).pathname.startsWith("/v1/auth/native/")
            ? { [teamApiVersionHeader]: String(teamApiVersion) }
            : {}),
        },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("The authorization server endpoint redirected.");
      }
      const json =
        acceptJson &&
        response.headers.get("content-type")?.split(";", 1)[0]?.trim() === "application/json";
      if (acceptJson && response.ok) {
        if (!json) {
          await response.body?.cancel();
          throw new Error("The authorization server did not return application/json.");
        }
        return {
          body: await readBoundedJson(response, boundedJsonOptions),
          ok: true,
          status: response.status,
        };
      }
      // A refusal's body says whether the grant is dead; an unreadable one says nothing.
      if (json) {
        return {
          body: await readBoundedJson(response, boundedJsonOptions).catch(() => undefined),
          ok: false,
          status: response.status,
        };
      }
      await response.body?.cancel();
      return { ok: response.ok, status: response.status };
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : new Error("The authorization server timed out.", { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /** A bounded JSON POST that keeps the answer's body, refusals included. */
  async #postJson(
    endpoint: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ readonly body: unknown; readonly ok: boolean; readonly status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new ClientOperationError(hostUnreachableDetail, "transient")),
      this.#networkTimeoutMs,
    );
    unrefTimer(timeout);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetch(endpoint, {
        body: JSON.stringify(body),
        cache: "no-store",
        credentials: "omit",
        headers: { ...headers, accept: "application/json", "content-type": "application/json" },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
      });
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("The server endpoint redirected.");
      }
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        await response.body?.cancel();
        return { body: undefined, ok: false, status: response.ok ? 502 : response.status };
      }
      return {
        body: await readBoundedJson(response, boundedJsonOptions),
        ok: response.ok,
        status: response.status,
      };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason instanceof Error) {
        throw controller.signal.reason;
      }
      throw new ClientOperationError(hostUnreachableDetail, "transient", { cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  #serializedRefresh(key: string, operation: () => Promise<string | null>): Promise<string | null> {
    const active = this.#refreshes.get(key);
    if (active) return active;
    const refresh = operation().finally(() => this.#refreshes.delete(key));
    this.#refreshes.set(key, refresh);
    return refresh;
  }

  #mutateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    return this.#credentialMutations.run(operation);
  }

  async #retryCredentialWrite(deploymentId?: DeploymentId): Promise<void> {
    const credential = deploymentId
      ? this.#pendingHostWrites.get(deploymentId)
      : this.#pendingAccountWrite;
    if (!credential) return;
    await this.#mutateCredentials(async () => {
      if ("deploymentId" in credential) {
        if (
          this.#pendingHostWrites.get(credential.deploymentId) !== credential ||
          this.#hostCredential(credential.deploymentId) !== credential
        )
          return;
        try {
          const state = await this.#store.setHost(credential);
          if (this.#hostCredential(credential.deploymentId) !== credential) return;
          this.#pendingHostWrites.delete(credential.deploymentId);
          this.#adoptHostCredentials(state.hosts);
        } catch {
          // A later credential read retries without rotating the token again.
        }
      } else {
        if (
          this.#pendingAccountWrite !== credential ||
          this.#accountSession?.credential !== credential
        )
          return;
        try {
          const state = await this.#store.setAccount(credential);
          if (this.#accountSession?.credential !== credential) return;
          this.#pendingAccountWrite = null;
          this.#adoptHostCredentials(state.hosts);
        } catch {
          // A later credential read retries without rotating the token again.
        }
      }
    });
  }

  #adoptHostCredentials(hosts: readonly HostCredential[]): void {
    this.#hostCredentials = [
      ...hosts.filter((credential) => !this.#pendingHostWrites.has(credential.deploymentId)),
      ...this.#pendingHostWrites.values(),
    ];
  }

  /** Credential rotation replaces authorization; only a different identity retires team work. */
  #replaceAccountSession(next: AccountSession | null): void {
    const previous = this.#accountSession;
    this.#accountSession = next;
    if (this.#pendingAccountWrite !== next?.credential) this.#pendingAccountWrite = null;
    if (previous && previous.controller !== next?.controller)
      previous.controller.abort(new Error("The Account authorization changed."));
    const identityChanged =
      previous?.credential.issuerOrigin !== next?.credential.issuerOrigin ||
      previous?.credential.subject !== next?.credential.subject;
    if (identityChanged && !this.#disposed) {
      this.#replaceTeamRuntime(next ? accountSource(next.credential) : null);
      this.#removePending((flow) => flow.kind === "host");
      const affected = this.#hostCredentials.filter(
        (host) => !this.#bindingMatches(host.accountIdentity),
      );
      for (const host of affected) this.#accountChangedTeams.add(host.deploymentId);
      for (const host of affected) this.#pendingHostWrites.delete(host.deploymentId);
      void this.#mutateCredentials(async () => {
        this.#adoptHostCredentials(
          (await this.#store.clearHosts(affected.map((host) => host.deploymentId))).hosts,
        );
      }).catch(() => undefined);
      for (const host of affected)
        void this.#revokeLateCredential(
          hostEndpoints(host.canonicalOrigin),
          host.refreshToken,
          host.canonicalOrigin,
        );
    }
  }

  /** Adopts persisted credentials, replacing whatever the process held. */
  #adoptProtectedState(state: ProtectedAuthState): void {
    this.#hostCredentials = state.hosts;
    for (const id of state.signedOutTeams ?? []) this.#signedOutTeams.add(id);
    const credential = state.account?.issuerOrigin === this.#accountOrigin ? state.account : null;
    this.#replaceAccountSession(credential ? newAccountSession(credential) : null);
  }

  /** Ends one Account session locally after its authorization stopped working. */
  async #expireAccountSession(session: AccountSession, detail: string): Promise<void> {
    if (this.#accountSession !== session) return;
    const invalidation = this.#beforeAccountChange();
    this.#replaceAccountSession(null);
    void this.#emitAccount();
    await invalidation;
    await this.#clearPersistedAccount();
    if (this.#accountSession === null) this.#accountDetail = detail;
    await this.#emitAccount();
  }

  /** Drops the persisted Account credential only while no session owns it. */
  #clearPersistedAccount(): Promise<void> {
    return this.#mutateCredentials(async () => {
      if (this.#accountSession !== null) return;
      this.#adoptHostCredentials((await this.#store.clearAccount()).hosts);
    });
  }

  #advanceAccountFlowGeneration(): number {
    this.#accountFlowGeneration = nextAuthGeneration(this.#accountFlowGeneration);
    return this.#accountFlowGeneration;
  }

  #replaceTeamRuntime(
    identity: { readonly issuer: string; readonly subject: string } | null,
  ): void {
    if (this.#teamRuntime.matches(identity)) return;
    this.#teamRuntime.retire();
    this.#teamRuntime = new TeamRuntimeOwner(identity);
    this.#notifyIdentityChange();
  }

  #notifyIdentityChange(): void {
    this.#onAccountIdentityChange();
    for (const listener of this.#identityListeners) listener();
  }

  #currentAccountIdentity(): Exclude<HostCredential["accountIdentity"], undefined> {
    const account = this.#accountSession?.credential;
    return account ? { issuer: account.issuerOrigin, subject: account.subject } : null;
  }

  #bindingMatches(binding: HostCredential["accountIdentity"]): boolean {
    if (binding === undefined) return false;
    const current = this.#currentAccountIdentity();
    return binding === null
      ? current === null
      : current !== null &&
          current !== undefined &&
          binding.issuer === current.issuer &&
          binding.subject === current.subject &&
          !this.#accountSession?.controller.signal.aborted;
  }

  #hostCredential(deploymentId: DeploymentId | string): HostCredential | undefined {
    return this.#hostCredentials.find(
      (candidate) =>
        candidate.deploymentId === deploymentId &&
        !this.#signedOutTeams.has(candidate.deploymentId) &&
        this.#bindingMatches(candidate.accountIdentity),
    );
  }

  #advanceHostEntry(deploymentId: DeploymentId): void {
    this.#hostControllers
      .get(deploymentId)
      ?.abort(new ClientOperationError("Team authorization changed. Try again.", "transient"));
    this.#hostControllers.delete(deploymentId);
  }

  #isFlowCurrent(flow: NativeOAuthFlow): boolean {
    if (this.#disposed) return false;
    return flow.kind === "account"
      ? flow.generation === this.#accountFlowGeneration
      : !flow.signal.aborted && this.#bindingMatches(flow.accountIdentity);
  }

  async #revokeLateCredential(
    endpoints: OAuthEndpoints,
    refreshToken: string,
    resource: string,
  ): Promise<void> {
    try {
      await this.#revoke(endpoints, refreshToken, resource);
    } catch {
      // The local generation fence is authoritative even when remote cleanup is unavailable.
    }
  }

  #randomValue(size: number): string {
    const value = encodeBase64Url(this.#randomBytes(size));
    if (value.length < 43 || value.length > 128 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new Error("Secure OAuth randomness is unavailable.");
    }
    return value;
  }

  #newState(): string {
    this.#expirePendingFlows();
    if (this.#pending.size >= maximumPendingAuthorizationFlows) {
      throw new Error("Too many authorization requests are already in progress.");
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = this.#randomValue(32);
      if (!this.#pending.has(state)) return state;
    }
    throw new Error("Secure OAuth state generation failed.");
  }

  #removePending(predicate: (flow: NativeOAuthFlow) => boolean): void {
    for (const [state, flow] of this.#pending) {
      if (!predicate(flow)) continue;
      this.#pending.delete(state);
      this.#clearFlowExpiry(state);
    }
  }

  #expirePendingFlows(): void {
    const threshold = this.#now().getTime() - authorizationFlowLifetimeMs;
    const expired: HostNativeOAuthFlow[] = [];
    for (const [state, flow] of this.#pending) {
      if (flow.createdAt >= threshold) continue;
      this.#pending.delete(state);
      this.#clearFlowExpiry(state);
      if (flow.kind === "host") expired.push(flow);
    }
    for (const flow of expired) this.#expireHostFlow(flow);
  }

  async #emitAccount(): Promise<void> {
    if (this.#accountListeners.size === 0) return;
    const state = await this.state();
    for (const listener of this.#accountListeners) {
      try {
        listener(state);
      } catch {
        // A renderer can disappear between state calculation and delivery.
      }
    }
  }

  #emitHost(connection: DeploymentConnection): void {
    if (this.#hostListeners.size === 0) return;
    const state = this.hostCredentialState(connection);
    for (const listener of this.#hostListeners) {
      try {
        listener(state);
      } catch {
        // A consumer can disappear between state calculation and delivery.
      }
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized || this.#disposed) {
      throw new Error("Native authorization is not initialized.");
    }
  }

  #assertStorageReady(): void {
    this.#assertInitialized();
    if (this.#storageError) throw new Error(this.#storageError);
  }

  async #ensureStorageReady(): Promise<void> {
    this.#assertInitialized();
    const recovering = this.#storageError !== null;
    try {
      if (recovering) {
        this.#adoptProtectedState(await this.#store.load());
        this.#storageError = null;
        await this.#reconcileCatalogReady();
      } else {
        await this.#store.assertAvailable();
      }
    } catch (error) {
      this.#storageError = publicError(error, "Protected credential storage is unavailable.");
      await this.#emitAccount().catch(() => undefined);
      throw new Error(this.#storageError);
    }
  }
}

interface OAuthEndpoints {
  readonly authorization: string;
  readonly revoke: string;
  readonly token: string;
}

interface OAuthCredentialFields {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: string;
  readonly grantedScopes: readonly string[];
  readonly idToken?: string;
  readonly refreshToken: string;
  readonly updatedAt: string;
}

function accountEndpoints(origin: string): OAuthEndpoints {
  return endpointSet(origin, "/api/auth/oauth2");
}

function hostEndpoints(origin: string): OAuthEndpoints {
  return endpointSet(origin, "/v1/auth/native/oauth2");
}

function endpointSet(origin: string, prefix: string): OAuthEndpoints {
  const normalized = bareServiceOrigin(origin, "OAuth issuer");
  return {
    authorization: new URL(`${prefix}/authorize`, normalized).toString(),
    revoke: new URL(`${prefix}/revoke`, normalized).toString(),
    token: new URL(`${prefix}/token`, normalized).toString(),
  };
}

function authorizationUrl(
  endpoints: OAuthEndpoints,
  flow: NativeOAuthFlow,
  scopes: readonly string[],
  clientId: string,
): string {
  const url = new URL(endpoints.authorization);
  if (flow.kind === "host") url.searchParams.set(teamOAuthVersionParameter, String(teamApiVersion));
  const resource =
    flow.kind === "account"
      ? flow.issuerOrigin
      : flow.connection.authority.document.canonicalOrigin;
  url.searchParams.set("client_id", clientId);
  url.searchParams.set(
    "code_challenge",
    encodeBase64Url(sha256(new TextEncoder().encode(flow.verifier))),
  );
  url.searchParams.set("code_challenge_method", "S256");
  const accountAuthorization = flow.kind === "account";
  const reauthorization = accountAuthorization && flow.reauthorization;
  if (accountAuthorization) url.searchParams.set("prompt", "login");
  if (reauthorization) url.searchParams.set("max_age", "0");
  url.searchParams.set("redirect_uri", flow.callback);
  url.searchParams.set("resource", resource);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(" "));
  url.searchParams.set("state", flow.state);
  if (!isSecureOrLoopbackOrigin(url)) {
    throw new Error("Native authorization must use HTTPS or HTTP loopback.");
  }
  if (url.username || url.password || url.hash || url.toString().length > 8_192) {
    throw new Error("Native authorization URL is invalid.");
  }
  return url.toString();
}

function parseOAuthCallback(
  rawUrl: string,
  oauth: NativeOAuthIdentity,
): {
  readonly callback: string;
  readonly code: string | null;
  readonly error: string | null;
  readonly issuer: string;
  readonly state: string;
} | null {
  if (rawUrl.length > 8_192) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const callback = nativeCallbackIdentity(url);
  if (callback !== oauth.accountCallback && callback !== oauth.hostCallback) {
    return null;
  }
  if (url.username || url.password || url.port || url.hash) return null;
  const allowed = new Set(["code", "error", "error_description", "error_uri", "iss", "state"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const issuer = url.searchParams.get("iss");
  if (!state || !/^[A-Za-z0-9_-]{43,128}$/u.test(state)) return null;
  if (Boolean(code) === Boolean(error)) return null;
  if (code && (code.length > 4_096 || hasAsciiControl(code))) return null;
  if (error && (error.length > 200 || !/^[A-Za-z0-9._-]+$/u.test(error))) return null;
  if (!issuer || issuer.length > 2_048 || hasAsciiControl(issuer)) return null;
  let normalizedIssuer: string;
  try {
    normalizedIssuer = bareServiceOrigin(issuer, "OAuth issuer");
  } catch {
    return null;
  }
  if (issuer !== normalizedIssuer) return null;
  return { callback, code, error, issuer, state };
}

function accountAuthorizationScopes(
  flow: Extract<NativeOAuthFlow, { readonly kind: "account" }>,
): readonly string[] {
  return flow.reauthorization ? opensteerAccountDeleteOAuthScopes : opensteerAccountOAuthScopes;
}

function nativeCallbackIdentity(url: URL): string {
  return `${url.protocol}${url.host ? `//${url.host}` : ""}${url.pathname}`;
}

function tokenCredentialFields(
  response: z.infer<typeof OAuthTokenResponseSchema>,
  refreshToken: string,
  requestedScopes: readonly string[],
  now: Date,
): OAuthCredentialFields {
  const grantedScopes = response.scope
    ? [...new Set(response.scope.split(/\s+/u).filter(Boolean))]
    : [...requestedScopes];
  if (!requestedScopes.every((scope) => grantedScopes.includes(scope))) {
    throw new Error("The authorization server did not grant the required scopes.");
  }
  if (!grantedScopes.every((scope) => requestedScopes.includes(scope))) {
    throw new Error("The authorization server granted more than this request asked for.");
  }
  const updatedAt = now.toISOString();
  return {
    accessToken: response.access_token,
    accessTokenExpiresAt: new Date(now.getTime() + response.expires_in * 1_000).toISOString(),
    grantedScopes,
    refreshToken,
    updatedAt,
  };
}

/** A refusal the person can act on keeps its reason; anything else is the server's trouble. */
function teamExchangeFailure(status: number, body: unknown): Error {
  const error = z.object({ error: HostApiErrorSchema }).safeParse(body);
  const reason = TeamEntryRefusalReasonSchema.safeParse(error.data?.error.reason);
  if (error.success && reason.success)
    return new TeamEntryRefusedError(reason.data, error.data.error.message);
  return new ClientOperationError(
    error.success ? error.data.error.message : hostUnreachableDetail,
    transientHttpStatus(status) ? "transient" : "blocked",
  );
}

function credentialMatchesConnection(
  credential: HostCredential,
  connection: DeploymentConnection,
): boolean {
  return hostAuthorityIdentityMatches(
    connection.authority.document,
    hostKeyFingerprint(connection.authority.publicKey.spki),
    credential,
  );
}

/**
 * Only a team connection reaches Host-native OAuth, and a self-hosted
 * Host is never a Personal stack this client supervises, so its access arm
 * resolves without any live runtime.
 */
function hostAttachmentKey(connection: DeploymentConnection): string {
  return resolveConnection(connection, null, { authorization: null }).key;
}

function newAccountSession(credential: AccountCredential): AccountSession {
  return { controller: new AbortController(), credential };
}

function accountIdentityOf(session: AccountSession | null): {
  readonly email?: string;
  readonly issuer: string;
  readonly subject: ControlPlaneAccountId;
} | null {
  if (!session || session.controller.signal.aborted) return null;
  const { email, issuerOrigin, subject } = session.credential;
  return { ...(email ? { email } : {}), issuer: issuerOrigin, subject };
}

function accountSource(credential: AccountCredential): AccountDeploymentConnectionSource {
  return {
    issuer: credential.issuerOrigin,
    kind: "account",
    subject: credential.subject,
  };
}

/**
 * Reads the identity out of an ID token this client just fetched itself.
 *
 * The token is not signature-verified, and deliberately so: it arrives in the
 * body of a TLS request this client made directly to the pinned token endpoint
 * of the flow's own issuer, with redirects refused, so OIDC Core §3.1.3.7
 * clause 6 applies. Every claim that binds the token to this exact request is
 * still enforced here.
 */
function accountIdentityFromIdToken(input: {
  readonly clientId: string;
  readonly idToken: string;
  readonly issuer: string;
  readonly now: Date;
  /** Flow start, in milliseconds, when the flow demanded a fresh sign-in. */
  readonly reauthorizedAfter: number | null;
}): { readonly email?: string; readonly subject: ControlPlaneAccountId } {
  const segments = input.idToken.split(".");
  if (segments.length !== 3 || !segments[1]) throw new Error("The Account ID token is invalid.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(decodeBase64Url(segments[1]))) as unknown;
  } catch (error) {
    throw new Error("The Account ID token is invalid.", { cause: error });
  }
  const claims = z
    .object({
      aud: z.union([z.string(), z.array(z.string())]),
      auth_time: z.number().int().optional(),
      azp: z.string().optional(),
      email: z.unknown().optional(),
      exp: z.number().int(),
      iss: z.string(),
      sub: ControlPlaneAccountIdSchema,
    })
    .passthrough()
    .parse(decoded);
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
  if (claims.iss !== input.issuer || !audiences.includes(input.clientId)) {
    throw new Error("The Account ID token identity does not match this authorization.");
  }
  if (claims.azp === undefined ? audiences.length > 1 : claims.azp !== input.clientId) {
    throw new Error("The Account ID token was issued for another client.");
  }
  if (claims.exp * 1_000 <= input.now.getTime() + idTokenExpiryHorizonMs) {
    throw new Error("The Account ID token is expired.");
  }
  if (
    input.reauthorizedAfter !== null &&
    claims.auth_time !== undefined &&
    claims.auth_time < Math.floor(input.reauthorizedAfter / 1_000)
  ) {
    throw new Error("The Account did not sign in again for this verification.");
  }
  const email = IdentityEmailSchema.safeParse(claims.email);
  return { ...(email.success ? { email: email.data } : {}), subject: claims.sub };
}

const boundedJsonOptions = {
  emptyError: () => new Error("The authorization server returned an empty response."),
  invalidJsonError: () => new Error("The authorization server returned invalid JSON."),
  maximumBytes: maximumOAuthResponseBytes,
  sizeError: () => new Error("The authorization server response is too large."),
} as const;

function boundedOAuthNetworkTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > defaultOAuthNetworkTimeoutMs) {
    throw new TypeError(
      `OAuth network timeout must be an integer from 1 through ${defaultOAuthNetworkTimeoutMs}.`,
    );
  }
  return value;
}

/**
 * The platform's cryptographic entropy. `globalThis.crypto` is the one source
 * a browser, Node and Hermes all expose, so no entropy port is needed.
 */
function secureRandomBytes(size: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

function nextAuthGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error("Native authorization generation is exhausted.");
  }
  return current + 1;
}

function publicError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/[\r\n]/gu, " ").slice(0, 1_000) || fallback;
}
