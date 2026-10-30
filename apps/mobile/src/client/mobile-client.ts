import { SavedViewCache } from "./saved-view-cache.js";
import type { HostCapability } from "@opensteer/deployment-authority";
import { hostApiVersion, hostKeyFingerprint, isSameHost } from "@opensteer/deployment-authority";
import {
  createMemorySavedViews,
  type ClientLifecycle,
  type SavedViewScope,
} from "@opensteer/client/host";
import { SavedViewPresentation } from "./saved-view-presentation.js";
import {
  AccountBrokeredHostSessions,
  HostSessionExchange,
  HostSessionExchangeError,
  NativeOAuthManager,
  type HostSessionExchangeFailure,
  type HostOAuthState,
  type NativeOAuthIdentity,
  type ProtectedAuthStore,
  type SelectedAttachment,
} from "@opensteer/client/auth";
import {
  AccountDeploymentDirectoryService,
  AccountDirectoryRefreshService,
  DeploymentCatalogStore,
  HostAttachmentFence,
  clientPublicDetail,
  emptyDeploymentCatalog,
  resolveConnection,
  type AccountDeploymentDirectoryUnavailable,
  type DeploymentCatalog,
  type DeploymentConnection,
  type DeploymentConnectionInput,
  type PrivateFilesystem,
} from "@opensteer/client/connections";
import {
  mutationIdempotencyKey,
  type HostClient,
  type SavedViewStore,
} from "@opensteer/client/host";
import {
  parseNativeIntegrationAuthorizationCallback,
  IntegrationAuthorizationAttemptIdSchema,
  IntegrationServerIdSchema,
  type IntegrationAuthorizationStart,
  waitForIntegrationAuthorization,
  type IntegrationAuthorizationStatus,
  type IntegrationOAuthApplicationSource,
} from "@opensteer/client/integrations";
import { DeploymentIdSchema, RequestIdSchema, type DeploymentId } from "@opensteer/core";
import type { DesktopAccountAuthState } from "@opensteer/protocol/desktop";
import { MutationQueue } from "@opensteer/shared/mutationQueue";
import { createHostAuthorization, type HostFetch } from "../platform/host-network.js";
import {
  describeDeploymentRow,
  type DeploymentAttachment,
  type DeploymentRow,
  type HostVerification,
} from "./deployment-rows.js";
import type { HostEpochAgreement, MobileHostPort, MobileHostPortFactory } from "./host-port.js";
import {
  createPersonalSessionStore,
  personalSessionFrom,
  type PersonalSessionStore,
} from "./personal-session-store.js";
import { createDoneShelfFile, type DoneShelfFile } from "./done-shelf-file.js";
import { createSidebarFile, type SidebarFile } from "./sidebar-file.js";
import { createSelectionFile, type SelectionFile } from "./selection-file.js";
import { createSignedOutFile, type SignedOutFile } from "./signed-out-file.js";
import { createThreadDraftStore, type ThreadDraftStore } from "./thread-drafts.js";
import type { SecureRecordStore } from "../platform/secure-record-store.js";
import { createSecureAuthStore } from "../platform/secure-auth-store.js";
import type { IphoneAppsOwner, IphoneAppsStopped } from "../iphone-apps/owner.js";

/**
 * Whether the selected Deployment is attached, and why it is not when it is
 * not. `hostClient` is non-null exactly when `status` is `connected`.
 */
export interface MobileSelection {
  readonly connection: DeploymentConnection | null;
  readonly deploymentId: DeploymentId | null;
  readonly hostClient: HostClient | null;
  readonly row: DeploymentRow | null;
  /** A null id is meaningful only after startup has settled the saved choice. */
  readonly status: "loading" | "ready";
}

export interface MobileClientState {
  readonly account: DesktopAccountAuthState;
  readonly catalog: DeploymentCatalog;
  readonly directory: MobileDirectoryState;
  readonly rows: readonly DeploymentRow[];
  readonly selection: MobileSelection;
  /** The last write to this device's own storage that did not land, in words. */
  readonly storageFailure: string | null;
  readonly savedViewFailure: string | null;
}

export interface MobileDirectoryState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly detail: string | null;
  readonly unavailable: readonly AccountDeploymentDirectoryUnavailable[];
}

export interface MobileClientOptions {
  readonly lifecycle?: ClientLifecycle;
  readonly savedViewStore?: SavedViewStore;
  readonly accountOrigin: string | null;
  readonly catalogFilePath: string;
  readonly doneShelfFilePath: string;
  readonly draftsFilePath: string;
  readonly sidebarFilePath: string;
  readonly fetch: HostFetch;
  /** Everything that reaches a Host: what to present, what to attach, what epoch. */
  readonly hostPort: MobileHostPortFactory;
  /**
   * This iPhone's own apps, which stop with the Deployment that holds them: on
   * signing out of it, removing it, an Account sign-out that takes it away,
   * or any catalog change that drops it.
   */
  readonly iphoneApps?: IphoneAppsOwner;
  readonly now?: () => Date;
  readonly oauthIdentity: NativeOAuthIdentity;
  readonly openAuthorization: (url: string) => Promise<void>;
  readonly openIntegrationAuthorization: (url: string) => Promise<string>;
  readonly privateFiles: PrivateFilesystem;
  readonly randomBytes: (size: number) => Uint8Array;
  readonly records: SecureRecordStore;
  /**
   * Connections the catalog is given once, if it is empty. Mock mode's single
   * row arrives this way so it is seeded inside `initialize`, after protected
   * storage is ready, rather than racing it from the app root.
   */
  readonly seed?: readonly DeploymentConnectionInput[];
  readonly selectionFilePath: string;
  readonly signedOutFilePath: string;
}

/**
 * Everything the phone knows about where work runs, assembled once.
 *
 * There is exactly one Host client, for the one Deployment the person is
 * looking at, and it is created and disposed here — switching Deployments
 * disposes the old one before the new one exists, so two Hosts are never
 * subscribed at the same time. The single exception is signing out of a
 * Deployment that is not the selected one, which opens a client for exactly one
 * command and closes it again; it opens no socket. No screen may construct a
 * client, open a socket, or read a credential: screens read this object's
 * snapshot and call its methods.
 *
 * Which route and which credential an attachment may use is not decided here
 * either. `HostAttachmentFence` is the one resolver every Opensteer client
 * shares, and its monotone generation is what every operation compares itself
 * against across an `await`: a value that still equals `fence.generation`
 * afterwards means the route did not move while the operation was in flight.
 */
export class MobileClient {
  readonly savedViews: SavedViewPresentation;
  readonly #lifecycle: ClientLifecycle | undefined;
  readonly accountDirectory: AccountDeploymentDirectoryService;
  readonly catalog: DeploymentCatalogStore;
  readonly directoryRefresh: AccountDirectoryRefreshService<void>;
  /** Whether the sidebar's Done shelf is open on this phone. */
  readonly doneShelf: DoneShelfFile;
  /** Whether the reader hid the docked sidebar on this phone. */
  readonly sidebar: SidebarFile;
  /** Unsent message text, per Thread, kept where a killed app cannot lose it. */
  readonly drafts: ThreadDraftStore;
  readonly oauth: NativeOAuthManager;
  readonly sessionExchange: HostSessionExchange;
  readonly sessions: PersonalSessionStore;

  readonly #savedViewCache: SavedViewCache;
  readonly #changingLogins = new Set<string>();
  readonly #loginInitializedClients = new WeakSet<HostClient>();
  #attachedViewLoginId: string | undefined;
  #cacheIdentityFailureAttempt: number | null = null;
  readonly #authStore: ProtectedAuthStore;
  readonly #fence: HostAttachmentFence;
  readonly #host: MobileHostPort;
  readonly #iphoneApps: IphoneAppsOwner | null;
  readonly #openIntegrationAuthorization: (url: string) => Promise<string>;
  readonly #listeners = new Set<() => void>();
  /** Selection, reconciliation and sign-out, one at a time and in the order asked. */
  readonly #operations = new MutationQueue();
  readonly #seed: readonly DeploymentConnectionInput[];
  readonly #selectionFile: SelectionFile;
  readonly #signedOutFile: SignedOutFile;
  /** Deployments whose credential is held and usable, as last observed. */
  readonly #credentialed = new Set<string>();
  /** The last automatic session-exchange answer for each selected route. */
  readonly #sessionFailures = new Map<string, HostSessionExchangeFailure>();
  /** Explicit sign-out suppresses silent Connect re-entry until a person clears it. */
  readonly #signedOut = new Set<string>();
  /** What a live verification of each Deployment's resolved route found. */
  readonly #verification = new Map<string, HostVerification>();
  readonly #detach: (() => void)[] = [];

  #accountSubject: string | null = null;
  /** Invalidates authorization work before queued credential cleanup can begin. */
  #authorizationEpoch = 0;
  #directoryGeneration = 0;
  #directoryState: MobileDirectoryState = idleDirectoryState();
  #attachedDeploymentId: DeploymentId | null = null;
  /** The fence generation the open attachment was made against. */
  #attachmentGeneration = -1;
  /**
   * Whether the attached Host refused this phone's credential. A credential
   * this device still holds is not a credential the Host still accepts — a
   * session revoked from a browser leaves the record on the phone untouched —
   * so the Host's own answer overrides the record when the row is drawn.
   */
  #attachmentRefused = false;
  /** What the open attachment is doing, in the word the row shows. */
  #attachmentState: DeploymentAttachment | null = null;
  /** Whether this attachment has ever been connected, which is what "again" means. */
  #attachmentConnected = false;
  /** Invalidates attachment work that crossed an await before a newer local choice. */
  #attachmentAttempt = 0;
  #disposed = false;
  #initialized = false;
  #selectionFileLoaded = false;
  #selectionReady = false;
  /** `undefined` is the one-time, first-launch auto-selection opportunity. */
  #selectionPreference: DeploymentId | null | undefined;
  #hostClient: HostClient | null = null;
  #hostOrigin: string | null = null;
  #hostClientDetach: (() => void) | null = null;
  #storageFailure: string | null = null;
  #state: MobileClientState = {
    account: signedOutAccountState(),
    catalog: emptyDeploymentCatalog(),
    directory: idleDirectoryState(),
    rows: [],
    selection: detachedSelection("loading"),
    storageFailure: null,
    savedViewFailure: null,
  };

  constructor(options: MobileClientOptions) {
    this.#savedViewCache = new SavedViewCache({
      store: options.savedViewStore ?? createMemorySavedViews(),
      files: options.privateFiles,
      directory: `${options.catalogFilePath.slice(0, options.catalogFilePath.lastIndexOf("/"))}/saved-view-denials`,
    });
    this.savedViews = new SavedViewPresentation({
      cache: this.#savedViewCache,
      ...(options.now ? { now: options.now } : {}),
    });
    this.#lifecycle = options.lifecycle;
    if (options.lifecycle)
      this.#detach.push(
        options.lifecycle.onBackground(() => {
          void this.savedViews.flush();
        }),
        options.lifecycle.onNetworkChange((network) =>
          this.savedViews.connection(network, this.#attachmentState === "offline"),
        ),
      );
    this.#detach.push(
      this.#savedViewCache.subscribe(() => {
        const client = this.#hostClient,
          id = this.#attachedDeploymentId;
        // Deletion belongs to a Deployment, so a new selection visit must also
        // regain its cache scope after the shared operation completes.
        if (
          client &&
          id !== null &&
          !this.#savedViewCache.isPending(id) &&
          !this.#changingLogins.has(id)
        )
          void this.#initializeViewLoginIds(client).catch(noop);
        const failure = this.#savedViewCache.getFailure();
        if (failure === this.#state.savedViewFailure) return;
        this.#state = { ...this.#state, savedViewFailure: failure };
        for (const listener of this.#listeners) listener();
      }),
    );
    this.#seed = options.seed ?? [];
    this.#iphoneApps = options.iphoneApps ?? null;
    this.#openIntegrationAuthorization = options.openIntegrationAuthorization;
    this.drafts = createThreadDraftStore({
      filePath: options.draftsFilePath,
      now: options.now ?? (() => new Date()),
      privateFiles: options.privateFiles,
    });
    this.#authStore = createSecureAuthStore(options.records);
    this.sessions = createPersonalSessionStore(options.records, {
      beforeChange: (id) => this.#invalidateSavedView(id),
      changed: (session) => {
        if (
          this.#hostClient !== null &&
          session.deploymentId === this.#attachedDeploymentId &&
          session.viewLoginId !== this.#attachedViewLoginId
        ) {
          void this.#replaceCredentialAttachment(session.deploymentId);
        }
      },
    });
    this.doneShelf = createDoneShelfFile({
      filePath: options.doneShelfFilePath,
      privateFiles: options.privateFiles,
    });
    this.sidebar = createSidebarFile({
      filePath: options.sidebarFilePath,
      privateFiles: options.privateFiles,
    });
    this.#selectionFile = createSelectionFile({
      filePath: options.selectionFilePath,
      privateFiles: options.privateFiles,
    });
    this.#signedOutFile = createSignedOutFile({
      filePath: options.signedOutFilePath,
      privateFiles: options.privateFiles,
    });
    this.catalog = new DeploymentCatalogStore({
      filePath: options.catalogFilePath,
      privateFiles: options.privateFiles,
    });
    const accountSessions = new AccountBrokeredHostSessions({
      catalog: this.catalog,
      clearDeploymentSession: async (deploymentId) => {
        await this.sessions.clear(DeploymentIdSchema.parse(deploymentId));
      },
    });
    this.oauth = new NativeOAuthManager({
      beforeAccountChange: () => this.#invalidateAccountSavedViews(),
      beforeHostChange: (connection) =>
        this.#invalidateSavedView(connection.authority.document.deploymentId),
      accountOrigin: options.accountOrigin,
      accountSessions,
      catalog: this.catalog,
      fetch: (input, init) => options.fetch(input, init),
      oauth: options.oauthIdentity,
      openExternal: options.openAuthorization,
      randomBytes: options.randomBytes,
      store: this.#authStore,
    });
    this.accountDirectory = new AccountDeploymentDirectoryService({
      accountOrigin: options.accountOrigin,
      authorization: this.oauth,
      catalog: this.catalog,
      fetch: (input, init) => options.fetch(input, init),
    });
    this.sessionExchange = new HostSessionExchange({
      account: this.accountDirectory,
      application: options.oauthIdentity.application,
      fetch: (_deploymentId, input, init) => options.fetch(input, init),
    });
    this.directoryRefresh = new AccountDirectoryRefreshService<void>({
      eligible: async () =>
        this.accountDirectory.accountOrigin !== null &&
        (await this.oauth.state()).account.status === "signed-in",
    });
    this.#host = options.hostPort({ oauth: this.oauth, sessions: this.sessions });
    this.#fence = new HostAttachmentFence({
      catalog: this.catalog,
      // Resolve identity and routing before credential refresh can contact a
      // Host. Credentials are requested only after live verification below.
      // A phone never runs the Personal Host it is talking to: the owner arm
      // belongs to the computer at the keyboard.
      localRuntime: { current: async () => null },
    });
    this.#detach.push(
      // The fence decides when a route stopped being the route. Anything held
      // against the old one is released here, before any observer can be handed
      // a request bound to an address that is gone.
      this.#fence.onInvalidated(() => {
        this.#disposeHostClient();
      }),
      this.catalog.subscribe(() => {
        // Every revision is a chance that the place this phone is talking to
        // moved: a rotated Connect route, a Deployment removed, an Account
        // sign-out taking its rows with it.
        void this.#reconcileAttachment();
      }),
      this.oauth.subscribe((state) => {
        const id = this.#attachedDeploymentId;
        if (
          id !== null &&
          state.account.status === "signed-in" &&
          this.#changingLogins.has(id) &&
          this.#state.catalog.deployments.some(
            ({ authority, source }) =>
              authority.document.deploymentId === id && source.kind === "account",
          )
        ) {
          void this.#replaceCredentialAttachment(id);
        }
        void this.#republish();
      }),
      this.oauth.subscribeHostCredentials((state) => {
        void this.#hostCredentialChanged(state);
      }),
      this.directoryRefresh.attach(async () => {
        await this.#syncDirectory();
      }),
    );
  }

  getSnapshot = (): MobileClientState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Loads what is on the device and attaches to the Deployment last used. */
  async initialize(): Promise<void> {
    const [, remembered, signedOut] = await Promise.all([
      this.drafts.load(),
      this.#selectionFile.read(),
      this.#signedOutFile.read(),
    ]);
    for (const deploymentId of signedOut) this.#signedOut.add(deploymentId);
    this.#selectionPreference = remembered;
    this.#selectionFileLoaded = true;
    await this.oauth.initialize();
    this.#initialized = true;
    if (this.#seed.length > 0 && (await this.catalog.load()).deployments.length === 0) {
      for (const connection of this.#seed) await this.catalog.upsertAndSelect(connection);
    }
    await this.oauth.reconcileCatalog();
    await this.#republish();
    if (remembered !== null && remembered !== undefined) {
      // A Deployment this phone no longer holds is an ordinary thing to have
      // remembered — it was removed here, or dropped from the Account — and
      // forgetting it is the answer, not refusing to start.
      const listed = (await this.catalog.load()).deployments.some(
        ({ authority }) => authority.document.deploymentId === remembered,
      );
      if (listed) {
        await this.#operations.run(() => this.#activateSelectionLocally(remembered, false));
      } else {
        await this.deselect();
      }
    } else if (remembered === undefined) {
      await this.#operations.run(async () => {
        const catalog = await this.catalog.load();
        if (catalog.deployments.length === 1) {
          await this.#activateSelectionLocally(
            catalog.deployments[0]!.authority.document.deploymentId,
            true,
          );
        } else if (catalog.deployments.length > 1) {
          await this.#selectionFile.write(null);
          this.#selectionPreference = null;
        }
      });
    }
    this.#selectionReady = true;
    await this.#republish();
    const selected = this.#attachedDeploymentId;
    if (selected !== null) void this.select(selected).catch(noop);
    // Startup waits only for local hydration. An Account directory or Host that
    // is offline is represented in the snapshot; it never holds the splash.
    void this.directoryRefresh.request("account-state");
  }

  /**
   * Attaches to one Deployment. The previous client is disposed first, so the
   * old Host's sockets are closed before the new one's are opened.
   */
  async select(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    await this.#startSelection(id, false);
  }

  /**
   * Opens a Deployment because the person chose it.
   *
   * Unlike `select`, this is allowed to open the system authorization browser
   * for a self-hosted Host. Connect still uses its silent Account-grant
   * exchange, and an explicit open also lifts the persisted sign-out suppression
   * so the person's tap is a real retry.
   */
  async openDeployment(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    const connection = this.#requireConnection(id);
    const row = this.#state.rows.find((candidate) => candidate.deploymentId === id);
    await this.#clearSignOutSuppression(id);
    const force =
      this.#attachedDeploymentId !== id ||
      row === undefined ||
      (row.status !== "connected" && row.status !== "connecting" && row.status !== "reconnecting");
    const outcome = await this.#startSelection(id, force, {
      establishPersonal: connection.kind !== "self-hosted" && row?.signIn === "account-grant",
      requireFreshHostCredential: connection.kind === "self-hosted" && row?.signIn === "host-oauth",
    });
    if (outcome.kind === "session-failed") throw outcome.error;
    if (connection.kind !== "self-hosted" || outcome.kind !== "needs-credential") return;
    await this.#operations.run(async () => {
      if (
        !this.#isCurrentSelection(id, outcome.attempt) ||
        outcome.generation !== this.#fence.generation
      ) {
        return;
      }
      const verification = this.#verification.get(id);
      if (verification !== undefined) return;
      await this.oauth.beginHostSignIn(this.#requireConnection(id));
    });
  }

  /** Re-resolves and rebuilds the selected attachment after an explicit retry. */
  async retrySelection(): Promise<void> {
    const selection = await this.#operations.run(async () => {
      const id = this.#attachedDeploymentId;
      if (id === null) return null;
      const attempt = await this.#selectLocallyNow(id, true);
      return attempt === null ? null : { attempt, id };
    });
    if (selection !== null) await this.#attachSelection(selection.id, selection.attempt);
  }

  /** Returns to the list, releasing the attachment. */
  deselect(): Promise<void> {
    return this.#operations.run(() => this.#deselectNow());
  }

  /**
   * Signs this phone in to one Deployment, by whichever door that Deployment
   * has, and attaches once the credential is held.
   *
   * A self-hosted Host runs its own authorization server, so this hands the
   * person to the system browser and the credential arrives through the
   * registered callback. A Personal computer reached over Opensteer Connect
   * needs nobody at the keyboard: the Account signs a grant for this route and
   * the Host exchanges it for the session this phone keeps. A Personal computer
   * on its own private route needs a pairing code only the operator can carry,
   * which is a different door and not this one.
   */
  async signIn(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    const connection = this.#requireConnection(id);
    const verification = this.#verification.get(id);
    if (verification !== undefined) throw new Error(verificationFailureDetail(verification));
    await this.#clearSignOutSuppression(id);
    this.#sessionFailures.delete(id);
    if (connection.kind === "self-hosted") {
      // The browser adapter waits for callback processing; the credential
      // subscription owns attachment and publishes any authorization failure.
      await this.oauth.beginHostSignIn(connection);
      return;
    }
    const resolved = resolveConnection(connection, null, { authorization: null });
    if (resolved.access !== "connect" || !this.sessionExchange.supports(resolved)) {
      throw new Error("This deployment has no address this phone can sign in to.");
    }
    const outcome = await this.#startSelection(id, true, { establishPersonal: true });
    if (outcome.kind === "session-failed") throw outcome.error;
  }

  /**
   * Signs this phone out of one Deployment, keeping the Deployment itself.
   *
   * The credential is ended where it lives before it is dropped here. A
   * self-hosted Host's revoke ends the session its token hangs from, so the
   * access token dies with the record rather than outliving it; a Personal
   * Deployment's header-delivered session is its own session on that Host and
   * is revoked through the Host's own command. Either way the row comes back
   * saying "Needs sign-in", which is the true state — not "Unavailable", and
   * not a Deployment this phone has forgotten.
   *
   * A revocation that did not happen is not a sign-out. If the Host refuses or
   * cannot be reached the credential stays exactly where it was and the failure
   * is the caller's to show: dropping the record anyway would leave a
   * credential this phone can no longer revoke and that Host still honours.
   */
  signOut(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    this.#authorizationEpoch += 1;
    const invalidation = this.#invalidateSavedView(id);
    const iphone = this.#stopIphoneApps(id);
    return this.#operations.run(async () => {
      try {
        await invalidation;
        if (iphone !== null) await this.#tellHostIphoneStopped(id, iphone);
        await this.#signOutNow(id);
      } catch (error) {
        // A sign-out or removal that did not happen leaves the login and its live
        // attachment in place; the saved view it erased stays erased.
        this.#changingLogins.delete(id);
        await this.#republish();
        throw error;
      }
    });
  }

  /** The pull-to-refresh action: project the Account directory again. */
  async refreshDirectory(): Promise<void> {
    await this.directoryRefresh.refreshNow("renderer");
  }

  /**
   * The app came back to the foreground. A Deployment created on the web or on
   * another device only reaches this phone through a directory sync, and the
   * refresh service's own cooldown is what keeps this from becoming a fetch per
   * app switch.
   */
  async foregrounded(): Promise<void> {
    await this.#savedViewCache.retryInvalidation();
    await this.directoryRefresh.request("app-focus");
    const id = this.#state.selection.deploymentId;
    if (id !== null && this.#hostClient === null && this.#attachmentState === "offline") {
      await this.retrySelection();
    }
  }

  /**
   * Starts provider authorization on the selected Host. The native return only
   * names the durable attempt; this method re-reads that attempt with the
   * phone's Host credential before it can report completion.
   */
  async beginIntegrationAuthorization(input: {
    readonly applicationSource?: IntegrationOAuthApplicationSource;
    readonly definitionId: string;
    readonly returnPath?: string;
    readonly signal?: AbortSignal;
  }): Promise<IntegrationAuthorizationStatus> {
    const deploymentId = this.#attachedDeploymentId;
    const client = this.#hostClient;
    const origin = this.#hostOrigin;
    if (deploymentId === null || client === null || origin === null) {
      throw new Error("Reconnect to this deployment before connecting an integration.");
    }
    const result = await client.dispatch({
      idempotencyKey: mutationIdempotencyKey(`integration-auth:${input.definitionId}`),
      input: {
        ...(input.applicationSource ? { exactApplicationSource: input.applicationSource } : {}),
        definitionId: input.definitionId,
        returnPath: input.returnPath ?? "/",
        surface: "native",
      },
      type: "integration.authorization.begin",
    });
    if (result.type !== "integration.authorization.begin") {
      throw new Error("Integration authorization command mismatch.");
    }
    return this.#finishIntegrationAuthorization({
      result,
      client,
      deploymentId,
      origin,
      signal: input.signal,
    });
  }

  async beginMcpIntegrationAuthorization(input: {
    readonly serverId: string;
    readonly requestId: string;
    readonly displayName: string;
    readonly signal?: AbortSignal;
  }): Promise<IntegrationAuthorizationStatus> {
    const deploymentId = this.#attachedDeploymentId;
    const client = this.#hostClient;
    const origin = this.#hostOrigin;
    if (deploymentId === null || client === null || origin === null) {
      throw new Error("Reconnect to this deployment before connecting an integration.");
    }
    const result = await client.dispatch({
      idempotencyKey: mutationIdempotencyKey(`integration-mcp:${input.serverId}`),
      input: {
        serverId: IntegrationServerIdSchema.parse(input.serverId),
        requestId: RequestIdSchema.parse(input.requestId),
        displayName: input.displayName,
        returnPath: "/",
        surface: "native",
      },
      type: "integration.mcp.authorization.begin",
    });
    if (result.type !== "integration.mcp.authorization.begin") {
      throw new Error("MCP authorization command mismatch.");
    }
    return this.#finishIntegrationAuthorization({
      result,
      client,
      deploymentId,
      origin,
      signal: input.signal,
    });
  }

  async #finishIntegrationAuthorization(input: {
    readonly result: IntegrationAuthorizationStart;
    readonly client: HostClient;
    readonly deploymentId: DeploymentId;
    readonly origin: string;
    readonly signal: AbortSignal | undefined;
  }): Promise<IntegrationAuthorizationStatus> {
    const { result, client, deploymentId, origin } = input;
    const attemptId = IntegrationAuthorizationAttemptIdSchema.parse(result.attemptId);
    const launch = new URL(
      `/v1/integration-authorizations/${encodeURIComponent(attemptId)}/launch`,
      origin,
    );
    launch.searchParams.set("ticket", result.launchTicket);
    const callback = await this.#openIntegrationAuthorization(launch.toString());
    const returned = parseNativeIntegrationAuthorizationCallback(callback);
    if (
      returned === null ||
      returned.deploymentId !== deploymentId ||
      returned.attemptId !== attemptId
    ) {
      throw new Error("The authorization browser returned a different integration attempt.");
    }
    if (this.#hostClient !== client || this.#attachedDeploymentId !== deploymentId) {
      throw new Error("The selected deployment changed during integration authorization.");
    }
    return waitForIntegrationAuthorization({
      attemptId,
      client,
      expiresAt: result.expiresAt,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }

  /**
   * Resumes a warm or cold native return. Selecting the named known Deployment
   * only establishes transport; the attempt remains unreadable without that
   * Deployment's current Host credential and owning user session.
   */
  async handleIntegrationAuthorizationCallback(
    rawUrl: string,
  ): Promise<IntegrationAuthorizationStatus | null> {
    const callback = parseNativeIntegrationAuthorizationCallback(rawUrl);
    if (callback === null) return null;
    const catalog = await this.catalog.load();
    if (
      !catalog.deployments.some(
        ({ authority }) => authority.document.deploymentId === callback.deploymentId,
      )
    ) {
      throw new Error("That integration attempt belongs to an unknown deployment.");
    }
    if (this.#attachedDeploymentId !== callback.deploymentId || this.#hostClient === null) {
      await this.select(callback.deploymentId);
    }
    const client = this.#hostClient;
    if (this.#attachedDeploymentId !== callback.deploymentId || client === null) {
      throw new Error("Reconnect to that deployment to finish integration authorization.");
    }
    return waitForIntegrationAuthorization({ attemptId: callback.attemptId, client });
  }

  async signInAccount(): Promise<void> {
    const result = await this.oauth.beginAccountSignIn();
    if (result.account.status !== "signed-in" || result.account.identity === null) {
      throw new Error(result.account.detail ?? "Opensteer Account sign-in did not complete.");
    }
  }

  /** Account UI unregisters push while its credential is held; saved pixels/keys leave first. */
  clearAccountSavedViews(): Promise<void> {
    this.#authorizationEpoch += 1;
    return this.#invalidateAccountSavedViews();
  }

  signOutAccount(): Promise<void> {
    this.#authorizationEpoch += 1;
    const invalidation = this.#invalidateAccountSavedViews();
    // Decided before anything awaits: only a Deployment the Account lists
    // leaves with it, and this iPhone stops sharing with it at once.
    const enrolled = this.#iphoneApps?.enrolledDeploymentId() ?? null;
    const leaving =
      this.#state.catalog.deployments.find(
        (connection) =>
          connection.source.kind === "account" &&
          connection.authority.document.deploymentId === enrolled,
      )?.authority.document.deploymentId ?? null;
    const iphone = leaving === null ? null : this.#stopIphoneApps(leaving);
    return this.#operations.run(async () => {
      await invalidation;
      if (leaving !== null && iphone !== null) await this.#tellHostIphoneStopped(leaving, iphone);
      const selected = this.#attachedDeploymentId;
      await this.oauth.signOutAccount();
      const catalog = await this.catalog.load();
      if (
        selected !== null &&
        !catalog.deployments.some(({ authority }) => authority.document.deploymentId === selected)
      ) {
        await this.#forgetRemovedSelectionNow();
        return;
      }
      await this.#republish();
    });
  }

  async signInHost(connection: DeploymentConnection): Promise<void> {
    await this.oauth.beginHostSignIn(connection);
  }

  /** Forgets a Deployment this phone added itself. */
  remove(deploymentId: DeploymentId | string): Promise<void> {
    const id = DeploymentIdSchema.parse(deploymentId);
    this.#authorizationEpoch += 1;
    const invalidation = this.#invalidateSavedView(id);
    const iphone = this.#stopIphoneApps(id);
    return this.#operations.run(async () => {
      try {
        await invalidation;
        if (iphone !== null) await this.#tellHostIphoneStopped(id, iphone);
        await this.#removeNow(id);
      } catch (error) {
        // A sign-out or removal that did not happen leaves the login and its live
        // attachment in place; the saved view it erased stays erased.
        this.#changingLogins.delete(id);
        await this.#republish();
        throw error;
      }
    });
  }

  /** Called after a door adds a Deployment, so the list and selection catch up. */
  async reconcile(): Promise<void> {
    await this.oauth.reconcileCatalog();
    const catalog = await this.catalog.load();
    if (catalog.selectedDeploymentId !== null) {
      await this.select(catalog.selectedDeploymentId);
      return;
    }
    await this.#republish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#authorizationEpoch += 1;
    this.#disposed = true;
    this.savedViews.dispose();
    this.#releaseAttachment();
    for (const detach of this.#detach.splice(0)) detach();
    this.oauth.dispose();
    this.#listeners.clear();
  }

  async #startSelection(
    id: DeploymentId,
    force: boolean,
    options: AttachmentOptions = {},
  ): Promise<AttachmentOutcome> {
    const attempt = await this.#operations.run(() => this.#selectLocallyNow(id, force));
    if (attempt !== null) return this.#attachSelection(id, attempt, options);
    if (this.#attachedDeploymentId !== id) return { kind: "superseded" };
    if (this.#hostClient !== null) return { kind: "attached" };
    return { kind: "unroutable" };
  }

  /**
   * Commits and publishes the local choice while holding the mutation queue.
   * Live discovery deliberately happens afterwards: a Host that takes ten
   * seconds to time out must not keep a later explicit switch out of storage.
   */
  async #selectLocallyNow(id: DeploymentId, force: boolean): Promise<number | null> {
    let catalog = await this.catalog.load();
    if (!catalog.deployments.some(({ authority }) => authority.document.deploymentId === id)) {
      throw new Error("That deployment is no longer in this app's list.");
    }
    if (
      !force &&
      this.#attachedDeploymentId === id &&
      catalog.selectedDeploymentId === id &&
      this.#attachmentGeneration === this.#fence.generation
    ) {
      await this.#republish();
      return null;
    }

    // Durable local state lands before the old attachment is released. A file
    // write failure therefore leaves both the catalog and working client alone.
    const previousPreference = this.#selectionPreference;
    await this.#selectionFile.write(id);
    try {
      if (catalog.selectedDeploymentId !== id) await this.catalog.select(id);
    } catch (error) {
      await this.#selectionFile.write(previousPreference ?? null).catch(noop);
      throw error;
    }
    this.#selectionPreference = id;
    this.#selectionFileLoaded = true;
    this.#releaseAttachment();
    this.#attachedDeploymentId = id;
    this.#beginSavedView(
      id,
      this.#attachmentAttempt,
      catalog.deployments.find(({ authority }) => authority.document.deploymentId === id)!,
    );
    await this.#republish();
    return this.#attachmentAttempt;
  }

  /** Resolves and attaches one locally committed choice outside the mutation queue. */
  async #attachSelection(
    id: DeploymentId,
    attempt: number,
    options: AttachmentOptions = {},
  ): Promise<AttachmentOutcome> {
    let catalog: DeploymentCatalog;
    // An external catalog writer can overtake either fence read. Reassert this
    // explicit selection and resolve again; a route and a credential from two
    // different Deployments must never become one attachment.
    while (this.#isCurrentSelection(id, attempt)) {
      let resolution = await this.#resolve(id);
      if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
      if (resolution.kind === "superseded") {
        const restored = await this.#operations.run(async () => {
          if (!this.#isCurrentSelection(id, attempt)) return false;
          catalog = await this.catalog.load();
          if (
            !catalog.deployments.some(({ authority }) => authority.document.deploymentId === id)
          ) {
            await this.#forgetRemovedSelectionNow();
            throw new Error("That deployment is no longer in this app's list.");
          }
          await this.catalog.select(id);
          return true;
        });
        if (!restored) return { kind: "superseded" };
        continue;
      }
      const generation = this.#fence.generation;
      // Recorded even when nothing is attached. Reconciliation can then tell a
      // settled unavailable or signed-out selection from an invalidated route.
      this.#attachmentGeneration = generation;
      if (resolution.kind === "unroutable") {
        await this.#republish();
        return { kind: "unroutable" };
      }
      const verification = await this.#checkProtocolEpoch(
        resolution.selected,
        generation,
        id,
        attempt,
      );
      if (typeof verification === "string") {
        if (verification === "superseded") return { kind: "superseded" };
        if (generation !== this.#fence.generation) continue;
        return verification === "unreachable"
          ? { kind: "unroutable" }
          : { kind: "verification-failed", verification };
      }
      if (
        options.requireFreshHostCredential === true ||
        (this.#changingLogins.has(id) &&
          resolution.selected.connection.kind === "self-hosted" &&
          this.oauth.hostCredentialState(resolution.selected.connection).status !== "signed-in")
      ) {
        await this.#republish();
        return { attempt, generation, kind: "needs-credential" };
      }
      let authorization = await this.#authorizationFor(resolution.selected.connection);
      if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
      resolution = await this.#resolve(id);
      if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
      if (generation !== this.#fence.generation || resolution.kind === "superseded") continue;
      if (resolution.kind === "unroutable") {
        this.#attachmentGeneration = this.#fence.generation;
        await this.#republish();
        return { kind: "unroutable" };
      }
      const selected = resolution.selected;
      const shouldEstablishPersonalSession =
        selected.resolved.access === "connect" &&
        this.sessionExchange.supports(selected.resolved) &&
        !this.#signedOut.has(id) &&
        (authorization === null || options.establishPersonal === true);
      if (shouldEstablishPersonalSession) {
        try {
          const established = await this.#establishPersonalSession(
            selected,
            id,
            attempt,
            generation,
            this.#authorizationEpoch,
          );
          if (!established) {
            if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
            if (generation !== this.#fence.generation) continue;
            await this.#republish();
            return { attempt, generation, kind: "needs-credential" };
          }
          this.#sessionFailures.delete(id);
          authorization = await this.#authorizationFor(selected.connection);
          if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
          if (generation !== this.#fence.generation) continue;
          resolution = await this.#resolve(id);
          if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
          if (generation !== this.#fence.generation || resolution.kind === "superseded") continue;
          if (resolution.kind === "unroutable") {
            this.#attachmentGeneration = this.#fence.generation;
            await this.#republish();
            return { kind: "unroutable" };
          }
        } catch (error) {
          if (!this.#isCurrentSelection(id, attempt)) return { kind: "superseded" };
          if (generation !== this.#fence.generation) continue;
          this.#sessionFailures.set(id, sessionFailureOf(error));
          await this.#republish();
          return { error, kind: "session-failed" };
        }
      }
      if (authorization === null) {
        await this.#republish();
        return { attempt, generation, kind: "needs-credential" };
      }
      this.#sessionFailures.delete(id);
      const attachment = resolution.selected;
      const assertCurrentAttachment = (): void => {
        if (!this.#isCurrentSelection(id, attempt) || generation !== this.#fence.generation)
          throw new Error("Host attachment changed during verification.");
      };
      const attachmentAuthorization = createHostAuthorization(async () => {
        assertCurrentAttachment();
        const value = await this.#authorizationFor(attachment.connection);
        assertCurrentAttachment();
        return value;
      });
      // This evidence belongs only to this attempt and fence generation. A
      // healthy poll cannot observe an upgrade; reconnects and refusals can.
      let evidence: typeof verification | null = verification;
      let verifying: Promise<readonly HostCapability[]> | null = null;
      const viewLoginId = await this.#viewLoginId(attachment.connection);
      if (!this.#isCurrentSelection(id, attempt) || generation !== this.#fence.generation) continue;
      const hostClient = this.#host.attach({
        authorization: {
          current: attachmentAuthorization.current,
          cached: () => {
            assertCurrentAttachment();
            return attachmentAuthorization.cached();
          },
        },
        capabilities: async (options) => {
          assertCurrentAttachment();
          if (options?.revalidate) evidence = null;
          if (!evidence && !verifying) {
            verifying = (async () => {
              const agreement = await this.#checkProtocolEpoch(attachment, generation, id, attempt);
              if (typeof agreement === "string")
                throw new Error(`Host capability verification failed: ${agreement}`);
              assertCurrentAttachment();
              evidence = agreement;
              return agreement.capabilities;
            })().finally(() => {
              verifying = null;
            });
          }
          const capabilities = verifying ? await verifying : evidence!.capabilities;
          assertCurrentAttachment();
          return capabilities;
        },
        connection: attachment.connection,
        origin: attachment.resolved.origin,
      });
      if (generation !== this.#fence.generation || !this.#isCurrentSelection(id, attempt)) {
        hostClient.dispose();
        continue;
      }
      this.#attachedViewLoginId = viewLoginId;
      this.#changingLogins.delete(id);
      this.#hostClient = hostClient;
      this.#hostOrigin = attachment.resolved.origin;
      this.#readAttachment(hostClient);
      this.#hostClientDetach = hostClient.subscribe(() => {
        if (this.#readAttachment(hostClient)) void this.#republish();
      });
      this.savedViews.attach(hostClient);
      await this.#republish();
      if (this.#isCurrentSelection(id, attempt) && this.#hostClient === hostClient) {
        void hostClient.load().catch(noop);
      }
      return { kind: "attached" };
    }
    return { kind: "superseded" };
  }

  async #deselectNow(): Promise<void> {
    await this.#selectionFile.write(null);
    this.savedViews.select(null, null, () => false);
    this.#selectionPreference = null;
    this.#selectionFileLoaded = true;
    this.#releaseAttachment();
    await this.#republish();
  }

  /** Restores the local choice without waiting for discovery or a Host. */
  async #activateSelectionLocally(id: DeploymentId, persist: boolean): Promise<void> {
    const catalog = await this.catalog.load();
    if (!catalog.deployments.some(({ authority }) => authority.document.deploymentId === id)) {
      throw new Error("That deployment is no longer in this app's list.");
    }
    if (catalog.selectedDeploymentId !== id) await this.catalog.select(id);
    if (persist) await this.#selectionFile.write(id);
    this.#selectionPreference = id;
    this.#selectionFileLoaded = true;
    this.#releaseAttachment();
    this.#attachedDeploymentId = id;
  }

  async #signOutNow(id: DeploymentId): Promise<void> {
    const connection = this.#requireConnection(id);
    try {
      if (connection.kind === "self-hosted") await this.oauth.signOutHost(connection);
      else {
        await this.#revokePersonalSession(connection);
        await this.sessions.clear(id);
      }
    } catch (error) {
      await this.#republish();
      throw error;
    }
    this.#signedOut.add(id);
    await this.#signedOutFile.write(this.#signedOutIds());
    this.#sessionFailures.delete(id);
    if (this.#attachedDeploymentId === id) {
      // Signing out keeps the place the person was looking at. The detached row
      // carries the sign-in action, and a later catalog revision must not turn a
      // Connect grant into an accidental automatic sign-in.
      this.#attachmentAttempt += 1;
      this.#disposeHostClient();
      this.#attachmentGeneration = this.#fence.generation;
    }
    await this.#republish();
  }

  async #removeNow(id: DeploymentId): Promise<void> {
    const connection = this.#requireConnection(id);
    try {
      if (connection.kind === "self-hosted") await this.oauth.signOutHost(connection);
      else {
        await this.#revokePersonalSession(connection);
        await this.sessions.clear(id);
      }
    } catch (error) {
      await this.#republish();
      throw error;
    }
    const selected = this.#attachedDeploymentId === id;
    await this.#clearSignOutSuppressionNow(id);
    this.#sessionFailures.delete(id);
    if (selected) {
      await this.#selectionFile.write(null);
      this.#selectionPreference = null;
      this.#selectionFileLoaded = true;
    }
    await this.catalog.remove(id);
    if (selected) {
      this.savedViews.select(null, null, () => false);
      this.#releaseAttachment();
    }
    await this.#republish();
  }

  /** Clears a selected row that disappeared without choosing the catalog fallback. */
  async #forgetRemovedSelectionNow(): Promise<void> {
    const id = this.#attachedDeploymentId;
    if (id !== null) await this.#invalidateSavedView(id);
    this.savedViews.select(null, null, () => false);
    this.#releaseAttachment();
    this.#selectionPreference = null;
    this.#selectionFileLoaded = true;
    try {
      await this.#selectionFile.write(null);
    } finally {
      await this.#republish();
    }
  }

  /** Uses the first-launch opportunity once, after the Account list arrives. */
  #maybeSelectFreshSingleton(): Promise<void> {
    return this.#operations.run(async () => {
      if (
        !this.#selectionFileLoaded ||
        this.#selectionPreference !== undefined ||
        this.#attachedDeploymentId !== null
      ) {
        return;
      }
      const catalog = await this.catalog.load();
      if (catalog.deployments.length === 1) {
        const id = catalog.deployments[0]!.authority.document.deploymentId;
        const attempt = await this.#selectLocallyNow(id, false);
        if (attempt !== null) void this.#attachSelection(id, attempt).catch(noop);
      } else if (catalog.deployments.length > 1) {
        await this.#selectionFile.write(null);
        this.#selectionPreference = null;
      }
    });
  }

  /**
   * The fence's resolution for exactly one Deployment.
   *
   * The fence answers about whatever the catalog selects, and the catalog's
   * selection can move while this is awaiting — an Add door, a deep link, a
   * second selection. A resolution for another Deployment is therefore not an
   * answer about this one at all, and the difference matters: the route and the
   * credential are two halves of one attachment, and pairing a route from one
   * Deployment with a credential from another is how a token reaches a Host it
   * was never issued for.
   */
  async #resolve(deploymentId: DeploymentId): Promise<Resolution> {
    let selected: SelectedAttachment | null = null;
    let unroutable = false;
    try {
      selected = await this.#fence.refresh();
    } catch {
      // A Personal computer with no live route: a state of the row, not a fault
      // to report. The fence has already invalidated whatever was open.
      unroutable = true;
    }
    // Read after the refresh, so a selection that moved during it is seen.
    if ((await this.catalog.load()).selectedDeploymentId !== deploymentId) {
      return { kind: "superseded" };
    }
    if (unroutable || selected === null) return { kind: "unroutable" };
    // Total, and not redundant with the check above: the two reads are separate
    // moments, and only this one is the resolution actually in hand.
    if (selected.resolved.deploymentId !== deploymentId) return { kind: "superseded" };
    return { kind: "resolved", selected };
  }

  /**
   * One Deployment's stored credential changed.
   *
   * `authentication-required` is latched: the Host refused, and the client in
   * hand never asks again. A credential that arrives after that — the person
   * signed in again — therefore reaches the Host only through a new
   * attachment, so the refused one is replaced here. Every other change is an
   * ordinary redraw.
   */
  async #hostCredentialChanged(state: HostOAuthState): Promise<void> {
    const id = state.connection.authority.document.deploymentId;
    if (state.status === "authorizing") {
      // The credential owner calls the invalidation hook before opening UI.
      await this.#republish();
      return;
    }
    if (
      state.status !== "signed-in" ||
      id !== this.#attachedDeploymentId ||
      (!this.#attachmentRefused &&
        this.#hostClient !== null &&
        !this.#changingLogins.has(id) &&
        state.viewLoginId === this.#attachedViewLoginId)
    ) {
      await this.#republish();
      return;
    }
    await this.#replaceCredentialAttachment(id);
  }

  async #replaceCredentialAttachment(id: DeploymentId): Promise<void> {
    try {
      const attempt = await this.#operations.run(async () => {
        if (this.#disposed || id !== this.#attachedDeploymentId) return null;
        return this.#selectLocallyNow(id, true);
      });
      if (attempt !== null) await this.#attachSelection(id, attempt);
    } catch {
      await this.#republish();
    }
  }

  /** Hides synchronously; key deletion precedes revocation and credential cleanup. */
  #invalidateSavedView(id: string): Promise<void> {
    if (this.#attachedDeploymentId === id) this.savedViews.block();
    this.#changingLogins.add(id);
    if (this.#state.selection.deploymentId === id) {
      this.#state = { ...this.#state, selection: { ...this.#state.selection, hostClient: null } };
      for (const listener of this.#listeners) listener();
    }
    return this.#savedViewCache.invalidate(id);
  }

  #invalidateAccountSavedViews(): Promise<void> {
    return Promise.all(
      this.#state.catalog.deployments
        .filter(({ source }) => source.kind === "account")
        .map(({ authority }) => this.#invalidateSavedView(authority.document.deploymentId)),
    ).then(() => undefined);
  }

  #clearSignOutSuppression(id: DeploymentId): Promise<void> {
    return this.#operations.run(() => this.#clearSignOutSuppressionNow(id));
  }

  async #clearSignOutSuppressionNow(id: DeploymentId): Promise<void> {
    if (!this.#signedOut.has(id)) return;
    const remaining = this.#signedOutIds().filter((deploymentId) => deploymentId !== id);
    await this.#signedOutFile.write(remaining);
    this.#signedOut.delete(id);
  }

  #signedOutIds(): DeploymentId[] {
    return [...this.#signedOut].map((deploymentId) => DeploymentIdSchema.parse(deploymentId));
  }

  #disposeHostClient(): void {
    this.savedViews.detach();
    this.#hostClientDetach?.();
    this.#hostClientDetach = null;
    this.#hostClient?.dispose();
    this.#hostClient = null;
    this.#hostOrigin = null;
    this.#attachmentGeneration = -1;
    this.#attachmentRefused = false;
    this.#attachmentState = null;
    this.#attachmentConnected = false;
  }

  #releaseAttachment(): void {
    this.#attachmentAttempt += 1;
    this.#disposeHostClient();
    this.#attachedDeploymentId = null;
  }

  #isCurrentSelection(id: DeploymentId, attempt: number): boolean {
    return (
      !this.#disposed && this.#attachedDeploymentId === id && this.#attachmentAttempt === attempt
    );
  }

  #isCurrentAuthorization(
    id: DeploymentId,
    attempt: number,
    generation: number,
    authorizationEpoch: number,
  ): boolean {
    return (
      authorizationEpoch === this.#authorizationEpoch &&
      generation === this.#fence.generation &&
      this.#isCurrentSelection(id, attempt)
    );
  }

  /**
   * Reads the attachment's own state off the client, and answers whether it
   * changed. "Reconnecting" is not a state a Host client has: it is dialling
   * after having been connected once, which only this side remembers.
   */
  #readAttachment(hostClient: HostClient): boolean {
    const snapshot = hostClient.getSnapshot();
    if (
      snapshot.session === "authenticated" &&
      snapshot.user !== null &&
      !this.#loginInitializedClients.has(hostClient)
    ) {
      this.#loginInitializedClients.add(hostClient);
      void this.#initializeViewLoginIds(hostClient).catch(noop);
    }
    if (snapshot.connection === "connected") this.#attachmentConnected = true;
    const state: DeploymentAttachment =
      snapshot.connection === "connecting"
        ? this.#attachmentConnected
          ? "reconnecting"
          : "connecting"
        : snapshot.connection;
    const refused = snapshot.session === "authentication-required";
    if (refused && !this.#attachmentRefused && this.#attachedDeploymentId !== null)
      void this.#invalidateSavedView(this.#attachedDeploymentId);
    if (state === this.#attachmentState && refused === this.#attachmentRefused) return false;
    this.#attachmentState = state;
    this.#attachmentRefused = refused;
    return true;
  }

  async #viewLoginId(connection: DeploymentConnection): Promise<string | undefined> {
    const id = connection.authority.document.deploymentId,
      attempt = this.#attachmentAttempt;
    try {
      return await this.#host.credentials.viewLoginId?.(connection);
    } catch {
      if (this.#isCurrentSelection(id, attempt)) {
        this.#cacheIdentityFailureAttempt = attempt;
        this.savedViews.block();
      }
      return undefined;
    }
  }

  async #savedScope(connection: DeploymentConnection): Promise<SavedViewScope | null> {
    const id = connection.authority.document.deploymentId;
    if (this.#signedOut.has(id) || !(await this.#host.credentials.held(connection))) return null;
    const loginId = await this.#viewLoginId(connection);
    if (!loginId) return null;
    const identity = connection.authority.document;
    const base = {
      schema: 1 as const,
      epoch: hostApiVersion,
      hostIdentity: {
        deploymentId: identity.deploymentId,
        hostInstanceId: identity.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(connection.authority.publicKey.spki),
      },
      loginId,
    };
    if (connection.source.kind === "manual") return base;
    const account = this.oauth.accountIdentity(),
      accountLoginId = this.oauth.accountViewLoginId();
    if (
      !accountLoginId ||
      !account ||
      account.issuer !== connection.source.issuer ||
      account.subject !== connection.source.subject
    )
      return null;
    return {
      ...base,
      accountSource: { issuer: account.issuer, subject: account.subject, loginId: accountLoginId },
    };
  }

  #beginSavedView(id: DeploymentId, attempt: number, connection: DeploymentConnection): void {
    const epoch = this.#authorizationEpoch;
    let loginId: string | undefined, accountLoginId: string | undefined;
    const current = () =>
      this.#isCurrentSelection(id, attempt) &&
      this.#cacheIdentityFailureAttempt !== attempt &&
      // An unrelated Deployment/Account cleanup cannot suspend this login.
      (this.#authorizationEpoch === epoch || !this.#savedViewCache.isBlocked(id)) &&
      !this.#savedViewCache.isPending(id) &&
      !this.#changingLogins.has(id) &&
      (loginId === undefined ||
        this.#hostClient === null ||
        this.#attachedViewLoginId === loginId) &&
      (accountLoginId === undefined || this.oauth.accountViewLoginId() === accountLoginId);
    this.savedViews.select(id, null, current);
    void this.#savedScope(connection)
      .then((scope) => {
        if (scope === null) return;
        loginId = scope.loginId;
        accountLoginId = scope.accountSource?.loginId;
        if (!current() || this.#savedViewCache.isBlocked(id)) return;
        this.savedViews.load(scope);
      })
      .catch(noop);
  }

  async #initializeViewLoginIds(client: HostClient): Promise<void> {
    const id = this.#attachedDeploymentId;
    if (id === null || this.#cacheIdentityFailureAttempt === this.#attachmentAttempt) return;
    const connection = this.#requireConnection(id);
    const attempt = this.#attachmentAttempt,
      epoch = this.#authorizationEpoch;
    const isCurrent = () =>
      this.#isCurrentSelection(id, attempt) &&
      this.#hostClient === client &&
      this.#cacheIdentityFailureAttempt !== attempt &&
      (this.#authorizationEpoch === epoch || !this.#savedViewCache.isBlocked(id)) &&
      !this.#changingLogins.has(id) &&
      !this.#savedViewCache.isPending(id) &&
      client.getSnapshot().session === "authenticated";
    await this.oauth.initializeViewLoginIds(connection, isCurrent);
    if (!isCurrent()) return;
    if (connection.kind === "personal") await this.sessions.initializeViewLoginId?.(id, isCurrent);
    if (!isCurrent()) return;
    const loginId = await this.#viewLoginId(connection);
    if (!isCurrent()) return;
    this.#attachedViewLoginId = loginId;
    const scope = await this.#savedScope(connection);
    if (isCurrent() && scope) {
      this.#savedViewCache.confirm(id);
      this.savedViews.authorize(
        scope,
        () =>
          isCurrent() &&
          this.#attachedViewLoginId === scope.loginId &&
          (scope.accountSource === undefined ||
            this.oauth.accountViewLoginId() === scope.accountSource.loginId),
      );
    }
  }

  /**
   * Checks the open attachment against what the catalog now says, on every
   * revision.
   *
   * The fence's generation is the whole answer: it is bumped exactly when the
   * resolver's attachment key changes — a rotated Connect route, a preferred
   * endpoint that moved, an authority that went away, a different Deployment
   * selected — so a generation that still matches the one the client was opened
   * against means it is still talking to the same place. Anything else is
   * re-selected, including a catalog whose selection has moved away from the
   * Deployment this phone is attached to: re-selecting writes the app's
   * selection back and resolves it afresh, which is the only way the two ever
   * agree again. A Deployment that is no longer listed at all clears the
   * selection. Nothing here throws: a catalog revision is not a failure.
   */
  #reconcileAttachment(): Promise<void> {
    return this.#operations.run(async () => {
      try {
        const deploymentId = this.#attachedDeploymentId;
        if (deploymentId === null) {
          await this.#republish();
          return;
        }
        const catalog = await this.catalog.load();
        const connection = catalog.deployments.find(
          ({ authority }) => authority.document.deploymentId === deploymentId,
        );
        if (!connection) {
          await this.#forgetRemovedSelectionNow();
          return;
        }
        if (catalog.selectedDeploymentId !== deploymentId) {
          const selected = catalog.deployments.find(
            ({ authority }) => authority.document.deploymentId === catalog.selectedDeploymentId,
          );
          if (selected === undefined) {
            await this.#deselectNow();
            return;
          }
          const id = selected.authority.document.deploymentId;
          const attempt = await this.#selectLocallyNow(id, false);
          if (attempt !== null) void this.#attachSelection(id, attempt).catch(noop);
          return;
        }
        await this.#resolve(deploymentId);
        if (this.#attachmentGeneration === this.#fence.generation) {
          await this.#republish();
          return;
        }
        const attempt = await this.#selectLocallyNow(deploymentId, false);
        if (attempt !== null) void this.#attachSelection(deploymentId, attempt).catch(noop);
      } catch {
        // A revision this release cannot resolve leaves the phone detached and
        // saying so, rather than holding a client for a route that is gone.
        this.#disposeHostClient();
        await this.#republish().catch(() => undefined);
      }
    });
  }

  /**
   * Turns this phone's Account grant into the Host session a Personal Connect
   * Deployment accepts. Answers false when this Deployment has no arm this
   * phone can present — a private route wants a pairing code, which is the
   * other door.
   */
  async #establishPersonalSession(
    selected: SelectedAttachment,
    deploymentId: DeploymentId,
    attempt: number,
    generation: number,
    authorizationEpoch: number,
  ): Promise<boolean> {
    if (
      selected.resolved.access !== "connect" ||
      !this.sessionExchange.supports(selected.resolved)
    ) {
      return false;
    }
    const established = await this.sessionExchange.establish(selected.resolved);
    const session = personalSessionFrom(selected.resolved.deploymentId, established);
    return this.#operations.run(async () => {
      if (!this.#isCurrentAuthorization(deploymentId, attempt, generation, authorizationEpoch)) {
        return false;
      }
      await this.sessions.save(session);
      if (this.#isCurrentAuthorization(deploymentId, attempt, generation, authorizationEpoch)) {
        return true;
      }
      await this.sessions.clear(deploymentId);
      return false;
    });
  }

  /**
   * Ends a Personal Deployment's header-delivered session on the Host that
   * issued it, through that Host's own `session.revoke` for the session this
   * phone is presenting.
   *
   * It throws when the session could not be ended. That is the honest answer: a
   * computer that is asleep has not revoked anything, and telling a person they
   * are signed out while the Host still honours the credential is worse than
   * telling them to try again when it wakes.
   */
  async #revokePersonalSession(connection: DeploymentConnection): Promise<void> {
    const deploymentId = connection.authority.document.deploymentId;
    const authorization = await this.#host.credentials.authorization(connection);
    if (authorization === null) return;
    const attached = this.#attachedDeploymentId === deploymentId ? this.#hostClient : null;
    // One command, over HTTP, on a client that opens no socket — and only when
    // this Deployment is not the attached one, whose client is used as it is.
    const client =
      attached ??
      this.#host.attach({
        authorization: createHostAuthorization(() => this.#authorizationFor(connection)),
        capabilities: null,
        connection,
        origin: resolveConnection(connection, null, { authorization }).origin,
      });
    try {
      const listed = await client.rpc["sessions.list"]({});
      if (!listed.ok) {
        throw new Error(
          listed.error.message || "That deployment would not list this phone's session.",
        );
      }
      // Its own session and no other: this phone is signing itself out, not
      // ending anybody else's access to that computer. A Host that no longer
      // reports one has already ended it, and there is nothing left to revoke.
      const own = listed.data.sessions.find((session) => session.current);
      if (own === undefined) return;
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey("session"),
        sessionId: own.id,
        type: "session.revoke",
      });
    } finally {
      if (client !== attached) client.dispose();
    }
  }

  /** Stops this iPhone's apps when `id` holds them; synchronous, so nothing awaits first. */
  #stopIphoneApps(id: DeploymentId): IphoneAppsStopped | null {
    const owner = this.#iphoneApps;
    return owner !== null && owner.enrolledDeploymentId() === id ? owner.stop() : null;
  }

  /**
   * Tells the Host the iPhone stopped, with this Deployment's credential while
   * it is still held. The owner bounds it and never throws: a Host that cannot
   * be told holds up nothing and undoes nothing.
   */
  async #tellHostIphoneStopped(id: DeploymentId, stopped: IphoneAppsStopped): Promise<void> {
    const owner = this.#iphoneApps;
    if (owner === null) return;
    const connection = this.#state.catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === id,
    );
    const authorization =
      connection === undefined
        ? null
        : await this.#host.credentials.authorization(connection).catch(() => null);
    if (connection === undefined || authorization === null) {
      await owner.tellHost(stopped, null);
      return;
    }
    const attached = this.#attachedDeploymentId === id ? this.#hostClient : null;
    let client: HostClient;
    try {
      client =
        attached ??
        this.#host.attach({
          authorization: createHostAuthorization(() => this.#authorizationFor(connection)),
          capabilities: null,
          connection,
          origin: resolveConnection(connection, null, { authorization }).origin,
        });
    } catch {
      await owner.tellHost(stopped, null);
      return;
    }
    try {
      await owner.tellHost(stopped, (command) => client.dispatch(command));
    } finally {
      if (client !== attached) client.dispose();
    }
  }

  #requireConnection(deploymentId: DeploymentId): DeploymentConnection {
    const connection = this.#state.catalog.deployments.find(
      ({ authority }) => authority.document.deploymentId === deploymentId,
    );
    if (!connection) throw new Error("That deployment is no longer in this app's list.");
    return connection;
  }

  /** The header this Deployment's requests carry, or null when it has none. */
  async #authorizationFor(connection: DeploymentConnection): Promise<string | null> {
    const deploymentId = connection.authority.document.deploymentId;
    const authorization = await this.#host.credentials.authorization(connection);
    if (authorization === null) this.#credentialed.delete(deploymentId);
    else this.#credentialed.add(deploymentId);
    return authorization;
  }

  /**
   * Asks the route the attachment actually uses what it is, and lands the
   * answer only if that route is still the route. A verdict about an address
   * this phone has since stopped using would name a repair for a place nobody
   * is talking to.
   */
  async #checkProtocolEpoch(
    selected: SelectedAttachment,
    generation: number,
    deploymentId: DeploymentId,
    attempt: number,
  ): Promise<ProtocolVerificationOutcome> {
    const agreement = await this.#host.verifyEpoch(selected.resolved, selected.connection);
    if (!this.#isCurrentSelection(deploymentId, attempt) || generation !== this.#fence.generation) {
      return "superseded";
    }
    if (agreement === "unreachable") {
      this.#attachmentState = "offline";
      await this.#republish();
      return "unreachable";
    }
    if (typeof agreement === "string") {
      // Discovery refusal erases saved authority without starting a login change.
      this.savedViews.block();
      void this.#savedViewCache.invalidate(deploymentId);
      this.#verification.set(deploymentId, agreement);
      // Keep the selected Deployment and its repair, but revoke this attachment's
      // transports and authorization, including credential reads already awaiting storage.
      this.#attachmentAttempt += 1;
      this.#disposeHostClient();
      await this.#republish();
      return agreement;
    }
    this.#verification.delete(deploymentId);
    await this.#republish();
    if (!this.#isCurrentSelection(deploymentId, attempt) || generation !== this.#fence.generation) {
      return "superseded";
    }
    return agreement;
  }

  async #republish(): Promise<void> {
    // Nothing can be said about credentials or the Account before protected
    // storage has been read, and a catalog write during startup must not ask.
    if (this.#disposed || !this.#initialized) return;
    const [catalog, account] = await Promise.all([this.catalog.load(), this.oauth.state()]);
    if (catalog.revision < this.#state.catalog.revision) return;
    // Hide a removed/replaced authority before publishing its new catalog context.
    for (const previous of this.#state.catalog.deployments) {
      const id = previous.authority.document.deploymentId;
      const current = catalog.deployments.find(
        ({ authority }) => authority.document.deploymentId === id,
      );
      const sameSource =
        current &&
        previous.source.kind === current.source.kind &&
        (previous.source.kind === "manual" ||
          (current.source.kind === "account" &&
            previous.source.issuer === current.source.issuer &&
            previous.source.subject === current.source.subject));
      if (
        (!current || !isSameHost(previous.authority, current.authority) || !sameSource) &&
        !this.#savedViewCache.isBlocked(id)
      )
        void this.#invalidateSavedView(id);
    }
    // A Deployment that left the catalog takes this iPhone's sharing with it.
    // There is no credential left to tell its Host with.
    const enrolled = this.#iphoneApps?.enrolledDeploymentId() ?? null;
    if (
      enrolled !== null &&
      !catalog.deployments.some(({ authority }) => authority.document.deploymentId === enrolled)
    ) {
      this.#iphoneApps?.stop();
    }
    for (const connection of catalog.deployments) {
      const deploymentId = connection.authority.document.deploymentId;
      // `held` never reaches the network, so drawing the list cannot turn into
      // one token refresh per row.
      if (await this.#host.credentials.held(connection)) this.#credentialed.add(deploymentId);
      else this.#credentialed.delete(deploymentId);
    }
    const attachedId = this.#attachedDeploymentId;
    const rows = catalog.deployments.map((connection) => {
      const deploymentId = connection.authority.document.deploymentId;
      const attached = deploymentId === attachedId;
      return describeDeploymentRow(connection, {
        attachment: attached ? this.#attachmentState : null,
        credentialed:
          this.#credentialed.has(deploymentId) && !(this.#attachmentRefused && attached),
        sessionFailure: attached ? (this.#sessionFailures.get(deploymentId) ?? null) : null,
        verification: this.#verification.get(deploymentId) ?? null,
      });
    });
    const subject = account.account.identity?.subject ?? null;
    const accountChanged = subject !== this.#accountSubject;
    if (accountChanged) {
      this.#setDirectoryIdentity(subject);
      // A sign-in is the one trigger that must not wait out the refresh
      // cooldown: the list is empty until the directory lands, and there is
      // nothing else on the Deployments screen to ask for it.
      if (subject !== null) void this.directoryRefresh.refreshNow("account-state").catch(noop);
    }
    const connection =
      attachedId === null
        ? null
        : (catalog.deployments.find(
            ({ authority }) => authority.document.deploymentId === attachedId,
          ) ?? null);
    const network =
      this.#lifecycle?.getSnapshot().network ??
      this.#hostClient?.getSnapshot().network ??
      "unknown";
    this.savedViews.connection(network, this.#attachmentState === "offline");
    this.#state = {
      account,
      catalog,
      directory: this.#directoryState,
      rows,
      selection: {
        connection,
        deploymentId: attachedId,
        hostClient:
          attachedId !== null && this.#changingLogins.has(attachedId) ? null : this.#hostClient,
        row: rows.find((row) => row.deploymentId === attachedId) ?? null,
        status: this.#selectionReady ? "ready" : "loading",
      },
      storageFailure: this.#storageFailure,
      savedViewFailure: this.#savedViewCache.getFailure(),
    };
    for (const listener of this.#listeners) listener();
  }

  async #syncDirectory(): Promise<void> {
    const before = await this.oauth.state();
    const subject = before.account.identity?.subject ?? null;
    if (subject !== this.#accountSubject) this.#setDirectoryIdentity(subject);
    if (subject === null) {
      await this.#republish();
      // Preserve the refresh service's existing signed-out error while keeping
      // the visible directory state empty and idle.
      await this.accountDirectory.sync();
      return;
    }

    const generation = ++this.#directoryGeneration;
    this.#directoryState = { detail: null, status: "loading", unavailable: [] };
    await this.#republish();
    try {
      const result = await this.accountDirectory.sync();
      await this.oauth.reconcileCatalog();
      const after = await this.oauth.state();
      const afterSubject = after.account.identity?.subject ?? null;
      if (afterSubject !== subject) {
        this.#setDirectoryIdentity(afterSubject);
        await this.#republish();
        return;
      }
      if (this.#disposed || generation !== this.#directoryGeneration) return;
      this.#directoryState = {
        detail: null,
        status: "ready",
        unavailable: result.unavailable,
      };
      await this.#maybeSelectFreshSingleton();
      await this.#republish();
    } catch (error) {
      const after = await this.oauth.state();
      const afterSubject = after.account.identity?.subject ?? null;
      if (afterSubject !== subject) {
        this.#setDirectoryIdentity(afterSubject);
        await this.#republish();
        return;
      }
      if (!this.#disposed && generation === this.#directoryGeneration) {
        this.#directoryState = {
          detail: clientPublicDetail(
            error,
            "This phone could not refresh your Opensteer Account deployments.",
          ),
          status: "error",
          unavailable: [],
        };
        await this.#republish();
      }
      throw error;
    }
  }

  #setDirectoryIdentity(subject: string | null): void {
    this.#accountSubject = subject;
    this.#directoryGeneration += 1;
    this.#directoryState = idleDirectoryState();
  }
}

function noop(): void {
  return undefined;
}

function idleDirectoryState(): MobileDirectoryState {
  return { detail: null, status: "idle", unavailable: [] };
}

/**
 * What one attempt to resolve a Deployment found. `superseded` is not a
 * failure: it says the question was overtaken, and the only safe answer to an
 * overtaken question is to ask it again.
 */
type Resolution =
  | { readonly kind: "resolved"; readonly selected: SelectedAttachment }
  | { readonly kind: "superseded" }
  | { readonly kind: "unroutable" };

interface AttachmentOptions {
  readonly establishPersonal?: boolean;
  readonly requireFreshHostCredential?: boolean;
}

type AttachmentOutcome =
  | { readonly kind: "attached" }
  | { readonly kind: "unroutable" }
  | {
      readonly attempt: number;
      readonly generation: number;
      readonly kind: "needs-credential";
    }
  | { readonly kind: "superseded" }
  | { readonly kind: "verification-failed"; readonly verification: HostVerification }
  | { readonly error: unknown; readonly kind: "session-failed" };

type ProtocolVerificationOutcome = HostEpochAgreement | "superseded";

function sessionFailureOf(error: unknown): HostSessionExchangeFailure {
  return error instanceof HostSessionExchangeError ? error.outcome : "unavailable";
}

function verificationFailureDetail(verification: HostVerification): string {
  switch (verification) {
    case "identity-mismatch":
      return "Sign-in was not started because this address answers as a different deployment.";
    case "host-too-old":
      return "Sign-in was not started because this deployment must be updated first.";
    case "client-too-old":
      return "Sign-in was not started because this app must be updated first.";
  }
}

export function detachedSelection(status: MobileSelection["status"] = "ready"): MobileSelection {
  return { connection: null, deploymentId: null, hostClient: null, row: null, status };
}

function signedOutAccountState(): DesktopAccountAuthState {
  return {
    account: { available: false, detail: null, identity: null, status: "signed-out" },
    schemaVersion: 2,
  };
}

/** The message a screen shows for a failed operation, with nothing leaked. */
export function operationDetail(error: unknown, fallback: string): string {
  return clientPublicDetail(error, fallback);
}
