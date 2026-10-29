import { DeploymentIdSchema } from "@opensteer/core";
import type { HostBootstrapMethod } from "@opensteer/deployment-authority";
import { AccountRequestError } from "../connections/account-deployment-directory.js";
import type {
  DeploymentCatalogStore,
  AccountDeploymentConnectionSource,
  DeploymentConnection,
} from "../connections/deployment-catalog.js";
import {
  describeConnectionAccess,
  type ResolvedConnection,
} from "../connections/connection-resolver.js";
import { ClientOperationError, clientPublicDetail } from "../connections/operation-error.js";
import {
  credentialKindFor,
  HostSessionExchangeError,
  type HostSessionExchange,
} from "./host-session-exchange.js";
import type { HostOAuthState, NativeOAuthManager } from "./native-oauth.js";

const defaultRecoveryCooldownMs = 30_000;

type AccountBrokeredSessionListener = (deploymentIds: readonly string[]) => void;

/**
 * Owns destructive lifecycle changes for Host sessions brokered by one Account
 * identity. The signed catalog connection method is durable provenance, so
 * cleanup remains correct after an app restart without an in-memory cache.
 */
export class AccountBrokeredHostSessions {
  readonly #catalog: Pick<DeploymentCatalogStore, "load" | "removeAccountDeployments">;
  readonly #clearDeploymentSession: (deploymentId: string) => Promise<void>;
  readonly #listeners = new Set<AccountBrokeredSessionListener>();

  constructor(options: {
    readonly catalog: Pick<DeploymentCatalogStore, "load" | "removeAccountDeployments">;
    readonly clearDeploymentSession: (deploymentId: string) => Promise<void>;
  }) {
    this.#catalog = options.catalog;
    this.#clearDeploymentSession = options.clearDeploymentSession;
  }

  subscribe(listener: AccountBrokeredSessionListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async removeAllAccountIdentities(): Promise<void> {
    for (const source of await this.#accountSources()) await this.removeAccountIdentity(source);
  }

  async removeOtherAccountIdentities(next: AccountDeploymentConnectionSource): Promise<void> {
    for (const source of await this.#accountSources()) {
      if (source.issuer === next.issuer && source.subject === next.subject) continue;
      await this.removeAccountIdentity(source);
    }
  }

  async removeAccountIdentity(source: AccountDeploymentConnectionSource): Promise<void> {
    const catalog = await this.#catalog.load();
    const deploymentIds = catalog.deployments
      .filter(
        (connection) =>
          connection.source.kind === "account" &&
          connection.source.issuer === source.issuer &&
          connection.source.subject === source.subject &&
          accountConnectGrantSession(connection),
      )
      .map(({ authority }) => authority.document.deploymentId);
    await Promise.all(
      deploymentIds.map((deploymentId) => this.#clearDeploymentSession(deploymentId)),
    );
    await this.#catalog.removeAccountDeployments(source);
    if (deploymentIds.length === 0) return;
    for (const listener of this.#listeners) {
      try {
        listener(deploymentIds);
      } catch {
        // Cleanup is authoritative even if an observer is already gone.
      }
    }
  }

  async #accountSources(): Promise<readonly AccountDeploymentConnectionSource[]> {
    const catalog = await this.#catalog.load();
    const sources = new Map<string, AccountDeploymentConnectionSource>();
    for (const connection of catalog.deployments) {
      if (connection.source.kind !== "account") continue;
      const source = connection.source;
      sources.set(`${source.issuer}\u0000${source.subject}`, source);
    }
    return [...sources.values()];
  }
}

export type HostSessionOutcome = "authorizing" | "blocked" | "needs-sign-in" | "ready";

export interface HostSessionObservation {
  readonly attachmentKey: string;
  readonly deploymentId: string;
  readonly detail?: string;
  readonly outcome: HostSessionOutcome;
}

export type HostSessionRecoveryOutcome =
  "account-required" | "blocked" | "pairing-required" | "recovered" | "unavailable" | "unsupported";

export interface HostSessionRecovery {
  recoverUnauthorized(attachment: SelectedAttachment): Promise<HostSessionRecoveryOutcome>;
}

/**
 * The transport's cached resolution of the selected Deployment. Reading it is
 * how this class stays out of the routing decision entirely — and how
 * `#isCurrent` stopped loading the catalog file on every call.
 */
export interface SelectedAttachment {
  readonly connection: DeploymentConnection;
  readonly resolved: ResolvedConnection;
}

export interface HostAttachment {
  current(): Promise<SelectedAttachment>;
  currentKey(): string | null;
}

type HostOAuth = Pick<
  NativeOAuthManager,
  | "abandonHostSignIn"
  | "beginHostSignIn"
  | "hostCredentialState"
  | "recoverHostAuthorization"
  | "signOutHost"
  | "subscribeHostCredentials"
>;

/**
 * The machine that runs a Personal Host owns its session directly, with no
 * credential to exchange. Only a supervisor that actually launched the Host
 * can answer this, so the application supplies it; a phone never does.
 */
export interface LocalOwnerSession {
  ownsHostSession(resolved: Pick<ResolvedConnection, "access">): boolean;
  recoverOwnerSession(resolved: Pick<ResolvedConnection, "access">): Promise<boolean>;
}

type HostSessionListener = (observation: HostSessionObservation) => void;

/**
 * Owns Host-session truth for every attachment method.
 *
 * Account OAuth deliberately is not part of this interface. Account grants are
 * only one way to establish a Host-local session; once established, the Host
 * session remains valid independently of Account credential refreshes.
 */
export class HostSession implements HostSessionRecovery {
  readonly #abandonEpochs = new Map<string, number>();
  readonly #accountCredentialRejected: () => void | Promise<void>;
  readonly #attachment: HostAttachment;
  readonly #attemptDeployments = new Map<string, string>();
  readonly #clearDeploymentSession: (deploymentId: string) => Promise<void>;
  readonly #establishments = new Map<string, Promise<HostSessionObservation>>();
  readonly #exchange: Pick<HostSessionExchange, "establish" | "probe" | "supports">;
  readonly #listeners = new Set<HostSessionListener>();
  readonly #localOwner: LocalOwnerSession;
  readonly #now: () => number;
  readonly #oauth: HostOAuth;
  readonly #recoveries = new Map<string, Promise<HostSessionRecoveryOutcome>>();
  readonly #recoveryCooldownMs: number;
  readonly #recoveryFailures = new Map<
    string,
    { readonly at: number; readonly outcome: HostSessionRecoveryOutcome }
  >();
  readonly #unsubscribeOAuth: () => void;
  #disposed = false;

  constructor(options: {
    readonly accountCredentialRejected?: () => void | Promise<void>;
    readonly attachment: HostAttachment;
    readonly clearDeploymentSession: (deploymentId: string) => Promise<void>;
    readonly exchange: Pick<HostSessionExchange, "establish" | "probe" | "supports">;
    readonly localOwner: LocalOwnerSession;
    readonly now?: () => number;
    readonly oauth: HostOAuth;
    readonly recoveryCooldownMs?: number;
  }) {
    this.#accountCredentialRejected = options.accountCredentialRejected ?? (() => undefined);
    this.#attachment = options.attachment;
    this.#clearDeploymentSession = options.clearDeploymentSession;
    this.#exchange = options.exchange;
    this.#localOwner = options.localOwner;
    this.#now = options.now ?? Date.now;
    this.#oauth = options.oauth;
    this.#recoveryCooldownMs = boundedRecoveryCooldown(
      options.recoveryCooldownMs ?? defaultRecoveryCooldownMs,
    );
    this.#unsubscribeOAuth = options.oauth.subscribeHostCredentials((state) => {
      this.#publishOAuthStateIfCurrent(state);
    });
  }

  subscribe(listener: HostSessionListener): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Drops every live attempt and pending browser flow for one Deployment. */
  abandonAuthorization(deploymentId: string): void {
    this.#assertActive();
    this.#abandonEpochs.set(deploymentId, this.#abandonEpoch(deploymentId) + 1);
    for (const [key, owner] of this.#attemptDeployments) {
      if (owner !== deploymentId) continue;
      this.#establishments.delete(key);
      this.#recoveries.delete(key);
      this.#recoveryFailures.delete(key);
      this.#attemptDeployments.delete(key);
    }
    this.#oauth.abandonHostSignIn(DeploymentIdSchema.parse(deploymentId));
  }

  async establish(deploymentId: string): Promise<HostSessionObservation> {
    this.#assertActive();
    const epoch = this.#abandonEpoch(deploymentId);
    const attachment = await this.#attachment.current();
    if (attachment.resolved.deploymentId !== deploymentId) {
      throw new Error("The selected deployment changed before access was established.");
    }
    const key = attachment.resolved.key;
    const existing = this.#establishments.get(key);
    if (existing) return existing;
    const activeRecovery = this.#recoveries.get(key);
    const establishment = (
      activeRecovery
        ? activeRecovery.then((outcome) => observationFromRecovery(attachment.resolved, outcome))
        : this.#establishExact(attachment, epoch)
    ).then((observation) => {
      this.#assertCurrent(key);
      if (this.#abandonEpoch(deploymentId) === epoch) this.#publish(observation);
      return observation;
    });
    this.#establishments.set(key, establishment);
    this.#attemptDeployments.set(key, deploymentId);
    try {
      return await establishment;
    } finally {
      if (this.#establishments.get(key) === establishment) this.#establishments.delete(key);
      this.#forgetIdleKey(key);
    }
  }

  async recoverUnauthorized(attachment: SelectedAttachment): Promise<HostSessionRecoveryOutcome> {
    this.#assertActive();
    const key = attachment.resolved.key;
    const existing = this.#recoveries.get(key);
    if (existing) return existing;
    const establishment = this.#establishments.get(key);
    if (establishment) {
      return establishment.then(
        (observation) => recoveryFromObservation(attachment.resolved, observation),
        (error: unknown) => recoveryFailure(error),
      );
    }
    const failure = this.#recoveryFailures.get(key);
    if (failure && this.#now() - failure.at < this.#recoveryCooldownMs) return failure.outcome;
    const recovery = (async () => {
      if (!this.#isCurrent(key)) return "unavailable" as const;
      const recovered = await this.#recoverExact(attachment);
      return recovered === "recovered" && !this.#isCurrent(key)
        ? ("unavailable" as const)
        : recovered;
    })().then((outcome) => {
      if (outcome === "recovered") {
        this.#recoveryFailures.delete(key);
      } else {
        this.#recoveryFailures.set(key, { at: this.#now(), outcome });
      }
      return outcome;
    });
    this.#recoveries.set(key, recovery);
    this.#attemptDeployments.set(key, attachment.resolved.deploymentId);
    try {
      return await recovery;
    } finally {
      if (this.#recoveries.get(key) === recovery) this.#recoveries.delete(key);
      this.#forgetIdleKey(key);
    }
  }

  async signOut(attachment: SelectedAttachment): Promise<void> {
    this.#assertActive();
    await this.#clearDeploymentSession(attachment.resolved.deploymentId);
    if (supportsHostNativeSignIn(attachment.resolved.bootstrapMethods)) {
      await this.#oauth.signOutHost(attachment.connection);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeOAuth();
    this.#listeners.clear();
    this.#establishments.clear();
    this.#recoveries.clear();
    this.#recoveryFailures.clear();
    this.#attemptDeployments.clear();
  }

  #abandonEpoch(deploymentId: string): number {
    return this.#abandonEpochs.get(deploymentId) ?? 0;
  }

  #forgetIdleKey(key: string): void {
    if (this.#establishments.has(key) || this.#recoveries.has(key)) return;
    this.#attemptDeployments.delete(key);
  }

  /**
   * One decision, three outcomes, taken from the resolved access arm rather
   * than by probing each possibility in turn: this machine already owns the
   * session, the attachment presents a credential to the one session-exchange
   * contract, or the Host signs the person in itself.
   */
  async #establishExact(
    attachment: SelectedAttachment,
    epoch: number,
  ): Promise<HostSessionObservation> {
    const { connection, resolved } = attachment;
    if (resolved.access === "owner") {
      if (this.#localOwner.ownsHostSession(resolved)) return observation(resolved, "ready");
      throw new HostSessionError(
        "unavailable",
        "That computer isn’t reachable from here. Turn on Remote access on it.",
      );
    }

    if (this.#exchange.supports(resolved)) {
      try {
        const probe = await this.#exchange.probe(resolved);
        if (probe === "authenticated") return observation(resolved, "ready");
        if (probe === "blocked") {
          return observation(
            resolved,
            "blocked",
            "This deployment no longer admits this connection.",
          );
        }
        await this.#exchange.establish(resolved);
        return observation(resolved, "ready");
      } catch (error) {
        return this.#establishmentFailure(resolved, error);
      }
    }

    if (supportsHostNativeSignIn(resolved.bootstrapMethods)) {
      const before = this.#oauth.hostCredentialState(connection);
      if (before.status === "signed-in") return observation(resolved, "ready");
      if (before.status === "authorizing") {
        return observation(resolved, "authorizing", before.detail ?? undefined);
      }
      if (this.#abandonEpoch(resolved.deploymentId) !== epoch) {
        throw new HostSessionError(
          "unavailable",
          "This deployment's sign-in was stopped before it opened.",
        );
      }
      return oauthObservation(await this.#oauth.beginHostSignIn(connection));
    }

    throw new HostSessionError(
      "unavailable",
      "That computer isn’t reachable from here. Turn on Remote access on it.",
    );
  }

  async #recoverExact(attachment: SelectedAttachment): Promise<HostSessionRecoveryOutcome> {
    const { connection, resolved } = attachment;
    try {
      if (resolved.access === "owner") {
        return (await this.#localOwner.recoverOwnerSession(resolved)) ? "recovered" : "unavailable";
      }
      if (this.#exchange.supports(resolved)) {
        await this.#exchange.establish(resolved);
        return "recovered";
      }
      if (supportsHostNativeSignIn(resolved.bootstrapMethods)) {
        return (await this.#oauth.recoverHostAuthorization(connection))
          ? "recovered"
          : "account-required";
      }
      return "unsupported";
    } catch (error) {
      return recoveryFailure(error);
    }
  }

  #establishmentFailure(resolved: ResolvedConnection, error: unknown): HostSessionObservation {
    const failure = recoveryFailure(error);
    if (failure === "pairing-required") {
      return observation(resolved, "needs-sign-in", "Enter a new pairing code from that computer.");
    }
    if (failure === "account-required") {
      void Promise.resolve(this.#accountCredentialRejected()).catch(() => undefined);
      return observation(
        resolved,
        "needs-sign-in",
        "Sign in to your Opensteer account again to reconnect.",
      );
    }
    if (failure === "blocked") {
      return observation(
        resolved,
        "blocked",
        clientPublicDetail(error, "This connection was refused."),
      );
    }
    throw new HostSessionError(
      "unavailable",
      clientPublicDetail(error, "This deployment is temporarily unavailable."),
      { cause: error },
    );
  }

  #publishOAuthStateIfCurrent(state: HostOAuthState): void {
    if (this.#disposed || !this.#isCurrent(state.key)) return;
    this.#publish(oauthObservation(state));
  }

  #publish(observation: HostSessionObservation): void {
    for (const listener of this.#listeners) {
      try {
        listener(observation);
      } catch {
        // A consumer can disappear between observation and delivery.
      }
    }
  }

  #assertCurrent(key: string): void {
    if (!this.#isCurrent(key)) {
      throw new Error(
        "The selected deployment’s connection changed before authorization completed.",
      );
    }
  }

  #isCurrent(key: string): boolean {
    return this.#attachment.currentKey() === key;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("These Host sessions are disposed.");
  }
}

export class HostSessionError extends ClientOperationError {
  readonly code: HostSessionRecoveryOutcome;

  constructor(code: HostSessionRecoveryOutcome, message: string, options?: ErrorOptions) {
    // Only an unreachable Host can become reachable again on its own; every
    // other outcome needs the operator to change something first.
    super(message, code === "unavailable" ? "transient" : "blocked", options);
    this.name = "HostSessionError";
    this.code = code;
  }
}

function observation(
  attachment: { readonly deploymentId: string; readonly key: string },
  outcome: HostSessionOutcome,
  detail?: string,
): HostSessionObservation {
  return {
    attachmentKey: attachment.key,
    deploymentId: attachment.deploymentId,
    ...(detail ? { detail } : {}),
    outcome,
  };
}

function oauthObservation(state: HostOAuthState): HostSessionObservation {
  const target = {
    deploymentId: state.connection.authority.document.deploymentId,
    key: state.key,
  };
  if (state.status === "signed-in") return observation(target, "ready");
  if (state.status === "authorizing") {
    return observation(target, "authorizing", state.detail ?? undefined);
  }
  return observation(
    target,
    "needs-sign-in",
    state.detail ?? "Sign in to this server to continue.",
  );
}

function observationFromRecovery(
  resolved: ResolvedConnection,
  outcome: HostSessionRecoveryOutcome,
): HostSessionObservation {
  if (outcome === "recovered") return observation(resolved, "ready");
  if (outcome === "blocked") {
    return observation(resolved, "blocked", "This connection was refused.");
  }
  if (outcome === "pairing-required") {
    return observation(resolved, "needs-sign-in", "Enter a new pairing code from that computer.");
  }
  if (outcome === "account-required") {
    return observation(
      resolved,
      "needs-sign-in",
      supportsHostNativeSignIn(resolved.bootstrapMethods)
        ? "Sign in to this server to continue."
        : "Sign in to your Opensteer account again to reconnect.",
    );
  }
  throw new HostSessionError("unavailable", "This deployment is temporarily unavailable.");
}

function supportsHostNativeSignIn(bootstrapMethods: readonly HostBootstrapMethod[]): boolean {
  return bootstrapMethods.some((method) => method === "password" || method === "oidc");
}

/**
 * Whether removing an Account identity must also close this row's Host
 * session. Decided without a live runtime: an Account-brokered session belongs
 * to the Connect route, never to the computer that happens to supervise it.
 */
function accountConnectGrantSession(connection: DeploymentConnection): boolean {
  let access;
  try {
    access = describeConnectionAccess(connection, null).access;
  } catch {
    return false;
  }
  return (
    access !== null &&
    credentialKindFor(access, connection.bootstrapMethods) === "account-connect-grant"
  );
}

function recoveryFromObservation(
  resolved: ResolvedConnection,
  observation: HostSessionObservation,
): HostSessionRecoveryOutcome {
  if (observation.outcome === "ready") return "recovered";
  if (observation.outcome === "blocked") return "blocked";
  if (
    observation.outcome === "needs-sign-in" &&
    credentialKindFor(resolved.access, resolved.bootstrapMethods) === "personal-pairing-code"
  ) {
    return "pairing-required";
  }
  return observation.outcome === "authorizing" || observation.outcome === "needs-sign-in"
    ? "account-required"
    : "unavailable";
}

function recoveryFailure(error: unknown): HostSessionRecoveryOutcome {
  if (error instanceof HostSessionExchangeError) return error.outcome;
  if (error instanceof AccountRequestError) {
    if (error.status === 401) return "account-required";
    if (error.status === 403 || error.status === 404) return "blocked";
  }
  return "unavailable";
}

function boundedRecoveryCooldown(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new TypeError("Host session recovery cooldown is invalid.");
  }
  return value;
}
