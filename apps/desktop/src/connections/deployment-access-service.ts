import {
  deploymentStatusFromPersonalStack,
  deploymentStatusSelectable,
  placeStatus,
} from "@opensteer/protocol/deployment-status";
import {
  DeploymentAccessSnapshotSchema,
  type DeploymentAccessFailure,
  type DeploymentAccessSnapshot,
  type DeploymentAccessUnavailable,
  type DeploymentConnectionAction,
  type DeploymentStatusInfo,
  type DesktopAccountAuthState,
  type DesktopAddDirectRouteInput,
  type DesktopConnectPrivateDeploymentInput,
  type DesktopPersonalAccountLinkStatus,
  type DesktopPersonalDeploymentStatus,
} from "@opensteer/protocol/desktop";
import {
  ConnectionSupervisor,
  detachedStatus,
  type ConnectionSupervisorSnapshot,
} from "./connection-supervisor.js";
import { classifyClientFailure, clientPublicDetail } from "@opensteer/client/connections";
import type { CatalogProjection, DeploymentAccessCatalogDeployment } from "./access-projection.js";
import type { HostSessionObservation } from "@opensteer/client/auth";

export type { CatalogProjection, DeploymentAccessCatalogDeployment } from "./access-projection.js";

type DeploymentAccessFailureClassification = "blocked" | "transient";

export interface ClassifiedDeploymentAccessFailure {
  readonly classification: DeploymentAccessFailureClassification;
  readonly code: string;
  readonly detail: string;
}

interface AccountPort {
  readonly available: boolean;
  beginReauthorization(): Promise<DesktopAccountAuthState>;
  beginSignIn(): Promise<DesktopAccountAuthState>;
  currentState(): Promise<DesktopAccountAuthState>;
  signOut(): Promise<DesktopAccountAuthState>;
  subscribe(listener: (state: DesktopAccountAuthState) => void): () => void;
}

interface DirectorySyncOutcome {
  readonly changed: boolean;
  readonly unavailable: readonly DeploymentAccessUnavailable[];
}

export interface DirectoryPort {
  removeFromAccount(deploymentId: string): Promise<void>;
  syncAccountDeployments(
    mode: "ambient" | "required",
    trigger: "account-change" | "check" | "manual" | "network" | "retry" | "startup" | "wake",
  ): Promise<DirectorySyncOutcome>;
}

interface CatalogPort {
  read(): Promise<CatalogProjection>;
  select(deploymentId: string): Promise<CatalogProjection>;
  subscribe(listener: () => void): () => void;
}

interface HostSessionPort {
  abandonAuthorization(deploymentId: string): void;
  closeCurrent(): Promise<void>;
  establish(deploymentId: string): Promise<HostSessionObservation>;
  subscribe(listener: (observation: HostSessionObservation) => void): () => void;
}

interface PersonalPort {
  readonly status: DesktopPersonalDeploymentStatus;
  start(): Promise<DesktopPersonalDeploymentStatus>;
  subscribe(listener: (status: DesktopPersonalDeploymentStatus) => void): () => void;
}

interface PersonalAccountPort {
  link(): Promise<DesktopPersonalAccountLinkStatus>;
  resetJournal(): Promise<DesktopPersonalAccountLinkStatus>;
  status(): Promise<DesktopPersonalAccountLinkStatus>;
  subscribe(listener: (status: DesktopPersonalAccountLinkStatus) => void): () => void;
  unlink(): Promise<DesktopPersonalAccountLinkStatus>;
}

interface DirectPort {
  addRoute(input: DesktopAddDirectRouteInput): Promise<CatalogProjection>;
  connect(input: DesktopConnectPrivateDeploymentInput): Promise<CatalogProjection>;
}

/**
 * What one check of a place added by hand found. Only `reachable` means the
 * place answered *as itself*; an answer from something else at its address is
 * a mismatch, never a success.
 */
export type DeploymentProbeOutcome =
  "client-too-old" | "host-too-old" | "identity-mismatch" | "reachable" | "unreachable";

interface PlacesPort {
  /** Whether this computer has a network at all; without one, nothing is checked. */
  online(): boolean;
  /** Proves one place added by hand answers at its address as the same place. */
  probe(deploymentId: string, signal: AbortSignal): Promise<DeploymentProbeOutcome>;
}

export interface DeploymentAccessPorts {
  readonly account: AccountPort;
  readonly catalog: CatalogPort;
  readonly direct: DirectPort;
  readonly directory: DirectoryPort;
  readonly hostSession: HostSessionPort;
  readonly personal: PersonalPort;
  readonly personalAccount: PersonalAccountPort;
  readonly places: PlacesPort;
}

/** A check newer than this is shared rather than repeated. */
const checkFloorMilliseconds = 5_000;
/**
 * How long a checked answer is trusted. It is shorter than the Account's
 * two-minute liveness lease, so a list read inside it never calls a computer
 * that was heartbeating at the time asleep.
 */
const checkedAnswerLifetimeMilliseconds = 60_000;

type ForegroundOperationKind =
  | "account-sign-in"
  | "create-personal"
  | "direct-connect"
  | "open-deployment"
  | "personal-account-link"
  | "personal-account-link-repair"
  | "personal-account-unlink"
  | "refresh-directory"
  | "remove-from-account"
  | "sign-out-of-app";

export class DeploymentAccessService {
  readonly #listeners = new Set<(snapshot: DeploymentAccessSnapshot) => void>();
  readonly #ports: DeploymentAccessPorts;
  readonly #schedule: (callback: () => void, delayMilliseconds: number) => unknown;
  readonly #unsubscribers: Array<() => void> = [];
  #account = accountState({
    account: { available: false, detail: null, identity: null, status: "signed-out" },
    schemaVersion: 2,
  });
  #catalog: CatalogProjection = { deployments: [], revision: 0, selectedDeploymentId: null };
  #catalogFailure: string | null = null;
  #directoryCheck: Promise<void> | null = null;
  #directoryFailure: DeploymentAccessFailure | null = null;
  /** When the Account's list was last read successfully, or null if never. */
  #directoryReadAt: number | null = null;
  /** When the last read of it finished, success or not: what the check floor counts from. */
  #directoryTriedAt: number | null = null;
  #disposed = false;
  readonly #now: () => number;
  #initialized = false;
  #operation: { readonly kind: ForegroundOperationKind } | null = null;
  #operationId = 0;
  #pendingAttachmentDeploymentId: string | null = null;
  #personal: DesktopPersonalDeploymentStatus | null = null;
  #personalLink: DesktopPersonalAccountLinkStatus = unavailablePersonalAccountLink();
  readonly #probes = new Map<
    string,
    { readonly at: number; readonly outcome: DeploymentProbeOutcome }
  >();
  readonly #probing = new Map<
    string,
    { readonly abort: AbortController; readonly done: Promise<void> }
  >();
  #revision = 0;
  #supervisor: ConnectionSupervisor | null = null;
  #supervisorUnsubscribe: (() => void) | null = null;
  #unavailable: readonly DeploymentAccessUnavailable[] = [];

  constructor(
    ports: DeploymentAccessPorts,
    options: {
      readonly now?: () => number;
      readonly schedule?: (callback: () => void, delayMilliseconds: number) => unknown;
    } = {},
  ) {
    this.#ports = ports;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.#unsubscribers.push(
      ports.account.subscribe((state) => {
        const previous = this.#account;
        this.#account = accountState(state);
        if (this.#account.status !== "signed-in") this.#forgetAccountList();
        this.#publish();
        // Only a newly signed-in Account changes the list. A refreshed token or
        // a re-verification of the same Account says nothing new about it.
        if (this.#account.status === "signed-in" && !sameSignedInAccount(previous, this.#account)) {
          // The place left waiting for this sign-in reopens with it; any other
          // place's attempt is its own business, not the Account's.
          void this.#refreshDirectory("required", "account-change").then(() => {
            if (this.#selectedDeployment()?.source === "account") {
              this.#attachSelectedReturningDeployment();
            }
          });
        }
      }),
      ports.catalog.subscribe(() => void this.#reloadCatalog(true)),
      ports.hostSession.subscribe((observation) => {
        this.#supervisor?.observe(observation);
      }),
      ports.personal.subscribe((status) => {
        this.#personal = status;
        this.#publish();
        void this.#reloadCatalog(false).then(() => this.#resumePendingAttachment());
        if (status.state === "ready") {
          void ports.personalAccount.status().then(
            (link) => {
              this.#personalLink = link;
              this.#publish();
            },
            () => undefined,
          );
        }
      }),
      ports.personalAccount.subscribe((status) => {
        this.#personalLink = status;
        this.#publish();
      }),
    );
  }

  async initialize(): Promise<void> {
    this.#assertActive();
    const [account, catalogResult, personalLink] = await Promise.all([
      this.#ports.account.currentState().catch((error: unknown): DesktopAccountAuthState => ({
        account: {
          available: this.#ports.account.available,
          detail: clientPublicDetail(error, "Desktop Account credentials could not be loaded."),
          identity: null,
          status: "error",
        },
        schemaVersion: 2,
      })),
      this.#ports.catalog.read().then(
        (catalog) => ({ catalog, failure: null }),
        (error: unknown) => ({
          catalog: {
            deployments: [],
            revision: 0,
            selectedDeploymentId: null,
          } satisfies CatalogProjection,
          failure: classifyPortFailure("catalog", error),
        }),
      ),
      this.#ports.personalAccount.status().catch(() => unavailablePersonalAccountLink()),
    ]);
    this.#account = accountState(account);
    this.#catalog = catalogResult.catalog;
    this.#catalogFailure = catalogResult.failure?.detail ?? null;
    this.#personal = this.#ports.personal.status;
    this.#personalLink = personalLink;
    this.#initialized = true;
    this.#reconcileSupervisor();
    this.#publish();
    if (this.#account.status === "signed-in") await this.#refreshDirectory("required", "startup");
    this.#attachSelectedReturningDeployment();
  }

  snapshot(): DeploymentAccessSnapshot {
    const personal = this.#personalSetup();
    return freezeSnapshot(
      DeploymentAccessSnapshotSchema.parse({
        account: this.#account,
        deployments: this.#catalog.deployments.filter(this.#shown).map((deployment) => {
          const info = this.#statusInfo(deployment, personal);
          const connection = this.#connectionSnapshot(deployment);
          const {
            accountLivenessExpiresAt: _accountLivenessExpiresAt,
            hasAccountConnectRoute: _hasAccountConnectRoute,
            hasVerifiedAccountRoute: _hasVerifiedAccountRoute,
            key: _key,
            ...publicDeployment
          } = deployment;
          return {
            ...publicDeployment,
            attachmentKey: deployment.key,
            availableActions: this.#connectionActions(deployment.id, info),
            failure: connection.failure,
            status: connection.status,
            statusInfo: info,
          };
        }),
        directoryFailure: this.#directoryFailure,
        personalAccountLink: this.#personalLink,
        personalSetup: personal,
        revision: this.#revision,
        selectedDeploymentId: this.#catalog.selectedDeploymentId,
        unavailable: this.#unavailable,
      }),
    );
  }

  subscribe(listener: (snapshot: DeploymentAccessSnapshot) => void): () => void {
    this.#assertActive();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async addDirect(input: DesktopAddDirectRouteInput): Promise<void> {
    this.#assertActive();
    if (this.#catalog.deployments.length === 0) throw operationUnavailable("addDirect");
    await this.#catalogMutation("open-deployment", () => this.#ports.direct.addRoute(input));
  }

  async cancel(): Promise<void> {
    this.#assertActive();
    if (this.#account.status === "authorizing") {
      this.#pendingAttachmentDeploymentId = null;
      await this.#accountOperation("sign-out-of-app", () => this.#ports.account.signOut());
      return;
    }
    const supervisor = this.#selectedSupervisor();
    if (!this.#operation && !(supervisor?.canCancel() ?? false)) {
      throw operationUnavailable("cancel");
    }
    const abandoning = supervisor?.canCancel() ?? false;
    this.#pendingAttachmentDeploymentId = null;
    this.#operationId += 1;
    this.#operation = null;
    // Cancelling abandons the attempt and its in-flight establishment, and
    // returns the row to plain "not attached" — never to a failure a person
    // then has to clear before they can try again.
    supervisor?.cancel();
    if (supervisor && abandoning) {
      this.#ports.hostSession.abandonAuthorization(supervisor.deploymentId);
    }
    this.#publish();
  }

  async connectPrivate(input: DesktopConnectPrivateDeploymentInput): Promise<void> {
    this.#assertActive();
    await this.#catalogMutation("direct-connect", () => this.#ports.direct.connect(input));
  }

  async createPersonalDeployment(): Promise<void> {
    this.#assertActive();
    const personal = this.#personalSetup();
    if (personal?.deploymentId !== null || personal.state !== "stopped" || !personal.canStart) {
      throw operationUnavailable("createPersonalDeployment");
    }
    await this.#simpleOperation(
      "create-personal",
      () => this.#ports.personal.start(),
      (status) => {
        this.#personal = status;
      },
    );
  }

  async linkPersonal(): Promise<void> {
    this.#assertActive();
    if (this.#personalSetup()?.state !== "ready") throw operationUnavailable("linkPersonal");
    if (this.#personalLink.status === "needs-repair") {
      await this.#simpleOperation(
        "personal-account-link-repair",
        () => this.#ports.personalAccount.resetJournal(),
        (status) => {
          this.#personalLink = status;
        },
      );
      return;
    }
    // An `activating` link is committed on the Host and not yet live in the
    // Account: finishing it is the whole point of the affordance the outcome
    // copy points a person at, so linking again is exactly what it needs.
    if (this.#personalLink.status !== "unlinked" && this.#personalLink.status !== "activating") {
      throw operationUnavailable("linkPersonal");
    }
    await this.#simpleOperation(
      "personal-account-link",
      () => this.#ports.personalAccount.link(),
      (status) => {
        this.#personalLink = status;
      },
    );
  }

  async reauthorize(): Promise<void> {
    this.#assertActive();
    if (this.#account.status !== "signed-in") throw operationUnavailable("reauthorize");
    await this.#accountOperation("account-sign-in", () =>
      this.#ports.account.beginReauthorization(),
    );
  }

  async refreshDirectory(): Promise<void> {
    this.#assertActive();
    if (this.#account.status !== "signed-in") throw operationUnavailable("refreshDirectory");
    await this.#simpleOperation(
      "refresh-directory",
      () => this.#refreshDirectory("required", "manual"),
      () => undefined,
    );
  }

  async checkDeployments(): Promise<void> {
    this.#assertActive();
    // Without a network every place reads the same, and no check could say
    // otherwise; the list says so once instead of failing each place.
    if (!this.#ports.places.online()) {
      this.#publish();
      return;
    }
    const now = this.#now();
    const checks: Promise<void>[] = [];
    if (this.#account.status === "signed-in") {
      // A failed read counts toward the floor too: an Account that is
      // refusing or rate-limiting is never asked again on every click.
      if (this.#directoryCheck) checks.push(this.#directoryCheck);
      else if (
        this.#directoryTriedAt === null ||
        now - this.#directoryTriedAt >= checkFloorMilliseconds
      ) {
        checks.push(this.#checkDirectory());
      }
    }
    for (const deployment of this.#catalog.deployments) {
      if (deployment.source !== "manual" || deployment.key === null) continue;
      const running = this.#probing.get(deployment.id);
      if (running) {
        checks.push(running.done);
        continue;
      }
      const last = this.#probes.get(deployment.id);
      if (!last || now - last.at >= checkFloorMilliseconds) checks.push(this.#probe(deployment.id));
    }
    await Promise.all(checks);
  }

  async removeFromAccount(deploymentId: string): Promise<void> {
    this.#assertActive();
    if (this.#account.status !== "signed-in") throw operationUnavailable("removeFromAccount");
    const deployment = this.#catalog.deployments.find(({ id }) => id === deploymentId);
    // Dropping an Account listing is a member's preference. An owner's listing
    // is removed where the Deployment runs, so the Account rejects hiding it —
    // the same rule holds for a listing this computer could not verify.
    const unavailable = this.#unavailable.some(
      (entry) => entry.deploymentId === deploymentId && entry.accountAccess === "member",
    );
    if (
      !unavailable &&
      (!deployment ||
        deployment.source !== "account" ||
        deployment.onThisComputer ||
        deployment.accountAccess !== "member")
    ) {
      throw operationUnavailable("removeFromAccount");
    }
    await this.#simpleOperation(
      "remove-from-account",
      async () => {
        await this.#ports.directory.removeFromAccount(deploymentId);
        return this.#refreshDirectory("required", "manual");
      },
      () => undefined,
    );
  }

  /**
   * Try the selected Deployment again. Every state a person can be left
   * looking at answers to this one move — waiting to sign in re-opens the
   * Host's sign-in, a refusal is asked again, a cancelled attempt restarts —
   * so no advertised state is ever a dead end.
   */
  async retry(): Promise<void> {
    this.#assertActive();
    const supervisor = this.#selectedSupervisor();
    const selected = this.#selectedDeployment();
    const localRestart = Boolean(
      selected?.onThisComputer &&
      this.#personal?.deploymentId === selected.id &&
      this.#personal.canStart,
    );
    if (!supervisor || (!supervisor.canRetry() && !localRestart)) {
      throw operationUnavailable("retry");
    }
    if (localRestart) {
      const status = await this.#ports.personal.start();
      if (this.#disposed || this.#catalog.selectedDeploymentId !== selected?.id) return;
      this.#personal = status;
      if (status.state !== "ready") return;
    } else if (!this.#selectedAttachmentIsReady()) {
      throw operationUnavailable("retry");
    }
    if (supervisor.canCancel()) {
      this.#ports.hostSession.abandonAuthorization(supervisor.deploymentId);
    }
    this.#requestSelectedAttachment();
  }

  async select(deploymentId: string): Promise<void> {
    this.#assertActive();
    await this.#select(deploymentId);
  }

  async signIn(): Promise<void> {
    this.#assertActive();
    if (
      !this.#account.available ||
      (this.#account.status !== "signed-out" && this.#account.status !== "error")
    ) {
      throw operationUnavailable("signIn");
    }
    await this.#accountOperation("account-sign-in", () => this.#ports.account.beginSignIn());
  }

  async signOut(): Promise<void> {
    this.#assertActive();
    if (this.#account.status !== "signed-in") throw operationUnavailable("signOut");
    await this.#accountOperation("sign-out-of-app", () => this.#ports.account.signOut());
  }

  async unlinkPersonal(): Promise<void> {
    this.#assertActive();
    if (
      this.#personalSetup()?.state !== "ready" ||
      !["activating", "linked", "linked-elsewhere", "unlinking"].includes(this.#personalLink.status)
    ) {
      throw operationUnavailable("unlinkPersonal");
    }
    await this.#simpleOperation(
      "personal-account-unlink",
      () => this.#ports.personalAccount.unlink(),
      (status) => {
        this.#personalLink = status;
      },
    );
  }

  networkChanged(): void {
    if (this.#account.status === "signed-in") void this.#refreshDirectory("ambient", "network");
    if (this.#selectedAttachmentIsReady()) this.#selectedSupervisor()?.resume();
  }

  wake(): void {
    if (this.#account.status === "signed-in") void this.#refreshDirectory("ambient", "wake");
    if (this.#selectedAttachmentIsReady()) this.#selectedSupervisor()?.resume();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#operationId += 1;
    for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
    for (const { abort } of this.#probing.values()) abort.abort();
    this.#probing.clear();
    this.#disposeSupervisor();
    this.#listeners.clear();
  }

  /**
   * Selecting is always allowed to *try*. What a past attempt learned lives on
   * the attempt, not on the row, so the only thing that can refuse a selection
   * is the authority that owns the place saying it is not there at all.
   */
  async #select(deploymentId: string): Promise<void> {
    const deployment = this.#catalog.deployments.find(({ id }) => id === deploymentId);
    if (
      !deployment ||
      !this.#shown(deployment) ||
      !deploymentStatusSelectable(this.#statusInfo(deployment, this.#personalSetup()).status)
    ) {
      throw operationUnavailable("select");
    }
    this.#pendingAttachmentDeploymentId = null;
    this.#selectedSupervisor()?.deactivate();
    await this.#ports.hostSession.closeCurrent();
    await this.#catalogMutation("open-deployment", () => this.#ports.catalog.select(deploymentId));
  }

  async #catalogMutation(
    kind: ForegroundOperationKind,
    operation: () => Promise<CatalogProjection>,
  ): Promise<void> {
    const operationId = this.#beginOperation(kind);
    try {
      const catalog = await operation();
      if (operationId !== this.#operationId) return;
      this.#catalog = catalog;
      this.#reconcileSupervisor();
      this.#operation = null;
      this.#publish();
      this.#requestSelectedAttachment();
    } catch (error) {
      this.#failOperation(operationId);
      throw error;
    }
  }

  async #accountOperation(
    kind: ForegroundOperationKind,
    operation: () => Promise<DesktopAccountAuthState>,
  ): Promise<void> {
    const operationId = this.#beginOperation(kind);
    try {
      const state = await operation();
      // The fence is read before anything is written: a superseded operation
      // must not be able to install its result on the way out.
      if (operationId !== this.#operationId) return;
      this.#account = accountState(state);
      this.#operation = null;
      if (this.#account.status !== "signed-in") this.#forgetAccountList();
      this.#publish();
    } catch (error) {
      this.#failOperation(operationId);
      throw error;
    }
  }

  async #simpleOperation<T>(
    kind: ForegroundOperationKind,
    run: () => Promise<T>,
    commit: (value: T) => void,
  ): Promise<void> {
    const operationId = this.#beginOperation(kind);
    try {
      const value = await run();
      if (operationId !== this.#operationId) return;
      commit(value);
      this.#operation = null;
      this.#publish();
    } catch (error) {
      this.#failOperation(operationId);
      throw error;
    }
  }

  #beginOperation(kind: ForegroundOperationKind): number {
    if (this.#operation) throw new Error("Another deployment access operation is already running.");
    const operationId = ++this.#operationId;
    this.#operation = { kind };
    this.#publish();
    return operationId;
  }

  #failOperation(operationId: number): void {
    if (operationId !== this.#operationId || !this.#operation) return;
    this.#operation = null;
    this.#publish();
  }

  async #refreshDirectory(
    mode: "ambient" | "required",
    trigger: Parameters<DirectoryPort["syncAccountDeployments"]>[1],
  ): Promise<void> {
    const readAt = this.#now();
    try {
      const outcome = await this.#ports.directory.syncAccountDeployments(mode, trigger);
      // A sign-out while the read was out leaves nothing for its answer to describe.
      if (this.#account.status !== "signed-in") return;
      this.#unavailable = outcome.unavailable;
      // An ambient outcome may have joined a failed sync or skipped the read.
      if (mode === "required" || outcome.changed) {
        this.#directoryFailure = null;
        this.#directoryReadAt = readAt;
        this.#directoryTriedAt = this.#now();
      }
      if (outcome.changed) await this.#reloadCatalog(false);
      else this.#publish();
    } catch (error) {
      if (this.#account.status !== "signed-in") return;
      this.#directoryTriedAt = this.#now();
      const failure = classifyPortFailure("directory", error);
      this.#directoryFailure = {
        code: failure.code,
        detail: failure.detail,
        retryable: failure.classification === "transient",
      };
      this.#publish();
    }
  }

  /**
   * A catalog this app cannot read is never presented as an empty one, and a
   * catalog read that throws never leaves the published snapshot frozen on the
   * last good revision with nothing said about why.
   */
  async #reloadCatalog(externalSelection: boolean): Promise<void> {
    if (this.#disposed) return;
    const selectedBefore = this.#catalog.selectedDeploymentId;
    try {
      this.#catalog = await this.#ports.catalog.read();
      this.#catalogFailure = null;
    } catch (error) {
      this.#catalogFailure = classifyPortFailure("catalog", error).detail;
      this.#publish();
      return;
    }
    this.#reconcileSupervisor();
    this.#publish();
    // A rotated route re-attaches inside the supervisor that owns it. Only a
    // selection somebody else moved is reopened here, and only under the same
    // rule that reopens one at startup: it has to be a place already used.
    if (externalSelection && this.#catalog.selectedDeploymentId !== selectedBefore) {
      this.#attachSelectedReturningDeployment();
    }
  }

  /**
   * One supervisor, for the attached Deployment. A row nobody selected has no
   * attempt to own, so replacing the per-row map with a pure function is what
   * keeps an unselected row from chasing its own route changes.
   */
  #reconcileSupervisor(): void {
    const selected = this.#selectedDeployment();
    if (!selected) {
      this.#pendingAttachmentDeploymentId = null;
      this.#disposeSupervisor();
      return;
    }
    if (this.#pendingAttachmentDeploymentId !== selected.id) {
      this.#pendingAttachmentDeploymentId = null;
    }
    if (this.#supervisor && this.#supervisor.deploymentId === selected.id) {
      this.#supervisor.reconfigure({ attachmentKey: selected.key });
      return;
    }
    this.#disposeSupervisor();
    const supervisor = new ConnectionSupervisor({
      attachmentKey: selected.key,
      close: () => this.#ports.hostSession.closeCurrent(),
      deploymentId: selected.id,
      establish: (deploymentId) => this.#ports.hostSession.establish(deploymentId),
      schedule: this.#schedule,
    });
    this.#supervisor = supervisor;
    this.#supervisorUnsubscribe = supervisor.subscribe(() => this.#publish());
  }

  #disposeSupervisor(): void {
    this.#supervisorUnsubscribe?.();
    this.#supervisorUnsubscribe = null;
    this.#supervisor?.dispose();
    this.#supervisor = null;
  }

  #connectionSnapshot(deployment: DeploymentAccessCatalogDeployment): ConnectionSupervisorSnapshot {
    if (this.#supervisor && deployment.id === this.#catalog.selectedDeploymentId) {
      return this.#supervisor.snapshot();
    }
    return { failure: null, status: detachedStatus(deployment.key) };
  }

  #selectedDeployment(): DeploymentAccessCatalogDeployment | null {
    return (
      this.#catalog.deployments.find(({ id }) => id === this.#catalog.selectedDeploymentId) ?? null
    );
  }

  #attachSelectedReturningDeployment(): void {
    const selected = this.#selectedDeployment();
    if (!selected?.lastUsedAt) return;
    // An Account place needs the Account to open; until sign-in it stays on
    // screen asking for it, rather than failing an attempt nobody asked for.
    if (selected.source === "account" && this.#account.status !== "signed-in") return;
    const status = this.#supervisor?.snapshot().status;
    if (status === "connected" || status === "connecting" || status === "authorizing") return;
    this.#requestSelectedAttachment();
  }

  /**
   * Selection says which Deployment this Desktop intends to attach to; the
   * Personal supervisor says when this computer's Host exists. Keep that
   * intent pending while the local stack is being established, then cross the
   * attachment boundary once the supervisor has published its settled route.
   */
  #requestSelectedAttachment(): void {
    const selected = this.#selectedDeployment();
    if (!selected || !this.#supervisor) return;
    if (!this.#selectedAttachmentIsReady()) {
      this.#pendingAttachmentDeploymentId = selected.id;
      this.#publish();
      return;
    }
    this.#pendingAttachmentDeploymentId = null;
    this.#supervisor.attach();
  }

  #resumePendingAttachment(): void {
    if (this.#disposed) return;
    if (this.#pendingAttachmentDeploymentId !== this.#catalog.selectedDeploymentId) return;
    if (!this.#selectedAttachmentIsReady()) return;
    this.#requestSelectedAttachment();
  }

  #selectedAttachmentIsReady(): boolean {
    const selected = this.#selectedDeployment();
    if (!selected) return false;
    if (!selected.onThisComputer) return true;
    return this.#personal?.deploymentId === selected.id && this.#personal.state === "ready";
  }

  #selectedSupervisor(): ConnectionSupervisor | null {
    return this.#supervisor;
  }

  /**
   * Every action a row advertises is one this service will actually run:
   * `select` only where the owning authority says the place is there, `cancel`
   * and `retry` only where the selected attachment can be stopped or started.
   */
  #connectionActions(
    deploymentId: string,
    info: DeploymentStatusInfo,
  ): readonly DeploymentConnectionAction[] {
    const selected = deploymentId === this.#catalog.selectedDeploymentId;
    if (this.#operation) return selected ? ["cancel"] : [];
    if (!selected) return deploymentStatusSelectable(info.status) ? ["select"] : [];
    const localRestart =
      this.#selectedDeployment()?.onThisComputer &&
      this.#personal?.deploymentId === deploymentId &&
      this.#personal.canStart;
    if (localRestart) return ["retry"];
    if (this.#pendingAttachmentDeploymentId === deploymentId) return [];
    const status = this.#supervisor?.snapshot().status;
    if (status === "connecting") return ["cancel"];
    // Waiting on a browser is the one state where both moves are real: stop
    // waiting, or ask for a fresh authorization because the tab never came back.
    if (status === "authorizing") return ["retry", "cancel"];
    return this.#supervisor?.canRetry() ? ["retry"] : [];
  }

  /**
   * A catalog this app could not read is reported through the same repair the
   * bootstrap failure uses, because it is the same broken file and the same
   * fix — and it is derived, so a later good read clears it on its own.
   */
  #personalSetup(): DesktopPersonalDeploymentStatus | null {
    if (this.#personal === null || this.#catalogFailure === null) return this.#personal;
    return bootstrapFailurePersonalStatus(this.#personal, this.#catalogFailure);
  }

  /**
   * Account places are shown only while that Account is signed in: a list
   * from a sign-in that ended describes nothing a person can open. The one
   * exception is the place a person is in, which never vanishes under them.
   */
  readonly #shown = (deployment: DeploymentAccessCatalogDeployment): boolean =>
    deployment.source !== "account" ||
    this.#account.status === "signed-in" ||
    deployment.id === this.#catalog.selectedDeploymentId;

  /**
   * Every row's status comes from whichever authority actually knows the
   * place, and from nothing older than a check can vouch for: the local
   * supervisor for the stack running here, the live connection for the place
   * a person is in, a freshly read Account list for Account places, and a
   * proof of identity for places added by hand. When none of those has an
   * answer yet, the row says it is checking — never a guess.
   */
  #statusInfo(
    deployment: DeploymentAccessCatalogDeployment,
    personal: DesktopPersonalDeploymentStatus | null,
  ): DeploymentStatusInfo {
    if (deployment.onThisComputer) {
      // The supervisor has not reported on this row's stack yet: a place still
      // being looked at is on its way, never claimed ready.
      return personal?.deploymentId === deployment.id
        ? deploymentStatusFromPersonalStack(personal)
        : { reason: null, status: "starting" };
    }
    if (
      deployment.id === this.#catalog.selectedDeploymentId &&
      this.#supervisor?.deploymentId === deployment.id &&
      this.#supervisor.snapshot().status === "connected"
    ) {
      return placeStatus.ready();
    }
    if (!this.#ports.places.online()) return placeStatus.noInternet();
    const name = deployment.name;
    if (deployment.source === "account") {
      if (this.#account.status === "authorizing") return placeStatus.signingIn(name);
      if (this.#account.status !== "signed-in") return placeStatus.signInAgain(name);
      const now = this.#now();
      // What the last read found about this place is only as fresh as the read.
      if (
        this.#directoryReadAt === null ||
        now - this.#directoryReadAt >= checkedAnswerLifetimeMilliseconds
      ) {
        return this.#directoryFailure && !this.#directoryCheck
          ? placeStatus.couldNotCheck()
          : placeStatus.checking();
      }
      const unavailable = this.#unavailable.find(
        ({ deploymentId }) => deploymentId === deployment.id,
      );
      if (unavailable) return placeStatus.unavailable(unavailable.reason, name);
      if (deployment.kind !== "personal") return placeStatus.ready();
      if (!deployment.hasAccountConnectRoute) return placeStatus.remoteAccessOff(name);
      const lease = deployment.hasVerifiedAccountRoute ? deployment.accountLivenessExpiresAt : null;
      return lease !== null && Date.parse(lease) > now
        ? placeStatus.ready()
        : placeStatus.asleep(name);
    }
    if (deployment.key === null) {
      // Known only by the loopback origin of the computer that runs it, which
      // this app is not: the repair lives over there, so the sentence says so.
      return deployment.kind === "personal"
        ? placeStatus.remoteAccessOff(name)
        : placeStatus.unavailable("host-unavailable", name);
    }
    const probe = this.#probes.get(deployment.id);
    if (!probe || this.#now() - probe.at >= checkedAnswerLifetimeMilliseconds) {
      return placeStatus.checking();
    }
    if (probe.outcome === "reachable") return placeStatus.ready();
    if (probe.outcome === "unreachable") return placeStatus.notResponding(name);
    return placeStatus.unavailable(probe.outcome, name);
  }

  #checkDirectory(): Promise<void> {
    const check = this.#refreshDirectory("required", "check").finally(() => {
      this.#directoryCheck = null;
      this.#publish();
    });
    this.#directoryCheck = check;
    this.#publish();
    return check;
  }

  #probe(deploymentId: string): Promise<void> {
    const abort = new AbortController();
    const done = this.#ports.places
      .probe(deploymentId, abort.signal)
      .catch((): DeploymentProbeOutcome => "unreachable")
      .then((outcome) => {
        if (!abort.signal.aborted) this.#probes.set(deploymentId, { at: this.#now(), outcome });
      })
      .finally(() => {
        if (this.#probing.get(deploymentId)?.abort === abort) this.#probing.delete(deploymentId);
        this.#publish();
      });
    this.#probing.set(deploymentId, { abort, done });
    return done;
  }

  #forgetAccountList(): void {
    this.#unavailable = [];
    this.#directoryReadAt = null;
    this.#directoryTriedAt = null;
    this.#directoryFailure = null;
  }

  #publish(): void {
    if (this.#disposed || !this.#initialized) return;
    this.#revision += 1;
    const snapshot = this.snapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("Deployment access service is disposed.");
  }
}

function sameSignedInAccount(
  previous: DeploymentAccessSnapshot["account"],
  next: DeploymentAccessSnapshot["account"],
): boolean {
  return (
    previous.status === "signed-in" &&
    next.status === "signed-in" &&
    previous.issuer === next.issuer &&
    previous.subject === next.subject
  );
}

function accountState(state: DesktopAccountAuthState): DeploymentAccessSnapshot["account"] {
  return {
    available: state.account.available,
    ...(state.account.detail ? { detail: state.account.detail } : {}),
    ...(state.account.identity?.email ? { email: state.account.identity.email } : {}),
    ...(state.account.identity
      ? { issuer: state.account.identity.issuer, subject: state.account.identity.subject }
      : {}),
    status: state.account.status,
  };
}

function unavailablePersonalAccountLink(): DesktopPersonalAccountLinkStatus {
  return {
    account: null,
    deploymentId: null,
    displayName: null,
    status: "unavailable",
    unlinkStep: null,
  };
}

function bootstrapFailurePersonalStatus(
  status: DesktopPersonalDeploymentStatus,
  detail: string,
): DesktopPersonalDeploymentStatus {
  return {
    ...status,
    canStart: false,
    issue: {
      code: "directory-invalid",
      component: "desktop",
      detail,
      repairAction: "restore-permissions",
    },
    state: "repair-required",
    step: null,
  };
}

function freezeSnapshot(snapshot: DeploymentAccessSnapshot): DeploymentAccessSnapshot {
  for (const deployment of snapshot.deployments) {
    Object.freeze(deployment.routes);
    if (deployment.capabilities) Object.freeze(deployment.capabilities);
    Object.freeze(deployment.availableActions);
    Object.freeze(deployment.statusInfo);
    if (deployment.failure) Object.freeze(deployment.failure);
    Object.freeze(deployment);
  }
  Object.freeze(snapshot.deployments);
  for (const unavailable of snapshot.unavailable) Object.freeze(unavailable);
  Object.freeze(snapshot.unavailable);
  Object.freeze(snapshot.account);
  if (snapshot.directoryFailure) Object.freeze(snapshot.directoryFailure);
  return Object.freeze(snapshot);
}

export type DeploymentAccessPort = "catalog" | "directory";

export function classifyPortFailure(
  port: DeploymentAccessPort,
  error: unknown,
): ClassifiedDeploymentAccessFailure {
  const failure = classifyClientFailure(error);
  return {
    classification: failure.classification,
    code: `${port}-${machineCode(failure.reason)}`,
    detail: clientPublicDetail(error, `${port} operation failed.`),
  };
}

function machineCode(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || "failed"
  );
}

function operationUnavailable(operation: string): Error {
  return new Error(`Deployment access operation is not available now: ${operation}`);
}
