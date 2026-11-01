import {
  HostClientRequestError,
  isHostRefusal,
  mutationIdempotencyKey,
  type HostClient,
} from "@opensteer/client/host";
import type { IntegrationAccess } from "@opensteer/client/integrations";
import type {
  IphoneAppId,
  IphoneAppsApproval,
  IphoneAppsBridge,
  IphoneAppsIssue,
  IphoneAppsSnapshot,
  IphoneApprovalOutcome,
  IphonePermission,
} from "../platform/iphone-apps.js";
import {
  maxShownApprovals,
  type ShownApproval,
  type ShownApprovalsFile,
} from "./shown-approvals-file.js";
import type { IphoneAppsOwner, IphoneAppsStopped } from "./owner.js";

export type { IphoneAppsOwner, IphoneAppsStopped } from "./owner.js";

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
  #approvalKey: IphoneAppsState["approvalKey"] = "idle";
  /** Each transition to online is a new connection, which may register the key once. */
  #connection = 0;
  #disposed = false;
  #generation = 0;
  #host: IphoneAppsHost | null = null;
  #hostGeneration = 0;
  #keyAttempt = -1;
  #lastEnrollment: IphoneAppsSnapshot["enrollment"] = null;
  #notice: IphoneAppsNotice | null = null;
  #online = false;
  #removedFrom: IphoneAppsState["removedFrom"] = null;
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
  }) {
    this.#bridge = options.bridge;
    this.#shownFile = options.shownApprovals;
    this.#timing = { ...defaultTiming, ...options.timing };
    this.#state = this.#derive(options.bridge.getSnapshot());
    this.owner = {
      enrolledDeploymentId: () =>
        this.#bridge.getSnapshot().enrollment?.deploymentId ?? this.#adding?.deploymentId ?? null,
      stop: () => this.#stop(),
      tellHost: (stopped, dispatch) => this.#tellHost(stopped, dispatch),
    };
    this.#observe(options.bridge.getSnapshot());
    this.#detachBridge = options.bridge.subscribe((snapshot) => {
      this.#observe(snapshot);
      this.#publish();
      this.#maybeRegisterKey();
      this.#maybeRetarget();
      this.#maybeRecheck();
    });
  }

  getState = (): IphoneAppsState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Reads which requests were already shown on their own; until then none is. */
  async load(): Promise<void> {
    const stored = await this.#shownFile.read();
    if (this.#disposed) return;
    for (const { expiresAt, id } of stored) this.#shown.set(id, expiresAt);
    this.#shownLoaded = true;
    this.#publish();
  }

  /**
   * The Deployment open on this phone, whose session can register the key and
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
    this.#host = host;
    this.#hostGeneration += 1;
    // An attachment change fences the old operation, but cannot undo an answer
    // already sent. Read it back when its Host is attached again.
    for (const [app, change] of this.#changes) {
      this.#changes.set(app, { ...change, phase: "unknown" });
    }
    this.#publish();
    this.#maybeRetarget();
    this.#maybeRegisterKey();
    this.#maybeRecheck();
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
    const generation = this.#generation;
    const outcome = this.#addNow(input, generation).finally(() => {
      if (this.#adding?.outcome !== outcome) return;
      this.#adding = null;
      this.#publish();
    });
    this.#adding = { deploymentId: input.deploymentId, outcome };
    this.#removedFrom = null;
    this.#publish();
    return outcome;
  }

  /**
   * Turns on the apps chosen with Add, one at a time, so iOS asks about one
   * app at a time and each request is signed on its own. Add listed every app
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
   * the app, nothing is requested or signed. Otherwise the Host's request is
   * signed here once it is the exact request listed, and success is only the
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
   * is still waiting and listed here, the reviewed approval goes on to sign it.
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
   * iOS first when it has not been asked, and signs nothing iOS refuses: the
   * request then stays waiting, to allow later or decline. A Host rollback can
   * leave a request for a removed provider. Check its catalog before a new
   * provider's first prompt when its Deployment is open; otherwise the native
   * stream still allows answering across Deployments. The Host validates the
   * definition again before granting access.
   */
  async answer(input: {
    readonly decision: "allow" | "deny";
    readonly setupRequestId: string;
  }): Promise<IphoneAnswerOutcome> {
    const generation = this.#generation;
    const listed = this.#listed(input.setupRequestId);
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
      const outcome = await this.#bridge.answerApproval({
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

  /** Registration failed; the person asked to try again. */
  retryApprovalKey(): void {
    this.#keyAttempt = -1;
    this.#approvalKey = "idle";
    this.#publish();
    this.#maybeRegisterKey();
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
    this.#generation += 1;
    this.#detachBridge();
    for (const wake of this.#wakers) wake();
    this.#listeners.clear();
  }

  async #addNow(
    input: {
      readonly deploymentId: string;
      readonly hostClient: HostClient;
      readonly name: string;
    },
    generation: number,
  ): Promise<IphoneAddOutcome> {
    const current = () => generation === this.#generation;
    let mintKey: string;
    try {
      ({ mintKey } = await this.#bridge
        .prepare({ deploymentId: input.deploymentId })
        .catch((error: unknown) => {
          if (
            !current() ||
            bridgeErrorCode(error) !== "enrolled-elsewhere" ||
            this.#bridge.getSnapshot().enrollment !== null
          ) {
            throw error;
          }
          // A prepared identity has no enrollment to retire or sharing to stop.
          this.#bridge.disconnect();
          return this.#bridge.prepare({ deploymentId: input.deploymentId });
        }));
    } catch (error) {
      if (!current()) return superseded;
      return failed(
        bridgeErrorCode(error) === "enrolled-elsewhere" ? "enrolled-elsewhere" : "failed",
      );
    }
    for (let attempt = 1; ; attempt += 1) {
      if (!current()) return superseded;
      let minted: Minted;
      try {
        minted = await mint(input.hostClient, { mintKey, name: input.name });
      } catch (error) {
        return current() ? { failure: mintFailure(error), kind: "failed" } : superseded;
      }
      if (!current()) return superseded;
      if (minted.pairing.deploymentId !== input.deploymentId) return failed("host-mismatch");
      try {
        await this.#bridge.enroll({
          enrollmentId: minted.enrollmentId,
          enrollmentToken: minted.token,
          expiresAt: minted.expiresAt,
          name: input.name,
          pairing: minted.pairing,
        });
      } catch (error) {
        if (!current()) return superseded;
        return failed(bridgeErrorCode(error) === "wrong-deployment" ? "host-mismatch" : "failed");
      }
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

  /** Signs the exact request the Host named, once this iPhone lists it as reviewed. */
  async #approve(input: Step & { readonly requestId: string }): Promise<IphoneAllowOutcome> {
    this.#setChange(input.app, {
      access: input.access,
      phase: "approving",
      requestId: input.requestId,
    });
    const listed = await this.#waitFor(
      (snapshot) =>
        snapshot.approvals.find(({ setupRequestId }) => setupRequestId === input.requestId),
      this.#timing.approvalWaitMs,
      input.fence.generation,
    );
    if (listed === "superseded" || !input.fence.current()) return superseded;
    if (listed === "timeout") return { kind: "waiting" };
    // Only the exact request that was reviewed is signed: a request for this
    // app at another access is another decision, and stays waiting for it.
    if (listed.definitionId !== input.app || listed.access !== input.access) return requestChanged;
    // iPhone Settings may have changed while the request travelled.
    const permission = await this.#readyPermission(input.app, input.fence.current);
    if (!input.fence.current()) return superseded;
    if (permission === "not-offered") return notOfferedHere;
    if (permission !== null) return { kind: "blocked", permission };
    const outcome = await this.#bridge.answerApproval({
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
        // The signature may have reached the Host even though its reply did not.
        return this.#reconcile({ ...input, resign: false });
    }
  }

  /**
   * Settles a change from the Host's own requests and connections. `resign`
   * lets a request that is still waiting go on to be signed; after a signature
   * whose reply was lost it does not, so one tap never signs twice.
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
   * approve, so nothing is signed or asked for without a tap.
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
    // Everything awaiting is fenced before the native stop, which returns only
    // once nothing new can run.
    this.#generation += 1;
    this.#adding = null;
    this.#changes.clear();
    this.#failures.clear();
    this.#queued = [];
    this.#approvalKey = "idle";
    const ids = this.#bridge.disconnect();
    for (const wake of this.#wakers) wake();
    this.#publish();
    const deploymentId = enrollment?.deploymentId ?? ids.deploymentId ?? adding;
    if (deploymentId === null) return null;
    return {
      deploymentId,
      deploymentName: enrollment?.deploymentName ?? null,
      enrollmentId: enrollment?.state === "pending" ? enrollment.enrollmentId : null,
      machineId: enrollment?.state === "enrolled" ? enrollment.runnerId : null,
      name: enrollment?.name ?? before.deviceName,
    };
  }

  /** Never throws, and never undoes the stop: the Host learns of it at most ten seconds late. */
  async #tellHost(
    stopped: IphoneAppsStopped,
    dispatch: HostClient["dispatch"] | null,
  ): Promise<void> {
    if (stopped.machineId === null && stopped.enrollmentId === null) return;
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
    if (told || this.#disposed) return;
    this.#notice = {
      deploymentId: stopped.deploymentId,
      deploymentName: stopped.deploymentName,
      kind: "not-told",
      name: stopped.name,
    };
    this.#publish();
  }

  #maybeRegisterKey(): void {
    const snapshot = this.#bridge.getSnapshot();
    const enrollment = snapshot.enrollment;
    const key = snapshot.approvalKey;
    const host = this.#host;
    if (
      this.#disposed ||
      snapshot.connection !== "online" ||
      enrollment?.state !== "enrolled" ||
      key === null ||
      key.registered ||
      host === null ||
      host.deploymentId !== enrollment.deploymentId ||
      this.#keyAttempt === this.#connection
    ) {
      return;
    }
    this.#keyAttempt = this.#connection;
    const generation = this.#generation;
    const connection = this.#connection;
    this.#approvalKey = "registering";
    this.#publish();
    void host.hostClient
      .dispatch({
        idempotencyKey: mutationIdempotencyKey("iphone-approval-key"),
        input: { publicKey: key.publicKey, runnerId: enrollment.runnerId },
        type: "integration.computer.approval-key.set",
      })
      .then(
        (result) => (result.type === "integration.computer.approval-key.set" ? "idle" : "failed"),
        () => "failed" as const,
      )
      .then((status) => {
        if (generation !== this.#generation || connection !== this.#connection) return;
        this.#approvalKey = status;
        this.#publish();
      });
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
    if (snapshot.enrollment !== null) {
      this.#lastEnrollment = snapshot.enrollment;
    } else if (snapshot.issue === "removed" && this.#lastEnrollment !== null) {
      this.#removedFrom = {
        deploymentId: this.#lastEnrollment.deploymentId,
        deploymentName: this.#lastEnrollment.deploymentName,
      };
      this.#lastEnrollment = null;
    } else {
      this.#lastEnrollment = null;
    }
  }

  #listed(setupRequestId: string): IphoneAppsApproval | undefined {
    return this.#bridge
      .getSnapshot()
      .approvals.find((approval) => approval.setupRequestId === setupRequestId);
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
      approvalKey: this.#approvalKey,
      notice: this.#notice,
      prompt: this.#shownLoaded
        ? (snapshot.approvals
            .filter(
              ({ setupRequestId }) =>
                !this.#shown.has(setupRequestId) && !this.#answering.has(setupRequestId),
            )
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null)
        : null,
      removedFrom: this.#removedFrom,
      snapshot,
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
  /** Whether registering the approval key with the open Deployment failed. */
  readonly approvalKey: "failed" | "idle" | "registering";
  /** Something the person must hear about after the fact, wherever they are. */
  readonly notice: IphoneAppsNotice | null;
  /** The oldest request not yet shown on its own, while requests can be shown. */
  readonly prompt: IphoneAppsApproval | null;
  /** The Host removed this iPhone; the Deployment's row says so until the next add. */
  readonly removedFrom: { readonly deploymentId: string; readonly deploymentName: string } | null;
  readonly snapshot: IphoneAppsSnapshot;
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
  /** iOS doesn't let Opensteer use the app; nothing was requested or signed. */
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
  input: { readonly mintKey: string; readonly name: string },
): Promise<Minted> {
  const command = {
    idempotencyKey: input.mintKey,
    name: input.name,
    profile: "iphone",
    type: "runner.enrollment.createPhone",
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
