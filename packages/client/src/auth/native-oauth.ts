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
  type DeploymentId,
} from "@opensteer/core";
import {
  ControlPlaneAccountIdSchema,
  type ControlPlaneAccountId,
} from "@opensteer/control-plane-protocol";
import { hostAuthorityIdentityMatches, hostKeyFingerprint } from "@opensteer/deployment-authority";
import {
  DesktopAccountAuthStateSchema,
  hasAsciiControl,
  type DesktopAccountAuthState,
} from "@opensteer/protocol/desktop";
import { z } from "zod";
import { ClientOperationError, unrefTimer } from "../connections/operation-error.js";
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
const hostUnreachableDetail =
  "This server couldn’t be reached. Check your connection and try again.";
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
      readonly generation: number;
      readonly kind: "host";
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

/**
 * One Account identity: the credential this client holds for it and the
 * capability every Account-derived effect is leased against. The two are
 * swapped as one immutable value, so no reader can observe a credential that
 * disagrees with the signal handed out beside it.
 */
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
  readonly #accountOrigin: string | null;
  readonly #accountSessions: {
    removeAllAccountIdentities(): Promise<void>;
    removeOtherAccountIdentities(source: AccountDeploymentConnectionSource): Promise<void>;
  };
  readonly #catalog: Pick<DeploymentCatalogStore, "load">;
  readonly #fetch: OAuthFetch;
  readonly #accountListeners = new Set<AccountAuthStateListener>();
  readonly #flowExpiries = new Map<string, () => void>();
  readonly #hostListeners = new Set<HostOAuthStateListener>();
  readonly #networkTimeoutMs: number;
  readonly #now: () => Date;
  readonly #oauth: NativeOAuthIdentity;
  readonly #openExternal: (url: string) => Promise<void>;
  readonly #pending = new Map<string, NativeOAuthFlow>();
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #refreshes = new Map<string, Promise<string | null>>();
  readonly #scheduleExpiry: (callback: () => void, delayMilliseconds: number) => () => void;
  readonly #store: ProtectedAuthStore;
  #accountDetail: string | null = null;
  #accountFlowGeneration = 0;
  #accountSession: AccountSession | null = null;
  #pendingAccountWrite: AccountCredential | null = null;
  readonly #pendingHostWrites = new Map<DeploymentId, HostCredential>();
  #hostCredentials: readonly HostCredential[] = [];
  #hostDetails = new Map<string, string>();
  #disposed = false;
  #hostGenerations = new Map<DeploymentId, number>();
  #initialized = false;
  readonly #credentialMutations = new MutationQueue();
  #storageError: string | null = null;

  constructor(options: {
    readonly accountOrigin: URL | string | null;
    readonly accountSessions: {
      removeAllAccountIdentities(): Promise<void>;
      removeOtherAccountIdentities(source: AccountDeploymentConnectionSource): Promise<void>;
    };
    readonly catalog: Pick<DeploymentCatalogStore, "load">;
    readonly fetch?: OAuthFetch;
    readonly now?: () => Date;
    readonly networkTimeoutMs?: number;
    readonly oauth: NativeOAuthIdentity;
    readonly openExternal: (url: string) => Promise<void>;
    readonly randomBytes?: (size: number) => Uint8Array;
    readonly scheduleExpiry?: (callback: () => void, delayMilliseconds: number) => () => void;
    readonly store: ProtectedAuthStore;
  }) {
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
              detail: "Opensteer Account sign-in is disabled in this source build.",
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
      (credential && !credentialMatchesConnection(credential, connection)
        ? "Saved authorization no longer matches this Host identity."
        : null);
    return {
      connection: structuredClone(connection),
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

  async beginAccountSignIn(): Promise<DesktopAccountAuthState> {
    return this.#beginAccountAuthorization(null);
  }

  async beginAccountReauthorization(): Promise<DesktopAccountAuthState> {
    await this.#ensureStorageReady();
    if (this.#accountOrigin === null) {
      throw new Error("Opensteer Account sign-in is disabled in this source build.");
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
    await this.#ensureStorageReady();
    if (this.#accountOrigin === null) {
      throw new Error("Opensteer Account sign-in is disabled in this source build.");
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

  async beginHostSignIn(connectionInput: DeploymentConnection): Promise<HostOAuthState> {
    const connection = structuredClone(connectionInput);
    if (connection.kind !== "self-hosted") {
      throw new Error("Only a self-hosted deployment uses deployment-native OAuth.");
    }
    const deploymentId = connection.authority.document.deploymentId;
    // Claimed before the first await. Protected storage can take long enough
    // for a person to leave the flow, and only this fence sees that boundary.
    const generation = this.#advanceHostGeneration(deploymentId);
    await this.#ensureStorageReady();
    if (this.#hostGeneration(deploymentId) !== generation) {
      return this.hostCredentialState(connection);
    }
    const key = hostAttachmentKey(connection);
    this.#hostDetails.delete(key);
    this.#removePending(
      (flow) => flow.kind === "host" && hostAttachmentKey(flow.connection) === key,
    );
    const flow: NativeOAuthFlow = {
      callback: this.#oauth.hostCallback,
      connection,
      createdAt: this.#now().getTime(),
      generation,
      kind: "host",
      state: this.#newState(),
      verifier: this.#randomValue(64),
    };
    await this.#begin(
      flow,
      hostEndpoints(connection.authority.document.canonicalOrigin),
      opensteerHostOAuthScopes,
    );
    return this.hostCredentialState(connection);
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
    this.#advanceHostGeneration(deploymentId);
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
          ...(identity.email ? { email: identity.email } : {}),
          issuerOrigin: flow.issuerOrigin,
          subject: identity.subject,
        });
        const previousCredential = this.#accountSession?.credential ?? null;
        const committed = await this.#mutateCredentials(async () => {
          if (!this.#isFlowCurrent(flow)) return false;
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
    if (connection.kind !== "self-hosted") return null;
    await this.#retryCredentialWrite(connection.authority.document.deploymentId);
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

  /** Refreshes Host-native OAuth only after the Host returned an actual 401. */
  async recoverHostAuthorization(connection: DeploymentConnection): Promise<boolean> {
    this.#assertStorageReady();
    if (connection.kind !== "self-hosted") return false;
    await this.#retryCredentialWrite(connection.authority.document.deploymentId);
    const credential = this.#hostCredential(connection.authority.document.deploymentId);
    if (!credential || !credentialMatchesConnection(credential, connection)) return false;
    return (await this.#refreshHostCredential(connection, credential)) !== null;
  }

  async #refreshHostCredential(
    connection: DeploymentConnection,
    credential: HostCredential,
  ): Promise<string | null> {
    const deploymentId = connection.authority.document.deploymentId;
    const key = hostAttachmentKey(connection);
    const generation = this.#hostGeneration(deploymentId);
    return this.#serializedRefresh(`host:${deploymentId}:${credential.refreshToken}`, async () => {
      const current = this.#hostCredential(deploymentId);
      if (
        !current ||
        current.refreshToken !== credential.refreshToken ||
        !credentialMatchesConnection(current, connection)
      ) {
        return null;
      }
      const clear = async (): Promise<null> => {
        const cleared = await this.#mutateCredentials(async () => {
          if (
            this.#hostGeneration(deploymentId) !== generation ||
            this.#hostCredential(deploymentId)?.refreshToken !== credential.refreshToken
          ) {
            return false;
          }
          const state = await this.#store.clearHost(deploymentId);
          this.#pendingHostWrites.delete(deploymentId);
          this.#adoptHostCredentials(state.hosts);
          this.#hostDetails.set(key, "Your sign-in to this server expired. Sign in again.");
          return true;
        });
        if (cleared) this.#emitHost(connection);
        return null;
      };
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
        if (error instanceof OAuthGrantRefusedError) return clear();
        throw new ClientOperationError(hostUnreachableDetail, "transient", { cause: error });
      }
      let next: HostCredential;
      try {
        next = HostCredentialSchema.parse({ ...credential, ...refreshed });
      } catch {
        return clear();
      }
      const committed = await this.#mutateCredentials(async () => {
        if (
          this.#hostGeneration(deploymentId) !== generation ||
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
          this.#hostGeneration(deploymentId) !== generation ||
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
    if (!session) return null;
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
      throw new ClientOperationError(accountUnreachableDetail, "transient", { cause: error });
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

  async signOutAccount(): Promise<DesktopAccountAuthState> {
    this.#assertStorageReady();
    this.#removePending((flow) => flow.kind === "account");
    const flowGeneration = this.#advanceAccountFlowGeneration();
    const credential = this.#accountSession?.credential ?? null;
    // The capability dies before any cleanup awaits, so nothing issued during
    // sign-out can outlive the identity it was issued for.
    this.#replaceAccountSession(null);
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
    this.#removePending(
      (flow) =>
        flow.kind === "host" && flow.connection.authority.document.deploymentId === deploymentId,
    );
    const generation = this.#advanceHostGeneration(deploymentId);
    const credential = this.#hostCredential(deploymentId);
    this.#hostCredentials = this.#hostCredentials.filter(
      (candidate) => candidate.deploymentId !== deploymentId,
    );
    this.#pendingHostWrites.delete(deploymentId);
    this.#hostDetails.delete(key);
    await this.#mutateCredentials(async () => {
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
        if (
          this.#hostGeneration(deploymentId) === generation &&
          !this.#hostCredential(deploymentId)
        ) {
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
      this.#advanceHostGeneration(credential.deploymentId);
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
    this.#replaceAccountSession(null);
    for (const credential of this.#hostCredentials) {
      this.#advanceHostGeneration(credential.deploymentId);
    }
    for (const cancel of this.#flowExpiries.values()) cancel();
    this.#flowExpiries.clear();
    this.#pending.clear();
    this.#refreshes.clear();
    this.#hostCredentials = [];
    this.#pendingHostWrites.clear();
    this.#accountListeners.clear();
    this.#hostListeners.clear();
  }

  async #begin(
    flow: NativeOAuthFlow,
    endpoints: OAuthEndpoints,
    scopes: readonly string[],
  ): Promise<void> {
    this.#pending.set(flow.state, flow);
    if (flow.kind === "host") this.#armHostFlowExpiry(flow);
    if (flow.kind === "account") await this.#emitAccount();
    else this.#emitHost(flow.connection);
    try {
      const authorization = authorizationUrl(endpoints, flow, scopes, this.#oauth.clientId);
      await this.#openExternal(authorization);
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
    // RFC 6749 §5.2 answers a refused grant with 400, or 401 for the client.
    if (response.status === 400 || response.status === 401) {
      throw new OAuthGrantRefusedError("The authorization server rejected the token exchange.");
    }
    throw new ClientOperationError(
      "The authorization server could not complete the token exchange.",
      "transient",
    );
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
        },
        method: "POST",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
      if (response.redirected || (response.url !== "" && response.url !== endpoint)) {
        throw new Error("The authorization server endpoint redirected.");
      }
      if (acceptJson && response.ok) {
        const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
        if (contentType !== "application/json") {
          await response.body?.cancel();
          throw new Error("The authorization server did not return application/json.");
        }
        return {
          body: await readBoundedJson(response, boundedJsonOptions),
          ok: true,
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

  /**
   * The one synchronous mutator of Account identity. The field is swapped
   * before the outgoing capability is aborted, and the outgoing capability
   * survives only when the incoming session carries it forward, which is
   * exactly a refresh of the same identity.
   */
  #replaceAccountSession(next: AccountSession | null): void {
    const previous = this.#accountSession;
    this.#accountSession = next;
    if (this.#pendingAccountWrite !== next?.credential) this.#pendingAccountWrite = null;
    if (previous && previous.controller !== next?.controller) {
      previous.controller.abort(new Error("The Account authorization changed."));
    }
  }

  /** Adopts persisted credentials, replacing whatever the process held. */
  #adoptProtectedState(state: ProtectedAuthState): void {
    this.#hostCredentials = state.hosts;
    this.#replaceAccountSession(
      state.account && state.account.issuerOrigin === this.#accountOrigin
        ? newAccountSession(state.account)
        : null,
    );
  }

  /** Ends one Account session locally after its authorization stopped working. */
  async #expireAccountSession(session: AccountSession, detail: string): Promise<void> {
    if (this.#accountSession !== session) return;
    this.#replaceAccountSession(null);
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

  #hostCredential(deploymentId: DeploymentId | string): HostCredential | undefined {
    return this.#hostCredentials.find((candidate) => candidate.deploymentId === deploymentId);
  }

  #hostGeneration(deploymentId: DeploymentId): number {
    return this.#hostGenerations.get(deploymentId) ?? 0;
  }

  #advanceHostGeneration(deploymentId: DeploymentId): number {
    const next = nextAuthGeneration(this.#hostGeneration(deploymentId));
    this.#hostGenerations.set(deploymentId, next);
    return next;
  }

  #isFlowCurrent(flow: NativeOAuthFlow): boolean {
    if (this.#disposed) return false;
    return flow.kind === "account"
      ? flow.generation === this.#accountFlowGeneration
      : flow.generation === this.#hostGeneration(flow.connection.authority.document.deploymentId);
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
 * Only a self-hosted connection reaches Host-native OAuth, and a self-hosted
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
  if (!session) return null;
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
