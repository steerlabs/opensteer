import { isIphoneAppId } from "./model.js";
import {
  HostClientRequestError,
  isHostRefusal,
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
} from "@opensteer/client/host";
import type { IntegrationAccess } from "@opensteer/client/integrations";
import type { DeviceInitialAccess } from "@opensteer/protocol";
import type {
  IphoneAppId,
  IphoneAppsApproval,
  IphoneAppsBridge,
  IphoneAppsIssue,
  IphoneAppsSnapshot,
  IphoneApprovalOutcome,
  IphonePendingLeave,
  IphonePermission,
} from "../platform/iphone-apps-types.js";
import {
  maxShownApprovals,
  type ShownApproval,
  type ShownApprovalsFile,
} from "./shown-approvals-file.js";
import type { IphoneAppsOwner, IphoneAppsStopped, IphoneLeaveOutcome } from "./owner.js";
import type { RemovedFrom, RemovedFile } from "./removed-file.js";

export type { IphoneAppsOwner, IphoneAppsStopped, IphoneLeaveOutcome } from "./owner.js";

export type NativePhoneEnrollment = (input: {
  readonly access?: DeviceInitialAccess;
  readonly deploymentId: string;
  readonly hostClient: HostClient;
  readonly name: string;
}) => Promise<{ readonly enrollmentId: string }>;

/** Sends a persisted self-leave to the Host it names; it never needs a session. */
export type DeliverLeave = (leave: IphonePendingLeave) => Promise<LeaveDelivery>;
/** `missing`: a Host that predates self-leave. `refused`: it will never accept this proof. */
export type LeaveDelivery = "missing" | "refused" | "removed" | "unreachable";

/**
 * This iPhone's apps, as the mobile app drives them.
 *
 * The native module owns execution, keys and OS prompts; this owns when to
 * ask it for what. It keeps exactly one Deployment — the one the iPhone was
 * added to — independent of whichever Deployment is open, so navigating never
 * stops or moves it. Every operation that crosses an await carries the
 * generation it started in: stopping the iPhone advances it, and an outcome
 * from an older generation changes nothing.
 */
export class IphoneAppsController {
  readonly owner: IphoneAppsOwner;

  readonly #bridge: IphoneAppsBridge;
  readonly #enrollNative: NativePhoneEnrollment | undefined;
  readonly #listeners = new Set<() => void>();
  readonly #shownFile: ShownApprovalsFile;
  readonly #timing: IphoneAppsTiming;
  /** Waiters re-check themselves when the generation advances. */
  readonly #wakers = new Set<() => void>();
  readonly #answering = new Set<string>();
  /** Access being added from this iPhone, beside (never instead of) the access it has. */
  readonly #changes = new Map<IphoneAppId, IphoneAppChange>();
  /** How the last change from here settled for an app, when it didn't turn on. */
  readonly #failures = new Map<IphoneAppId, IphoneAllowFailure>();
  /** Apps chosen with Add still waiting their turn, in order. */
  #queued: readonly IphoneAppId[] = [];
  #sharing = false;
  /** The last native prompt or picker; the next waits for it, since iOS doesn't queue them. */
  #iosTurn: Promise<unknown> = Promise.resolve();
  readonly #detachBridge: () => void;

  #adding: { readonly deploymentId: string; readonly outcome: Promise<IphoneAddOutcome> } | null =
    null;
  #approvals: readonly IphoneAppsApproval[] = [];
  #detachHost: (() => void) | null = null;
  #requestRead = 0;
  /** Each transition to online fences connection-specific work. */
  #connection = 0;
  #disposed = false;
  #generation = 0;
  #host: IphoneAppsHost | null = null;
  #hostGeneration = 0;
  #lastEnrollment: IphoneAppsSnapshot["enrollment"] = null;
  #notice: IphoneAppsNotice | null = null;
  #online = false;
  #removedFrom: IphoneAppsState["removedFrom"] = null;
  readonly #removedFile: RemovedFile | null;
  readonly #removedListeners = new Set<(deploymentId: string) => void>();
  readonly #deliverLeave: DeliverLeave | null;
  readonly #delivering = new Map<string, Promise<LeaveDelivery>>();
  /** The session bound to this phone's runner, per Deployment, as the Host last confirmed. */
  readonly #bound = new Map<string, string>();
  #binding: string | null = null;
  #bindingAttempts = 0;
  #bindingRetry: ReturnType<typeof setTimeout> | null = null;
  #recheckedAt = "";
  #retargetChecked = -1;
  #shown = new Map<string, string>();
  #shownLoaded = false;
  #shownWrite: Promise<void> = Promise.resolve();
  #state: IphoneAppsState;

  constructor(options: {
    readonly bridge: IphoneAppsBridge;
    readonly shownApprovals: ShownApprovalsFile;
    readonly timing?: Partial<IphoneAppsTiming>;
    readonly enrollNative?: NativePhoneEnrollment;
    readonly deliverLeave?: DeliverLeave;
    readonly removedFile?: RemovedFile;
  }) {
    this.#bridge = options.bridge;
    this.#deliverLeave = options.deliverLeave ?? null;
    this.#removedFile = options.removedFile ?? null;
    this.#enrollNative = options.enrollNative;
    this.#shownFile = options.shownApprovals;
    this.#timing = { ...defaultTiming, ...options.timing };
    this.#state = this.#derive(options.bridge.getSnapshot());
    this.owner = {
      enrolledDeploymentId: () =>
        this.#bridge.getSnapshot().enrollment?.deploymentId ?? this.#adding?.deploymentId ?? null,
      stop: () => this.#stop(),
      tellHost: (stopped, dispatch) => this.#tellHost(stopped, dispatch),
      automaticSignInAllowed: () => this.#bridge.getSnapshot().lifecycleReady !== false,
      removedDeploymentId: () =>
        this.#bridge.getSnapshot().removedFrom?.deploymentId ??
        this.#removedFrom?.deploymentId ??
        null,
      sessionBound: (deploymentId) => {
        const bound = this.#bound.get(deploymentId);
        if (bound === undefined) return false;
        const sessionId =
          this.#host?.deploymentId === deploymentId
            ? this.#host.hostClient.getSnapshot().sessionId
            : undefined;
        return sessionId === undefined || sessionId === bound;
      },
      onRemoved: (listener) => {
        this.#removedListeners.add(listener);
        return () => this.#removedListeners.delete(listener);
      },
    };
    this.#observe(options.bridge.getSnapshot());
    this.#detachBridge = options.bridge.subscribe((snapshot) => {
      this.#observe(snapshot);
      this.#publish();
      this.#maybeRetarget();
      this.#maybeRecheck();
      this.#maybeBind();
    });
  }

  getState = (): IphoneAppsState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads which requests were already shown on their own; until then none is. */
  async load(): Promise<void> {
    const [stored, removed] = await Promise.all([
      this.#shownFile.read(),
      this.#removedFile?.read() ?? Promise.resolve(null),
    ]);
    if (this.#disposed) return;
    for (const { expiresAt, id } of stored) this.#shown.set(id, expiresAt);
    this.#shownLoaded = true;
    if (this.#removedFrom === null && removed !== null) this.#removedFrom = removed;
    this.#publish();
    void this.retryLeave();
  }

  /** A leave persisted before a restart or while offline goes out again; it never needs a session. */
  async retryLeave(): Promise<LeaveDelivery | null> {
    const snapshot = this.#bridge.getSnapshot();
    const pending =
      snapshot.pendingLeaves ?? (snapshot.pendingLeave ? [snapshot.pendingLeave] : []);
    const outcomes = await Promise.all(pending.map((leave) => this.#deliver(leave)));
    return outcomes.find((outcome) => outcome !== "removed") ?? outcomes[0] ?? null;
  }

  /**
   * "Set up again" after the Host removed this phone: the removed screen
   * clears, and only then may this Deployment sign in or set up again.
   */
  async clearRemoved(): Promise<void> {
    await this.#bridge.clearRemoved?.();
    await this.#removedFile?.write(null);
    this.#removedFrom = null;
    this.#publish();
  }

  /**
   * The Deployment open on this phone, whose session can answer approvals and
   * read where the Deployment is now. Opening another Deployment never stops
   * or moves the iPhone.
   */
  attachHost(host: IphoneAppsHost | null): void {
    if (
      host?.deploymentId === this.#host?.deploymentId &&
      host?.hostClient === this.#host?.hostClient
    ) {
      return;
    }
    this.#detachHost?.();
    this.#host = host;
    this.#bindingAttempts = 0;
    if (this.#bindingRetry !== null) clearTimeout(this.#bindingRetry);
    this.#bindingRetry = null;
    let machines = host?.hostClient.getSnapshot().machines;
    this.#detachHost =
      host?.hostClient.subscribe(() => {
        this.#maybeBind();
        const next = host.hostClient.getSnapshot().machines;
        if (next !== machines) {
          machines = next;
          this.#readApprovals();
        }
      }) ?? null;
    this.#readApprovals();
    this.#hostGeneration += 1;
    // An attachment change fences the old operation, but cannot undo an answer
    // already sent. Read it back when its Host is attached again.
    for (const [app, change] of this.#changes) {
      this.#changes.set(app, { ...change, phase: "unknown" });
    }
    this.#publish();
    this.#maybeRetarget();
    this.#maybeRecheck();
    this.#maybeBind();
    void this.retryLeave();
  }

  /**
   * Adds this iPhone to a Deployment: one prepared identity, up to three
   * enrollments, each retired at the Host before its replacement is minted.
   */
  add(input: {
    readonly deploymentId: string;
    readonly hostClient: HostClient;
    /** The Host serves `iphone-apps-v1`; an older one is never asked to mint. */
    readonly iphoneAppsAvailable: boolean;
    readonly name: string;
    /** The setup switches, sent only to a Host that serves `devices-v1`. */
    readonly access?: DeviceInitialAccess;
  }): Promise<IphoneAddOutcome> {
    if (!input.iphoneAppsAvailable) return Promise.resolve(failed("host-update"));
    const snapshot = this.#bridge.getSnapshot();
    if (!snapshot.supported) return Promise.resolve(failed("failed"));
    const held = snapshot.enrollment;
    if (held !== null && held.deploymentId !== input.deploymentId) {
      return Promise.resolve(failed("enrolled-elsewhere"));
    }
    if (held?.state === "enrolled") {
      return Promise.resolve({ kind: "added", runnerId: held.runnerId });
    }
    if (this.#adding !== null) {
      return this.#adding.deploymentId === input.deploymentId
        ? this.#adding.outcome
        : Promise.resolve(failed("enrolled-elsewhere"));
    }
    const uncertain = held?.state === "pending" && held.enrollmentId === null ? this.#stop() : null;
    const generation = this.#generation;
    const attempt =
      uncertain === null
        ? this.#addNow(input, generation)
        : this.#tellHost(uncertain, (command) => input.hostClient.dispatch(command)).then(
            (outcome) =>
              generation !== this.#generation
                ? superseded
                : outcome === "removed"
                  ? this.#addNow(input, generation)
                  : failed("host-unreachable"),
          );
    const outcome = attempt.finally(() => {
      if (this.#adding?.outcome !== outcome) return;
      this.#adding = null;
      this.#publish();
    });
    this.#adding = { deploymentId: input.deploymentId, outcome };
    if (this.#removedFrom !== null) void this.clearRemoved();
    this.#publish();
    return outcome;
  }

  /**
   * Turns on the apps chosen with Add, one at a time, so iOS asks about one
   * app at a time and each request is approved on its own. Add listed every app
   * and level it turns on, so its tap is their review. An app that doesn't
   * turn on keeps why for its row, and the rest go on; stopping the iPhone or
   * opening another Deployment ends the run.
   */
  async share(input: {
    readonly apps: readonly { readonly access: IntegrationAccess; readonly app: IphoneAppId }[];
    readonly hostClient: HostClient;
  }): Promise<void> {
    if (this.#sharing) return;
    this.#sharing = true;
    const fence = this.#fence();
    this.#queued = input.apps.map(({ app }) => app);
    this.#publish();
    try {
      for (const { access, app } of input.apps) {
        if (!fence.current()) return;
        this.#queued = this.#queued.filter((queued) => queued !== app);
        this.#publish();
        await this.#allowOne({ access, app, hostClient: input.hostClient }).catch(
          (error: unknown) => {
            if (!fence.current()) return;
            this.#failures.set(app, {
              kind: "not-allowed",
              message: error instanceof Error ? error.message : "It wasn't turned on. Try again.",
            });
          },
        );
      }
    } finally {
      // Only one run is ever under way, so what is left of its queue is its own.
      this.#sharing = false;
      this.#queued = [];
      this.#publish();
    }
  }

  /**
   * Turns an app on or widens it, from a person's tap: its switch, its level,
   * or Add.
   *
   * Both sides must offer the app before iOS is asked anything: this build
   * reports its permission, and the Host's catalog lists its definition (an
   * older Host doesn't). Then iOS decides: it is asked when it has not been,
   * and whatever it then says is read back. If it does not let Opensteer use
   * the app, nothing is requested or approved. Otherwise the Host's request is
   * approved here once it is the exact request listed, and success is only the
   * Host's own answer.
   *
   * A lost answer is never taken as "off", nor asked again: the Host's own
   * requests and connections are read back. If they cannot be read, the change
   * stays `unknown` beside the current access until `check` reads them.
   */
  async allow(input: {
    readonly access: IntegrationAccess;
    readonly app: IphoneAppId;
    readonly hostClient: HostClient;
  }): Promise<IphoneAllowOutcome> {
    // iOS asks about one app at a time: nothing new starts while Add's apps,
    // or another app, are still being turned on.
    if (iphoneTurningOn(this.#state)) return { kind: "busy" };
    return this.#allowOne(input);
  }

  async #allowOne(input: {
    readonly access: IntegrationAccess;
    readonly app: IphoneAppId;
    readonly hostClient: HostClient;
  }): Promise<IphoneAllowOutcome> {
    if (this.#changes.has(input.app)) return { kind: "busy" };
    this.#failures.delete(input.app);
    return this.#remember(input.app, await this.#allow(input));
  }

  async #allow(input: {
    readonly access: IntegrationAccess;
    readonly app: IphoneAppId;
    readonly hostClient: HostClient;
  }): Promise<IphoneAllowOutcome> {
    const runnerId = this.#runnerFor(input.hostClient);
    if (this.#changes.has(input.app)) return { kind: "busy" };
    if (iphonePermissionOf(this.#bridge.getSnapshot(), input.app) === null) {
      return notOfferedHere;
    }
    const fence = this.#fence();
    this.#setChange(input.app, { access: input.access, phase: "checking", requestId: null });
    try {
      let listed: boolean;
      try {
        listed = await hostLists(input.hostClient, input.app);
      } catch {
        return fence.current()
          ? {
              kind: "not-allowed",
              message: "Opensteer couldn't be reached, so nothing was asked. Try again.",
            }
          : superseded;
      }
      if (!fence.current()) return superseded;
      if (!listed) return { by: "host", kind: "not-offered" };
      this.#setChange(input.app, { access: input.access, phase: "asking-iphone", requestId: null });
      const permission = await this.#readyPermission(input.app, fence.current);
      if (!fence.current()) return superseded;
      if (permission === "not-offered") return notOfferedHere;
      if (permission !== null) return { kind: "blocked", permission };
      this.#setChange(input.app, { access: input.access, phase: "sending", requestId: null });
      let requestId: string;
      try {
        const result = await input.hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey(`iphone-app:${input.app}`),
          input: {
            access: input.access,
            app: null,
            definitionId: input.app,
            kind: "app",
            runnerId,
          },
          type: "integration.computer.setup.request",
        });
        if (!fence.current()) return superseded;
        if (result.type !== "integration.computer.setup.request") {
          return await this.#reconcile({
            ...input,
            fence,
            requestId: null,
            resign: true,
            runnerId,
          });
        }
        requestId = result.request.id;
      } catch (error) {
        if (!fence.current()) return superseded;
        if (isHostRefusal(error)) return notAllowed(error, "Opensteer didn't allow that.");
        return await this.#reconcile({ ...input, fence, requestId: null, resign: true, runnerId });
      }
      return await this.#approve({ ...input, fence, requestId, runnerId });
    } finally {
      this.#settleChange(input.app, fence);
    }
  }

  /**
   * Reads the Host's own record for a change whose outcome is unknown, from
   * a tap. It never asks the Host for the access again; when the same request
   * is still waiting and listed here, the reviewed approval goes on to approve it.
   */
  async check(input: {
    readonly app: IphoneAppId;
    readonly hostClient: HostClient;
  }): Promise<IphoneAllowOutcome> {
    const change = this.#changes.get(input.app);
    if (change?.phase !== "unknown") return { kind: "busy" };
    const runnerId = this.#runnerFor(input.hostClient);
    const fence = this.#fence();
    this.#failures.delete(input.app);
    try {
      return this.#remember(
        input.app,
        await this.#reconcile({
          access: change.access,
          app: input.app,
          fence,
          hostClient: input.hostClient,
          requestId: change.requestId,
          resign: true,
          runnerId,
        }),
      );
    } finally {
      this.#settleChange(input.app, fence);
    }
  }

  /**
   * Answers a request the iPhone currently lists, from a tap. Allowing asks
   * iOS first when it has not been asked, and approves nothing iOS refuses: the
   * request then stays waiting, to allow later or decline. A Host rollback can
   * leave a request for a removed provider. Check its catalog before a new
   * provider's first prompt when its Deployment is open; answering requires the enrolled Deployment's authenticated session. The Host validates the
   * definition again before granting access.
   */
  async answer(input: {
    readonly decision: "allow" | "deny";
    readonly setupRequestId: string;
  }): Promise<IphoneAnswerOutcome> {
    const generation = this.#generation;
    const host = this.#host;
    if (!host || host.deploymentId !== this.#bridge.getSnapshot().enrollment?.deploymentId)
      return noLongerWaiting;
    const record = await readHostRecord(host.hostClient).catch(() => null);
    if (generation !== this.#generation || record === null) return noLongerWaiting;
    const found = record.requests.find(({ id }) => id === input.setupRequestId);
    const listed =
      found && found.definitionId && isIphoneAppId(found.definitionId)
        ? {
            ...found,
            setupRequestId: found.id,
            definitionId: found.definitionId,
            reason: found.reason ?? null,
            threadTitle: found.threadTitle ?? null,
            createdAt: found.createdAt ?? new Date().toISOString(),
            expiresAt: found.expiresAt ?? new Date().toISOString(),
          }
        : undefined;
    if (listed === undefined || this.#answering.has(input.setupRequestId)) return noLongerWaiting;
    this.#answering.add(input.setupRequestId);
    this.#markShown(listed);
    // A request answered here supersedes why its app last didn't turn on.
    this.#failures.delete(listed.definitionId);
    this.#publish();
    try {
      if (input.decision === "allow") {
        const snapshot = this.#bridge.getSnapshot();
        const host = this.#host;
        if (
          (listed.definitionId === "iphone-location" || listed.definitionId === "iphone-photos") &&
          iphonePermissionOf(snapshot, listed.definitionId) === "not-determined" &&
          host !== null &&
          host.deploymentId === snapshot.enrollment?.deploymentId
        ) {
          const offered = await hostLists(host.hostClient, listed.definitionId).catch(() => null);
          if (generation !== this.#generation) return noLongerWaiting;
          if (offered === false) return { by: "host", kind: "not-offered" };
        }
        const permission = await this.#readyPermission(
          listed.definitionId,
          () => generation === this.#generation,
        );
        if (generation !== this.#generation) return noLongerWaiting;
        if (permission === "not-offered") return notOfferedHere;
        if (permission !== null) return { kind: "blocked", permission };
      }
      // The list can move while iOS asks: sign only what is still listed, as tapped.
      const still = this.#listed(input.setupRequestId);
      if (
        still === undefined ||
        still.definitionId !== listed.definitionId ||
        still.access !== listed.access
      ) {
        return noLongerWaiting;
      }
      const outcome = await this.#answerHost({
        decision: input.decision,
        expected: { access: listed.access, definitionId: listed.definitionId },
        setupRequestId: input.setupRequestId,
      });
      if (generation !== this.#generation) return noLongerWaiting;
      if (outcome.kind !== "unavailable" || input.decision !== "allow") return outcome;
      // The answer may have landed even though its reply did not.
      const host = this.#host;
      const enrollment = this.#bridge.getSnapshot().enrollment;
      if (host === null || enrollment === null || host.deploymentId !== enrollment.deploymentId) {
        return outcome;
      }
      const record = await readHostRecord(host.hostClient).catch(() => null);
      if (generation !== this.#generation) return noLongerWaiting;
      if (record === null) return { kind: "unknown" };
      return covers(record, enrollment.runnerId, listed.definitionId, listed.access) &&
        !record.requests.some(({ id }) => id === input.setupRequestId)
        ? { kind: "allowed" }
        : outcome;
    } finally {
      this.#answering.delete(input.setupRequestId);
      this.#publish();
    }
  }

  /**
   * iOS asks only here, from a tap; otherwise the current answer comes back.
   * Null, without asking, when this build doesn't offer the app.
   */
  async requestPermission(app: IphoneAppId): Promise<IphonePermission | null> {
    if (iphonePermissionOf(this.#bridge.getSnapshot(), app) === null) return null;
    return this.#askIos(() => this.#bridge.requestPermission(app));
  }

  /**
   * iOS 18's picker for sharing more contacts, from a tap. What comes back is
   * iOS's answer read afresh: closing the picker is not a refusal.
   */
  async chooseContacts(): Promise<IphonePermission> {
    return this.#askIos(() => this.#bridge.chooseContacts());
  }

  /**
   * Apple's picker for the photos limited access shares, from a tap, and only
   * while access is limited. What comes back is iOS's answer read afresh:
   * closing the picker is not a refusal. Null when this build lacks Photos.
   */
  async choosePhotos(): Promise<IphonePermission | null> {
    const current = iphonePermissionOf(this.#bridge.getSnapshot(), "iphone-photos");
    if (current !== "limited") return current;
    return this.#askIos(() => this.#bridge.choosePhotos());
  }

  /** The person saw this request on its own; it is not shown on its own again. */
  markShown(setupRequestId: string): void {
    const listed = this.#listed(setupRequestId);
    if (listed === undefined || this.#shown.has(setupRequestId)) return;
    this.#markShown(listed);
    this.#publish();
  }

  /** Stops this iPhone at once, then tells the Host while this phone can. */
  async remove(input: { readonly hostClient: HostClient }): Promise<void> {
    const stopped = this.#stop();
    if (stopped === null) return;
    await this.#tellHost(stopped, (command) => input.hostClient.dispatch(command));
  }

  dismissNotice(): void {
    this.#notice = null;
    this.#publish();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#bindingRetry !== null) clearTimeout(this.#bindingRetry);
    this.#generation += 1;
    this.#detachBridge();
    this.#detachHost?.();
    this.#requestRead += 1;
    for (const wake of this.#wakers) wake();
    this.#listeners.clear();
  }

  async #addNow(
    input: {
      readonly access?: DeviceInitialAccess;
      readonly deploymentId: string;
      readonly hostClient: HostClient;
      readonly name: string;
    },
    generation: number,
  ): Promise<IphoneAddOutcome> {
    const current = () => generation === this.#generation;
    let mintKey: string;
    let runnerId: string;
    let publicKeyPem: string | undefined;
    try {
      ({ mintKey, runnerId, publicKeyPem } = await this.#bridge.prepare({
        deploymentId: input.deploymentId,
      }));
    } catch (error) {
      if (!current()) return superseded;
      return failed(
        bridgeErrorCode(error) === "enrolled-elsewhere" ? "enrolled-elsewhere" : "failed",
      );
    }
    let resumed = this.#bridge.getSnapshot().enrollment;
    for (let attempt = 1; ; attempt += 1) {
      if (!current()) return superseded;
      let minted: Pick<Minted, "enrollmentId">;
      try {
        if (resumed?.state === "pending" && resumed.enrollmentId) {
          minted = { enrollmentId: resumed.enrollmentId };
          resumed = null;
        } else if (this.#enrollNative !== undefined) {
          minted = await this.#enrollNative(input);
        } else {
          const devicesV1 = input.hostClient.getSnapshot().devicesAvailable === true;
          const target = unwrapRpcResult(await input.hostClient.rpc["agentPhone.target.get"]({}));
          if (!current()) return superseded;
          if (target.deploymentId !== input.deploymentId) return failed("host-mismatch");
          await this.#bridge.beginIssuance?.({ pairing: target, devicesV1, name: input.name });
          if (!current()) return superseded;
          if (devicesV1 && (!publicKeyPem || !this.#bridge.beginIssuance))
            return failed("needs-update");
          const enrollment = await mint(input.hostClient, {
            mintKey,
            ...(devicesV1 ? { preparedIdentity: { runnerId, publicKeyPem: publicKeyPem! } } : {}),
            name: input.name,
            ...(input.access === undefined ? {} : { access: input.access }),
          });
          if (!current()) return superseded;
          if (enrollment.pairing.deploymentId !== input.deploymentId)
            return failed("host-mismatch");
          try {
            await this.#bridge.enroll({
              enrollmentId: enrollment.enrollmentId,
              enrollmentToken: enrollment.token,
              expiresAt: enrollment.expiresAt,
              name: input.name,
              pairing: enrollment.pairing,
            });
          } catch (error) {
            if (!current()) return superseded;
            return failed(
              bridgeErrorCode(error) === "wrong-deployment" ? "host-mismatch" : "failed",
            );
          }
          minted = enrollment;
        }
      } catch (error) {
        return current() ? { failure: mintFailure(error), kind: "failed" } : superseded;
      }
      if (!current()) return superseded;
      const settled = await this.#waitFor(
        (snapshot): "added" | IphoneAppsIssue | undefined =>
          snapshot.issue ??
          (snapshot.enrollment?.state === "enrolled" && snapshot.connection === "online"
            ? "added"
            : undefined),
        this.#timing.enrollWaitMs,
        generation,
      );
      if (settled === "superseded") return superseded;
      if (settled === "added") {
        const enrolled = this.#bridge.getSnapshot().enrollment;
        return enrolled === null ? superseded : { kind: "added", runnerId: enrolled.runnerId };
      }
      // The iPhone keeps its pending identity and may still finish later.
      if (settled === "timeout") return failed("failed");
      if (settled !== "enrollment-expired" && settled !== "enrollment-refused") {
        return {
          failure: issueFailure(settled, this.#bridge.getSnapshot().issueMessage),
          kind: "failed",
        };
      }
      // A dead enrollment is retired before another is minted, so two can
      // never both be redeemable; the Host's answer names why it is dead.
      try {
        const retired = await input.hostClient.dispatch({
          enrollmentId: minted.enrollmentId,
          idempotencyKey: mutationIdempotencyKey("iphone-enrollment-retire"),
          type: "runner.enrollment.retire",
        });
        if (!current()) return superseded;
        if (retired.type !== "runner.enrollment.retire") return failed("failed");
        ({ mintKey } = await this.#bridge.discardPendingEnrollment());
      } catch (error) {
        return current() ? { failure: mintFailure(error), kind: "failed" } : superseded;
      }
      if (attempt >= maxEnrollments) return failed("too-long");
    }
  }

  /** The enrolled Runner, when the Host given is the one this iPhone was added to. */
  #runnerFor(hostClient: HostClient): string {
    const enrollment = this.#bridge.getSnapshot().enrollment;
    if (
      enrollment === null ||
      enrollment.state !== "enrolled" ||
      this.#host?.hostClient !== hostClient ||
      this.#host.deploymentId !== enrollment.deploymentId
    ) {
      throw new Error("Open the Opensteer this iPhone was added to, then try again.");
    }
    return enrollment.runnerId;
  }

  #fence(): Fence {
    const generation = this.#generation;
    const hostGeneration = this.#hostGeneration;
    return {
      current: () => generation === this.#generation && hostGeneration === this.#hostGeneration,
      generation,
    };
  }

  /**
   * Asks iOS when it can still ask, then reads its answer back. Null means iOS
   * lets Opensteer use the app; anything else is the answer that stops here.
   * A build that doesn't report the app is never asked about it, and a
   * prompt whose turn comes after its operation was cut off is never shown.
   */
  async #readyPermission(
    app: IphoneAppId,
    current: () => boolean,
  ): Promise<IphonePermission | "not-offered" | null> {
    let permission = iphonePermissionOf(this.#bridge.getSnapshot(), app);
    if (permission === null) return "not-offered";
    if (needsPrompt(app, permission)) {
      const before = permission;
      permission = await this.#askIos(async () => {
        const now = iphonePermissionOf(this.#bridge.getSnapshot(), app) ?? before;
        // Another prompt may have answered this while it waited its turn.
        return current() && needsPrompt(app, now) ? this.#bridge.requestPermission(app) : now;
      });
    }
    return iphonePermissionAllows(app, permission) ? null : permission;
  }

  /** Answers the exact request the Host named using the current owner session. */
  async #answerHost(input: {
    readonly decision: "allow" | "deny";
    readonly setupRequestId: string;
    readonly expected: { readonly access: IntegrationAccess; readonly definitionId: string };
  }): Promise<IphoneApprovalOutcome> {
    const host = this.#host;
    if (!host || host.deploymentId !== this.#bridge.getSnapshot().enrollment?.deploymentId)
      return { kind: "unavailable", message: "Open this iPhone's Deployment to answer." };
    try {
      const review = unwrapRpcResult(
        await host.hostClient.rpc["integration.computer.setup.review"]({
          setupRequestId: input.setupRequestId,
        }),
      );
      if (
        review.request.definitionId !== input.expected.definitionId ||
        review.request.access !== input.expected.access
      )
        return { kind: "refused", message: "This request changed. Review it again." };
      await host.hostClient.dispatch({
        type: "integration.computer.setup.respond",
        idempotencyKey: mutationIdempotencyKey(`iphone-answer:${input.setupRequestId}`),
        decision: input.decision,
        setupRequestId: input.setupRequestId,
      });
      this.#readApprovals();
      return { kind: input.decision === "allow" ? "allowed" : "declined" };
    } catch (error) {
      if (isHostRefusal(error) && error instanceof Error)
        return { kind: "refused", message: error.message };
      return {
        kind: "unavailable",
        message: error instanceof Error ? error.message : "Couldn't send this answer.",
      };
    }
  }

  async #approve(input: Step & { readonly requestId: string }): Promise<IphoneAllowOutcome> {
    this.#setChange(input.app, {
      access: input.access,
      phase: "approving",
      requestId: input.requestId,
    });
    const listed = (await readHostRecord(input.hostClient)).requests.find(
      ({ id }) => id === input.requestId,
    );
    if (!input.fence.current()) return superseded;
    if (!listed) return { kind: "waiting" };
    // Only the exact request that was reviewed is approved: a request for this
    // app at another access is another decision, and stays waiting for it.
    if (listed.definitionId !== input.app || listed.access !== input.access) return requestChanged;
    // iPhone Settings may have changed while the request travelled.
    const permission = await this.#readyPermission(input.app, input.fence.current);
    if (!input.fence.current()) return superseded;
    if (permission === "not-offered") return notOfferedHere;
    if (permission !== null) return { kind: "blocked", permission };
    const outcome = await this.#answerHost({
      decision: "allow",
      expected: { access: input.access, definitionId: input.app },
      setupRequestId: input.requestId,
    });
    if (!input.fence.current()) return superseded;
    switch (outcome.kind) {
      case "allowed":
        return { kind: "allowed" };
      case "declined":
      case "refused":
        return {
          kind: "not-allowed",
          message: outcome.kind === "refused" ? outcome.message : "That request was declined.",
        };
      case "unavailable":
        // The decision may have reached the Host even though its reply did not.
        return this.#reconcile({ ...input, resign: false });
    }
  }

  /**
   * Settles a change from the Host's own requests and connections. `resign`
   * lets a request that is still waiting go on to be approved; after a decision
   * whose reply was lost it does not, so one tap never sends twice.
   */
  async #reconcile(
    input: Step & { readonly requestId: string | null; readonly resign: boolean },
  ): Promise<IphoneAllowOutcome> {
    this.#setChange(input.app, {
      access: input.access,
      phase: "checking",
      requestId: input.requestId,
    });
    const record = await readHostRecord(input.hostClient).catch(() => null);
    if (!input.fence.current()) return superseded;
    if (record === null) {
      this.#setChange(input.app, {
        access: input.access,
        phase: "unknown",
        requestId: input.requestId,
      });
      return { kind: "unknown" };
    }
    if (covers(record, input.runnerId, input.app, input.access)) return { kind: "allowed" };
    const request = record.requests.find(
      (candidate) =>
        candidate.kind === "app" &&
        candidate.runnerId === input.runnerId &&
        candidate.definitionId === input.app &&
        (input.requestId === null || candidate.id === input.requestId),
    );
    if (request === undefined) {
      return {
        kind: "not-allowed",
        message:
          "That request is no longer waiting. Review the current access before trying again.",
      };
    }
    if (request.access !== input.access) return requestChanged;
    if (!input.resign) return { kind: "waiting" };
    return this.#approve({ ...input, requestId: request.id });
  }

  /**
   * Once per connection and attachment, reads unknown changes back from the
   * Host. It only reads: a request still waiting is left for the person to
   * approve, so nothing is approved or asked for without a tap.
   */
  #maybeRecheck(): void {
    const snapshot = this.#bridge.getSnapshot();
    const host = this.#host;
    const enrollment = snapshot.enrollment;
    const at = `${this.#connection}:${this.#hostGeneration}`;
    if (
      this.#disposed ||
      snapshot.connection !== "online" ||
      enrollment?.state !== "enrolled" ||
      host === null ||
      host.deploymentId !== enrollment.deploymentId ||
      this.#recheckedAt === at
    ) {
      return;
    }
    const unknown = [...this.#changes].filter(([, change]) => change.phase === "unknown");
    if (unknown.length === 0) return;
    this.#recheckedAt = at;
    for (const [app, change] of unknown) {
      const fence = this.#fence();
      void this.#reconcile({
        access: change.access,
        app,
        fence,
        hostClient: host.hostClient,
        requestId: change.requestId,
        resign: false,
        runnerId: enrollment.runnerId,
      })
        .catch(() => undefined)
        .finally(() => this.#settleChange(app, fence));
    }
  }

  /**
   * Every iOS permission prompt and picker goes through here, one at a time,
   * whichever path asks: a switch, Add's run, a task's Allow, or a remedy.
   */
  #askIos<T>(ask: () => Promise<T>): Promise<T> {
    const turn = this.#iosTurn.then(ask, ask);
    this.#iosTurn = turn.catch(() => undefined);
    return turn;
  }

  /** Keeps why a change didn't turn its app on, for that app's row, unless the change was cut off. */
  #remember(app: IphoneAppId, outcome: IphoneAllowOutcome): IphoneAllowOutcome {
    switch (outcome.kind) {
      case "blocked":
      case "not-allowed":
      case "not-offered":
      case "waiting":
        this.#failures.set(app, outcome);
        this.#publish();
        break;
      case "allowed":
      case "busy":
      case "superseded":
      case "unknown":
        break;
    }
    return outcome;
  }

  #setChange(app: IphoneAppId, change: IphoneAppChange): void {
    this.#changes.set(app, change);
    this.#publish();
  }

  /** A settled change leaves; an unknown one stays to be checked. */
  #settleChange(app: IphoneAppId, fence: Fence): void {
    if (!fence.current() || this.#changes.get(app)?.phase === "unknown") return;
    this.#changes.delete(app);
    this.#publish();
  }

  #stop(): IphoneAppsStopped | null {
    const before = this.#bridge.getSnapshot();
    const enrollment = before.enrollment;
    const adding = this.#adding?.deploymentId ?? null;
    if (enrollment === null && adding === null) return null;
    this.#generation += 1;
    this.#adding = null;
    this.#changes.clear();
    this.#failures.clear();
    this.#queued = [];
    const ids = this.#bridge.leave();
    for (const wake of this.#wakers) wake();
    const deploymentId = enrollment?.deploymentId ?? ids.deploymentId ?? adding;
    const sessionBound = deploymentId !== null && this.owner.sessionBound(deploymentId);
    if (deploymentId !== null) this.#bound.delete(deploymentId);
    this.#publish();
    if (deploymentId === null) return null;
    return {
      deploymentId,
      deploymentName: enrollment?.deploymentName ?? null,
      enrollmentId: enrollment?.state === "pending" ? enrollment.enrollmentId : null,
      left: ids.leave === "persisted",
      ...(ids.leave === "persisted" && enrollment?.state !== "enrolled" && ids.runnerId
        ? { leaveRunnerId: ids.runnerId }
        : {}),
      machineId: enrollment?.state === "enrolled" ? enrollment.runnerId : null,
      name: enrollment?.name ?? before.deviceName,
      sessionBound,
    };
  }

  #deliver(
    pending: IphonePendingLeave,
    dispatch?: HostClient["dispatch"] | null,
  ): Promise<LeaveDelivery> {
    const existing = this.#delivering.get(pending.runnerId);
    if (existing) return existing;
    const delivering = (async (): Promise<LeaveDelivery> => {
      let outcome: LeaveDelivery = "unreachable";
      const devicesV1 =
        pending.devicesV1 ??
        (this.#host?.deploymentId === pending.deploymentId
          ? this.#host.hostClient.getSnapshot().devicesAvailable
          : undefined);
      if (devicesV1 === true) {
        outcome =
          this.#deliverLeave === null
            ? "unreachable"
            : ((await withDeadline(
                this.#deliverLeave(pending).catch((): LeaveDelivery => "unreachable"),
                this.#timing.revokeMs,
              )) ?? "unreachable");
        const host = this.#host;
        if (
          outcome !== "removed" &&
          pending.hostInstanceId &&
          host?.deploymentId === pending.deploymentId &&
          this.#deliverLeave
        ) {
          const target = await withDeadline(
            host.hostClient.rpc["agentPhone.target.get"]({}).catch(() => null),
            this.#timing.revokeMs,
          );
          if (
            target?.ok &&
            target.data.deploymentId === pending.deploymentId &&
            target.data.hostInstanceId === pending.hostInstanceId &&
            target.data.hostUrl !== pending.hostUrl
          ) {
            outcome =
              (await withDeadline(
                this.#deliverLeave({ ...pending, hostUrl: target.data.hostUrl }).catch(
                  (): LeaveDelivery => "unreachable",
                ),
                this.#timing.revokeMs,
              )) ?? "unreachable";
          }
        }
      } else if (devicesV1 === false) {
        const authenticated =
          dispatch ??
          (this.#host?.deploymentId === pending.deploymentId
            ? this.#host.hostClient.dispatch.bind(this.#host.hostClient)
            : null);
        if (authenticated) {
          try {
            let enrollmentId = pending.enrollmentId;
            if (pending.enrolled === false && !enrollmentId && pending.mintKey && pending.name) {
              const minted = await withDeadline(
                authenticated({
                  type: "runner.enrollment.createPhone",
                  idempotencyKey: pending.mintKey,
                  name: pending.name,
                  ...(pending.profile ? { profile: pending.profile } : {}),
                }),
                this.#timing.revokeMs,
              );
              if (minted?.type === "runner.enrollment.createPhone")
                enrollmentId = minted.enrollmentId;
            }
            const result = await withDeadline(
              pending.enrolled !== false
                ? authenticated({
                    type: "machine.revoke",
                    machineId: pending.runnerId,
                    idempotencyKey: `phone-leave:${pending.runnerId}`,
                  })
                : enrollmentId
                  ? authenticated({
                      type: "runner.enrollment.retire",
                      enrollmentId,
                      idempotencyKey: `phone-leave:${pending.runnerId}`,
                    })
                  : Promise.resolve(null),
              this.#timing.revokeMs,
            );
            if (result?.type === "runner.enrollment.retire" && result.state === "consumed") {
              const revoked = await withDeadline(
                authenticated({
                  type: "machine.revoke",
                  machineId: pending.runnerId,
                  idempotencyKey: `phone-leave:${pending.runnerId}:consumed`,
                }),
                this.#timing.revokeMs,
              );
              if (revoked?.type === "machine.revoke") outcome = "removed";
            } else if (
              result?.type === "machine.revoke" ||
              result?.type === "runner.enrollment.retire"
            )
              outcome = "removed";
          } catch {
            outcome = "unreachable";
          }
        }
      }
      if (outcome === "removed")
        await this.#bridge.completeLeave({ runnerId: pending.runnerId }).catch(() => undefined);
      return outcome;
    })().finally(() => {
      this.#delivering.delete(pending.runnerId);
    });
    this.#delivering.set(pending.runnerId, delivering);
    return delivering;
  }

  #maybeBind(): void {
    const host = this.#host;
    const enrollment = this.#bridge.getSnapshot().enrollment;
    if (
      this.#disposed ||
      host === null ||
      enrollment?.state !== "enrolled" ||
      host.deploymentId !== enrollment.deploymentId ||
      host.hostClient.getSnapshot().devicesAvailable !== true ||
      host.hostClient.getSnapshot().session !== "authenticated"
    ) {
      return;
    }
    const snapshot = host.hostClient.getSnapshot();
    const bound = this.#bound.get(host.deploymentId);
    if (bound && (snapshot.sessionId === undefined || snapshot.sessionId === bound)) return;
    if (bound && snapshot.sessionId !== undefined) this.#bound.delete(host.deploymentId);
    const at = `${this.#hostGeneration}:${enrollment.runnerId}:${snapshot.sessionId ?? ""}`;
    if (this.#binding === at) return;
    if (this.#bindingRetry !== null) clearTimeout(this.#bindingRetry);
    this.#bindingRetry = null;
    this.#binding = at;
    this.#bindingAttempts += 1;
    const fence = this.#fence();
    void (async () => {
      const listed = await host.hostClient.rpc["sessions.list"]({});
      if (!listed.ok || !fence.current()) return;
      const own = listed.data.sessions.find((session) => session.current);
      if (own === undefined) return;
      if (own.deviceId === enrollment.runnerId) {
        this.#bound.set(host.deploymentId, own.id);
        return;
      }
      // A session already bound elsewhere is refused by the Host; never ask.
      if (own.deviceId) return;
      const signed = await this.#bridge.signSessionBinding({
        deploymentId: host.deploymentId,
        sessionId: own.id,
      });
      if (!fence.current() || signed.runnerId !== enrollment.runnerId) return;
      await host.hostClient.bindDeviceSession({
        machineId: enrollment.runnerId,
        proof: { issuedAt: signed.issuedAt, signature: signed.signature },
      });
      if (fence.current()) this.#bound.set(host.deploymentId, own.id);
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.#binding !== at) return;
        this.#binding = null;
        if (
          !this.#disposed &&
          fence.current() &&
          !this.#bound.has(host.deploymentId) &&
          this.#bindingAttempts < 3
        ) {
          this.#bindingRetry = setTimeout(() => {
            this.#bindingRetry = null;
            this.#maybeBind();
          }, 1_000);
        }
      });
  }

  /**
   * Never throws, and never undoes the stop. The signed leave goes first and
   * needs no session; only a Host too old to know it hears the old revoke.
   */
  async #tellHost(
    stopped: IphoneAppsStopped,
    dispatch: HostClient["dispatch"] | null,
  ): Promise<IphoneLeaveOutcome> {
    const snapshot = this.#bridge.getSnapshot();
    const pending = (
      snapshot.pendingLeaves ?? (snapshot.pendingLeave ? [snapshot.pendingLeave] : [])
    ).find(
      (leave) =>
        leave.deploymentId === stopped.deploymentId &&
        ((stopped.leaveRunnerId ?? stopped.machineId) === null ||
          leave.runnerId === (stopped.leaveRunnerId ?? stopped.machineId)),
    );
    if (stopped.left && pending) {
      const delivered = await this.#deliver(pending, dispatch);
      if (delivered === "removed") return "removed";
      this.#notTold(stopped);
      return "unconfirmed";
    }
    if (stopped.machineId === null && stopped.enrollmentId === null) return "removed";
    let told = false;
    if (dispatch !== null) {
      try {
        const result = await withDeadline(
          stopped.machineId !== null
            ? dispatch({
                idempotencyKey: mutationIdempotencyKey("iphone-remove"),
                machineId: stopped.machineId,
                type: "machine.revoke",
              })
            : dispatch({
                enrollmentId: stopped.enrollmentId!,
                idempotencyKey: mutationIdempotencyKey("iphone-enrollment-retire"),
                type: "runner.enrollment.retire",
              }),
          this.#timing.revokeMs,
        );
        told = result?.type === "machine.revoke" || result?.type === "runner.enrollment.retire";
      } catch {
        told = false;
      }
    }
    if (told) return "removed";
    this.#notTold(stopped);
    return "unconfirmed";
  }

  #notTold(stopped: IphoneAppsStopped): void {
    if (this.#disposed) return;
    this.#notice = {
      deploymentId: stopped.deploymentId,
      deploymentName: stopped.deploymentName,
      kind: "not-told",
      name: stopped.name,
    };
    this.#publish();
  }

  #readApprovals(): void {
    const host = this.#host;
    const enrollment = this.#bridge.getSnapshot().enrollment;
    const generation = ++this.#requestRead;
    if (!host || !enrollment || host.deploymentId !== enrollment.deploymentId) {
      this.#approvals = [];
      this.#publish();
      return;
    }
    void host.hostClient.rpc["integration.computer.setup.list"]({})
      .then(unwrapRpcResult)
      .then(({ requests }) => {
        if (generation !== this.#requestRead || this.#disposed) return;
        this.#approvals = requests.flatMap((request) =>
          request.runnerId === enrollment.runnerId &&
          request.kind === "app" &&
          isIphoneAppId(request.definitionId)
            ? [{ ...request, definitionId: request.definitionId, setupRequestId: request.id }]
            : [],
        );
        this.#publish();
      })
      .catch(() => undefined);
  }

  /** Once per attachment of the iPhone's Deployment: move it if that Deployment moved. */
  #maybeRetarget(): void {
    const enrollment = this.#bridge.getSnapshot().enrollment;
    const host = this.#host;
    if (
      this.#disposed ||
      enrollment === null ||
      host === null ||
      host.deploymentId !== enrollment.deploymentId ||
      this.#retargetChecked === this.#hostGeneration
    ) {
      return;
    }
    this.#retargetChecked = this.#hostGeneration;
    const generation = this.#generation;
    const hostGeneration = this.#hostGeneration;
    void (async () => {
      const result = await host.hostClient.rpc["agentPhone.target.get"]({});
      if (
        !result.ok ||
        generation !== this.#generation ||
        hostGeneration !== this.#hostGeneration
      ) {
        return;
      }
      const now = this.#bridge.getSnapshot();
      if (now.enrollment === null || result.data.deploymentId !== now.enrollment.deploymentId) {
        return;
      }
      if (result.data.hostUrl !== now.enrollment.hostUrl || now.issue === "host-unreachable") {
        await this.#bridge.retarget(result.data);
      }
    })().catch(() => undefined);
  }

  #observe(snapshot: IphoneAppsSnapshot): void {
    const online = snapshot.connection === "online";
    if (online && !this.#online) this.#connection += 1;
    this.#online = online;
    const durableRemoval = snapshot.removedFrom;
    if (durableRemoval && this.#removedFrom?.deploymentId !== durableRemoval.deploymentId) {
      this.#removedFrom = durableRemoval;
      this.#bound.delete(durableRemoval.deploymentId);
      this.#generation += 1;
      for (const listener of this.#removedListeners) listener(durableRemoval.deploymentId);
    }
    if (snapshot.enrollment !== null) {
      this.#lastEnrollment = snapshot.enrollment;
    } else if (snapshot.issue === "removed" && this.#lastEnrollment !== null) {
      const removed: RemovedFrom = {
        deploymentId: this.#lastEnrollment.deploymentId,
        deploymentName: this.#lastEnrollment.deploymentName,
      };
      this.#removedFrom = removed;
      this.#lastEnrollment = null;
      this.#bound.delete(removed.deploymentId);
      void this.#removedFile?.write(removed).catch(() => undefined);
      for (const listener of this.#removedListeners) listener(removed.deploymentId);
    }
  }

  #listed(setupRequestId: string): IphoneAppsApproval | undefined {
    return this.#approvals.find((approval) => approval.setupRequestId === setupRequestId);
  }

  #markShown(approval: IphoneAppsApproval): void {
    this.#shown.set(approval.setupRequestId, approval.expiresAt);
    const now = Date.now();
    const kept: ShownApproval[] = [...this.#shown]
      .filter(([, expiresAt]) => Date.parse(expiresAt) > now)
      .map(([id, expiresAt]) => ({ expiresAt, id }))
      .slice(-maxShownApprovals);
    this.#shown = new Map(kept.map(({ expiresAt, id }) => [id, expiresAt]));
    this.#shownWrite = this.#shownWrite
      .then(() => this.#shownFile.write(kept))
      .catch(() => undefined);
  }

  #waitFor<T>(
    read: (snapshot: IphoneAppsSnapshot) => T | undefined,
    timeoutMs: number,
    generation: number,
  ): Promise<T | "superseded" | "timeout"> {
    return new Promise((resolve) => {
      let done = false;
      let unsubscribe: () => void = () => undefined;
      const finish = (value: T | "superseded" | "timeout") => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        this.#wakers.delete(check);
        resolve(value);
      };
      const check = () => {
        if (generation !== this.#generation) return finish("superseded");
        const value = read(this.#bridge.getSnapshot());
        if (value !== undefined) finish(value);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      unsubscribe = this.#bridge.subscribe(check);
      this.#wakers.add(check);
      check();
    });
  }

  #publish(): void {
    if (this.#disposed) return;
    this.#state = this.#derive(this.#bridge.getSnapshot());
    for (const listener of this.#listeners) listener();
  }

  #derive(snapshot: IphoneAppsSnapshot): IphoneAppsState {
    return {
      adding: this.#adding?.deploymentId ?? null,
      answering: [...this.#answering],
      notice: this.#notice,
      // A request for an app being turned on from here is that change's own;
      // prompting for it too would ask the person twice.
      prompt: this.#shownLoaded
        ? (this.#approvals
            .filter(
              ({ definitionId, setupRequestId }) =>
                !this.#shown.has(setupRequestId) &&
                !this.#answering.has(setupRequestId) &&
                !this.#changes.has(definitionId) &&
                !this.#queued.includes(definitionId),
            )
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null)
        : null,
      removedFrom: this.#removedFrom,
      snapshot: { ...snapshot, approvals: this.#approvals },
      changes: Object.fromEntries(this.#changes),
      failures: Object.fromEntries(this.#failures),
      queued: this.#queued,
    };
  }
}

export interface IphoneAppsTiming {
  /** How long the Host's request has to reach the iPhone's own list. */
  readonly approvalWaitMs: number;
  /** How long a stored enrollment has to come online. */
  readonly enrollWaitMs: number;
  /** How long telling the Host that the iPhone stopped may take. */
  readonly revokeMs: number;
}

const defaultTiming: IphoneAppsTiming = {
  approvalWaitMs: 10_000,
  enrollWaitMs: 60_000,
  revokeMs: 10_000,
};

/** An iPhone is minted at most this many enrollments per add. */
const maxEnrollments = 3;

export interface IphoneAppsHost {
  readonly deploymentId: string;
  readonly hostClient: HostClient;
}

export interface IphoneAppsState {
  readonly adding: string | null;
  readonly answering: readonly string[];
  /** Something the person must hear about after the fact, wherever they are. */
  readonly notice: IphoneAppsNotice | null;
  /** The oldest request not yet shown on its own, while requests can be shown. */
  readonly prompt: IphoneAppsApproval | null;
  /** The Host removed this iPhone; the Deployment's row says so until the next add. */
  readonly removedFrom: { readonly deploymentId: string; readonly deploymentName: string } | null;
  readonly snapshot: IphoneAppsSnapshot & { readonly approvals: readonly IphoneAppsApproval[] };
  /** Access being added to an app from here; the app keeps its current access meanwhile. */
  readonly changes: Readonly<Partial<Record<IphoneAppId, IphoneAppChange>>>;
  /** Why the last change from here didn't turn an app on, until the next one. */
  readonly failures: Readonly<Partial<Record<IphoneAppId, IphoneAllowFailure>>>;
  /** Apps chosen with Add still waiting their turn. */
  readonly queued: readonly IphoneAppId[];
}

/**
 * One app's access being added from this iPhone. `unknown` outlives the tap:
 * the Host may or may not have it, and only reading the Host settles it.
 */
export interface IphoneAppChange {
  readonly access: IntegrationAccess;
  readonly phase: "approving" | "asking-iphone" | "checking" | "sending" | "unknown";
  /** The Host's request, once known: reconciling reads back exactly this one. */
  readonly requestId: string | null;
}

/** An outcome that leaves its app without the access asked for, and says why on its row. */
export type IphoneAllowFailure = Extract<
  IphoneAllowOutcome,
  { readonly kind: "blocked" | "not-allowed" | "not-offered" | "waiting" }
>;

export type IphoneAllowOutcome =
  | { readonly kind: "allowed" }
  /** iOS doesn't let Opensteer use the app; nothing was requested or approved. */
  | { readonly kind: "blocked"; readonly permission: IphonePermission }
  /** A change for this app is already under way. */
  | { readonly kind: "busy" }
  /** The Host refused, or the requested access is absent and its request is no longer usable. */
  | { readonly kind: "not-allowed"; readonly message: string }
  /** The Host doesn't list the app, or this build doesn't offer it; nothing was asked. */
  | { readonly by: "host" | "iphone"; readonly kind: "not-offered" }
  | { readonly kind: "superseded" }
  /** The Host holds the request, but this iPhone does not list it yet. */
  | { readonly kind: "waiting" }
  /** Neither confirmed nor refused: `check` reads the Host again. */
  | { readonly kind: "unknown" };

export type IphoneAnswerOutcome =
  | IphoneApprovalOutcome
  | { readonly kind: "blocked"; readonly permission: IphonePermission }
  | { readonly by: "iphone" | "host"; readonly kind: "not-offered" }
  | { readonly kind: "unknown" };

/** The iPhone stopped, but the Host it was added to could not be told. */
export interface IphoneAppsNotice {
  readonly deploymentId: string;
  /** The Host's own name for it, for when this phone no longer lists it. */
  readonly deploymentName: string | null;
  readonly kind: "not-told";
  readonly name: string;
}

export type IphoneAddFailure =
  | { readonly kind: "enrolled-elsewhere" }
  | { readonly kind: "failed" }
  | { readonly kind: "host-mismatch" }
  | { readonly kind: "host-unreachable" }
  | { readonly kind: "host-update" }
  | { readonly kind: "needs-update" }
  | { readonly kind: "profile-mismatch" }
  | { readonly kind: "remote-access-off" }
  | { readonly kind: "too-long" }
  | { readonly kind: "host-said"; readonly message: string };

export type IphoneAddOutcome =
  | { readonly kind: "added"; readonly runnerId: string }
  | { readonly failure: IphoneAddFailure; readonly kind: "failed" }
  | { readonly kind: "superseded" };

type Minted = Extract<
  Awaited<ReturnType<HostClient["dispatch"]>>,
  { readonly type: "runner.enrollment.createPhone" }
>;

const superseded = { kind: "superseded" } as const;
const notOfferedHere = { by: "iphone", kind: "not-offered" } as const;
const requestChanged: IphoneAllowOutcome = {
  kind: "not-allowed",
  message: "That request changed before it was approved. It's waiting below to review again.",
};

interface Fence {
  readonly current: () => boolean;
  readonly generation: number;
}

interface Step {
  readonly access: IntegrationAccess;
  readonly app: IphoneAppId;
  readonly fence: Fence;
  readonly hostClient: HostClient;
  readonly runnerId: string;
}

interface HostRecord {
  readonly connections: readonly {
    readonly computer?: { readonly access: IntegrationAccess; readonly runnerId: string } | null;
    readonly definitionId: string;
    readonly status: string;
  }[];
  readonly requests: readonly {
    readonly access: IntegrationAccess;
    readonly definitionId?: string;
    readonly id: string;
    readonly kind: string;
    readonly runnerId: string;
    readonly reason?: string | null;
    readonly threadTitle?: string | null;
    readonly createdAt?: string;
    readonly expiresAt?: string;
  }[];
}

/** The Host's own requests and connections: what was actually committed. */
async function readHostRecord(hostClient: HostClient): Promise<HostRecord> {
  const [requests, connections] = await Promise.all([
    hostClient.rpc["integration.computer.setup.list"]({}),
    hostClient.rpc["integrations.get"]({}),
  ]);
  if (!requests.ok || !connections.ok) throw new Error("Opensteer could not be read.");
  return { connections: connections.data.connections, requests: requests.data.requests };
}

/** Whether the Host's catalog lists an app for iPhones; it is read again for every tap. */
async function hostLists(hostClient: HostClient, app: IphoneAppId): Promise<boolean> {
  const result = await hostClient.rpc["integration.platform.get"]({});
  if (!result.ok) throw new Error("Opensteer could not be read.");
  return result.data.catalog.some(
    ({ definition }) =>
      definition.id === app && definition.computerApp?.platforms.includes("ios") === true,
  );
}

function covers(
  record: HostRecord,
  runnerId: string,
  app: IphoneAppId,
  access: IntegrationAccess,
): boolean {
  return record.connections.some(
    ({ computer, definitionId, status }) =>
      status !== "revoked" &&
      definitionId === app &&
      computer?.runnerId === runnerId &&
      (computer.access === "read-write" || access === "read"),
  );
}

function notAllowed(error: unknown, fallback: string): IphoneAllowOutcome {
  return {
    kind: "not-allowed",
    message: error instanceof Error && error.message.trim() !== "" ? error.message : fallback,
  };
}
const noLongerWaiting: IphoneAnswerOutcome = {
  kind: "unavailable",
  message: "This request is no longer waiting.",
};

function failed(kind: Exclude<IphoneAddFailure["kind"], "host-said">): IphoneAddOutcome {
  return { failure: { kind }, kind: "failed" };
}

/** A lost answer is asked again once with the same key, so the Host mints once. */
async function mint(
  hostClient: HostClient,
  input: {
    readonly access?: DeviceInitialAccess;
    readonly preparedIdentity?: { readonly runnerId: string; readonly publicKeyPem: string };
    readonly mintKey: string;
    readonly name: string;
  },
): Promise<Minted> {
  const command = {
    idempotencyKey: input.mintKey,
    name: input.name,
    profile: "iphone",
    type: "runner.enrollment.createPhone",
    ...(input.access === undefined ? {} : { access: input.access }),
    ...(input.preparedIdentity === undefined ? {} : { preparedIdentity: input.preparedIdentity }),
  } as const;
  let result: Awaited<ReturnType<HostClient["dispatch"]>>;
  try {
    result = await hostClient.dispatch(command);
  } catch (error) {
    if (isHostRefusal(error)) throw error;
    result = await hostClient.dispatch(command);
  }
  if (result.type !== "runner.enrollment.createPhone") {
    throw new Error("Opensteer did not add this iPhone.");
  }
  return result;
}

function mintFailure(error: unknown): IphoneAddFailure {
  const nativeCode = bridgeErrorCode(error);
  if (
    nativeCode === "remote-access-off" ||
    nativeCode === "host-mismatch" ||
    nativeCode === "host-unreachable"
  ) {
    return { kind: nativeCode };
  }
  if (nativeCode === "enrollment-refused") return { kind: "failed" };
  if (error instanceof HostClientRequestError && error.reason === "personal-remote-access-off") {
    return { kind: "remote-access-off" };
  }
  if (isHostRefusal(error) && error instanceof Error && error.message.trim() !== "") {
    return { kind: "host-said", message: error.message };
  }
  return { kind: isHostRefusal(error) ? "failed" : "host-unreachable" };
}

function issueFailure(issue: IphoneAppsIssue, message: string | null): IphoneAddFailure {
  switch (issue) {
    case "host-mismatch":
    case "host-unreachable":
    case "needs-update":
    case "profile-mismatch":
    case "remote-access-off":
      return { kind: issue };
    case "failed":
      return message === null ? { kind: "failed" } : { kind: "host-said", message };
    case "enrollment-expired":
    case "enrollment-refused":
    case "protocol-error":
    case "removed":
      return { kind: "failed" };
  }
}

/**
 * Whether iOS lets Opensteer give agents an app. Calendar's add-only access is
 * not enough, since everything agents do starts by reading; Contacts and
 * Photos may be limited to what the person chose. Location has no limited
 * access: Allow Once reads as granted until it ends.
 */
/**
 * Whether an app is being turned on or widened from here, or Add's apps are
 * still waiting their turn. Another can't start meanwhile; turning off can.
 */
export function iphoneTurningOn(state: Pick<IphoneAppsState, "changes" | "queued">): boolean {
  return (
    state.queued.length > 0 ||
    Object.values(state.changes).some(
      (change) => change !== undefined && change.phase !== "unknown",
    )
  );
}

export function iphonePermissionAllows(app: IphoneAppId, permission: IphonePermission): boolean {
  return (
    permission === "granted" ||
    (permission === "limited" && (app === "apple-contacts" || app === "iphone-photos"))
  );
}

/** What iOS lets Opensteer do with one app, or null when this build doesn't offer it. */
export function iphonePermissionOf(
  snapshot: Pick<IphoneAppsSnapshot, "permissions">,
  app: IphoneAppId,
): IphonePermission | null {
  const permissions: Readonly<Partial<Record<IphoneAppId, IphonePermission>>> =
    snapshot.permissions;
  return permissions[app] ?? null;
}

/** iOS has not been asked, or Calendar can only add events: the tap asks. */
function needsPrompt(app: IphoneAppId, permission: IphonePermission): boolean {
  return (
    permission === "not-determined" || (app === "apple-calendar" && permission === "write-only")
  );
}

function bridgeErrorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

async function withDeadline<T>(operation: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
