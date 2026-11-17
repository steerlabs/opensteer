import { randomUUID } from "node:crypto";
import {
  ComputerUseErrorCodeSchema,
  IphoneScreenDispatchActParamsSchema,
  IphoneScreenObservationResultSchema,
  PhoneDisplayInstalledAppsParamsSchema,
  phoneDisplayTimedActionMs,
  type ComputerUseErrorCode,
  type DeviceCapabilityReason,
  type DeviceDriverTarget,
  type DeviceScreenDriverAssignment,
  type IphoneScreenAction,
  type IphoneScreenActResult,
  type IphoneScreenDispatchActParams,
  type IphoneScreenObservation,
  type PhoneDisplayDispatchObserveParams,
  type PhoneDisplayInstalledAppsParams,
} from "@opensteer/protocol";
import {
  iphoneScreenshotHiddenReason,
  iphoneRunnerResults,
  type IphoneNativeAction,
  type IphoneNativeObservation,
  type IphoneRunnerEvent,
  type IphoneRunnerResult,
} from "@opensteer/protocol/iphone-bridge";
import type { ComputerUseHandler } from "./computer-use-handler.js";
import { ComputerUseBridgeError } from "./computer-use-bridge-client.js";
import type {
  PhoneScreenContext,
  PhoneScreenDriver,
  PhoneScreenDriverConnection,
  PhoneScreenDriverEvent,
  PhoneScreenDisplayFrame,
  PhoneScreenOwnerView,
  PhoneScreenCancel,
  PhoneScreenStopRecorded,
} from "./phone-screen-driver.js";
import { phoneLabel, phoneTree } from "./phone-tree.js";

export type IphoneScreenBridge = Pick<
  ComputerUseHandler,
  "iphoneRequest" | "onIphoneEvent" | "onIphoneConnection"
>;
type ConnectOptions = Parameters<PhoneScreenDriver["connect"]>[0];
type AssignmentLane = { tail: Promise<void> };
type Session = Pick<PhoneScreenContext, "deviceId" | "driverGeneration" | "sessionId" | "runId"> & {
  access: PhoneScreenContext["access"];
  epoch: number;
};
type Snapshot = {
  native: IphoneNativeObservation;
  public: IphoneScreenObservation;
  session: Session;
};
type Work = { context: PhoneScreenContext; abort: AbortController };
type Phone = {
  assignment: DeviceScreenDriverAssignment;
  target: IphoneRunnerResult<"iphone.targets">["targets"][number] | undefined;
  session: Session | undefined;
  latest: Snapshot | undefined;
  tail: Promise<unknown>;
  revision: number;
  work: Set<Work>;
  apps: Set<string>;
  closing?: Promise<void>;
};

export function iphoneCapabilityReason(reason: string | null | undefined): DeviceCapabilityReason {
  switch (reason) {
    case "candidate-gone":
    case "phone-disconnected":
    case "wifi-phone-not-found":
      return { kind: "not-connected" };
    case "trust-required":
    case "trust-pending":
    case "trust-denied":
    case "pairing-revoked":
    case "wifi-pairing-required":
      return { kind: "trust-required" };
    case "developer-mode-required":
    case "developer-mode-status-unknown":
      return { kind: "developer-mode-required" };
    case "phone-locked":
    case "wake-on-phone-required":
      return { kind: "locked" };
    case "lock-state-unknown":
      return { kind: "protected" };
    case "cancelled":
    case "phone-in-use":
    case "input-media-conflict":
    case "owned-by-another-deployment":
      return { kind: "paused" };
    case "local-network-permission-required":
      return { kind: "permission-required" };
    case "developer-image-missing":
    case "developer-image-incompatible":
    case "developer-image-mount-failed":
    case "personalization-network-unavailable":
    case "personalization-rejected":
    case "wifi-not-enabled":
      return { kind: "setup-required" };
    case "usbmux-unavailable":
    case "native-service-missing":
    case "input-media-session-required":
    case "not-initialized":
      return { kind: "helper-unavailable" };
    case "unsupported":
    case "unsupported-ios":
    case "protocol-unsupported":
    case "qualification-required":
    case "wifi-transport-unsupported":
    case "display-configuration-unsupported":
      return { kind: "unsupported" };
    default:
      return { kind: "runtime-failed" };
  }
}
function failure(code: ComputerUseErrorCode, message: string): never {
  throw new ComputerUseBridgeError(code, message);
}
function errorBody(error: unknown) {
  return error instanceof ComputerUseBridgeError
    ? { code: error.code, message: error.message }
    : { code: "failed" as const, message: "The iPhone request failed." };
}
function nativeError(code: string, effect: string) {
  const parsed = ComputerUseErrorCodeSchema.safeParse(code);
  return {
    code:
      effect !== "not-started"
        ? ("outcome-unknown" as const)
        : parsed.success
          ? parsed.data
          : code === "cancelled"
            ? ("stopped-by-user" as const)
            : code === "stale-native-epoch"
              ? ("stale-observation" as const)
              : ("failed" as const),
    message:
      effect !== "not-started"
        ? "iPhone input may have been sent; observe before continuing."
        : `iPhone: ${code}.`,
  };
}
function ref(context: PhoneScreenContext): Session {
  return {
    deviceId: context.deviceId,
    driverGeneration: context.driverGeneration,
    sessionId: context.sessionId,
    runId: context.runId,
    access: context.access,
    epoch: 0,
  };
}
function sessionParams(session: Session) {
  return {
    deviceId: session.deviceId,
    driverGeneration: session.driverGeneration,
    sessionId: session.sessionId,
    runId: session.runId,
  };
}
function sameSession(a: Session, b: { sessionId: string; runId: string }) {
  return a.sessionId === b.sessionId && a.runId === b.runId;
}

export class IphoneScreenDriver implements PhoneScreenDriver {
  readonly #bridge: IphoneScreenBridge;
  readonly #now: () => number;
  #connection: IphoneScreenConnection | undefined;
  readonly #connections = new Set<IphoneScreenConnection>();
  readonly #lanes = new Map<string, Promise<unknown>>();
  readonly #assignments: AssignmentLane = { tail: Promise.resolve() };
  #stopped = false;
  constructor(options: { bridge: IphoneScreenBridge; now?: () => number }) {
    this.#bridge = options.bridge;
    this.#now = options.now ?? Date.now;
  }
  connect(options: ConnectOptions): PhoneScreenDriverConnection {
    if (this.#stopped) failure("no-session", "The iPhone driver has stopped.");
    const previous = this.#connection;
    previous?.detach();
    if (previous) void previous.settle().then(() => this.#connections.delete(previous));
    const connection = new IphoneScreenConnection(
      this.#bridge,
      this.#now,
      options,
      this.#lanes,
      this.#assignments,
    );
    this.#connection = connection;
    this.#connections.add(connection);
    return connection;
  }
  async shutdown() {
    this.#stopped = true;
    for (const connection of this.#connections) connection.detach();
    await Promise.all([...this.#connections].map((c) => c.settle()));
    this.#connections.clear();
  }
}

class IphoneScreenConnection implements PhoneScreenDriverConnection {
  readonly #bridge: IphoneScreenBridge;
  readonly #now: () => number;
  readonly #options: ConnectOptions;
  readonly #phones = new Map<string, Phone>();
  readonly #cleanup = new Set<Promise<unknown>>();
  readonly #unsub: (() => void)[];
  readonly #lanes: Map<string, Promise<unknown>>;
  readonly #assignments: AssignmentLane;
  #alive = true;
  #assignmentRevision = 0;
  #retainedDeviceIds: readonly string[] | undefined;
  #sync: Promise<void> = Promise.resolve();
  constructor(
    bridge: IphoneScreenBridge,
    now: () => number,
    options: ConnectOptions,
    lanes: Map<string, Promise<unknown>>,
    assignments: AssignmentLane,
  ) {
    this.#bridge = bridge;
    this.#now = now;
    this.#options = options;
    this.#lanes = lanes;
    this.#assignments = assignments;
    this.#unsub = [
      bridge.onIphoneEvent((event) => this.#event(event)),
      bridge.onIphoneConnection((state) => {
        if (!this.#alive) return;
        if (state === "lost")
          for (const phone of this.#phones.values()) {
            this.#invalidate(phone, false);
            phone.target = undefined;
            this.#status(phone, "phone-disconnected");
          }
        if (state === "connected") this.#pushAssignments();
      }),
    ];
  }
  replaceAssignments(
    assignments: readonly DeviceScreenDriverAssignment[],
    retainedDeviceIds?: readonly string[],
  ) {
    if (!this.#alive) return;
    this.#retainedDeviceIds = retainedDeviceIds;
    const wanted = new Map<string, DeviceScreenDriverAssignment>(
      assignments.map((a) => [a.deviceId, a]),
    );
    for (const [id, phone] of this.#phones) {
      if (wanted.get(id)?.generation === phone.assignment.generation) continue;
      this.#invalidate(phone, true);
      this.#phones.delete(id);
    }
    for (const assignment of assignments)
      if (!this.#phones.has(assignment.deviceId)) {
        const phone: Phone = {
          assignment,
          target: undefined,
          session: undefined,
          latest: undefined,
          tail: Promise.resolve(),
          revision: 0,
          work: new Set(),
          apps: new Set(),
        };
        this.#phones.set(assignment.deviceId, phone);
        this.#status(phone, "phone-disconnected");
      }
    this.#pushAssignments();
  }
  #pushAssignments() {
    const revision = ++this.#assignmentRevision;
    this.#sync = this.#assignments.tail
      .catch(() => undefined)
      .then(async () => {
        if (!this.#alive || revision !== this.#assignmentRevision) return;
        try {
          const result = await this.#bridge.iphoneRequest(
            "iphone.targets",
            {
              assignments: [...this.#phones.values()].map((p) => p.assignment),
              ...(this.#retainedDeviceIds
                ? { retainedDeviceIds: [...this.#retainedDeviceIds] }
                : {}),
            },
            { deadline: this.#now() + 5000 },
          );
          if (!this.#alive || revision !== this.#assignmentRevision) return;
          for (const phone of this.#phones.values()) {
            if (
              result.targets.some(
                (target) =>
                  target.deviceId === phone.assignment.deviceId &&
                  target.driverGeneration === phone.assignment.generation,
              )
            )
              continue;
            if (phone.target || phone.session) this.#invalidate(phone, true);
            phone.target = undefined;
            this.#status(phone, "phone-disconnected");
          }
          for (const target of result.targets) this.#target(target);
        } catch {
          if (this.#alive && revision === this.#assignmentRevision)
            for (const phone of this.#phones.values()) {
              if (phone.target || phone.session) this.#invalidate(phone, true);
              phone.target = undefined;
              this.#status(phone, "native-service-failed");
            }
        }
      });
    this.#assignments.tail = this.#sync;
  }
  #phone(context: DeviceDriverTarget): Phone {
    const phone = this.#phones.get(context.deviceId);
    if (!this.#alive || phone?.assignment.generation !== context.driverGeneration)
      failure("no-session", "That iPhone driver assignment has ended.");
    return phone;
  }
  #check(phone: Phone, work: Work, revision: number) {
    this.#phone(work.context);
    if (phone.revision !== revision || work.abort.signal.aborted || work.context.signal.aborted)
      failure("stopped-by-user", "The iPhone request was cancelled.");
    if (this.#now() >= work.context.deadline)
      failure("failed", "The iPhone request deadline elapsed.");
  }
  async #run<T>(
    context: PhoneScreenContext,
    operation: (phone: Phone, work: Work, check: () => void) => Promise<T>,
  ): Promise<T> {
    const phone = this.#phone(context);
    const revision = phone.revision;
    const work: Work = { context, abort: new AbortController() };
    const cancel = () => {
      work.abort.abort();
      phone.latest = undefined;
      if (phone.session && sameSession(phone.session, context)) this.#cancelSession(phone);
    };
    context.signal.addEventListener("abort", cancel, { once: true });
    phone.work.add(work);
    const pending = (this.#lanes.get(context.deviceId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        await this.#sync;
        const check = () => this.#check(phone, work, revision);
        check();
        return operation(phone, work, check);
      });
    phone.tail = pending;
    this.#lanes.set(context.deviceId, pending);
    void pending
      .finally(() => {
        if (this.#lanes.get(context.deviceId) === pending) this.#lanes.delete(context.deviceId);
      })
      .catch(() => undefined);
    this.#track(pending.catch(() => undefined));
    try {
      return await pending;
    } finally {
      phone.work.delete(work);
      context.signal.removeEventListener("abort", cancel);
    }
  }
  async #open(phone: Phone, work: Work, check: () => void) {
    const context = work.context;
    if (context.access !== "read" && context.access !== "read-write")
      failure("permission-required", "This request has no iPhone screen access.");
    if (
      phone.session &&
      (!sameSession(phone.session, context) || phone.session.access !== context.access)
    )
      failure("busy", "Another session holds this iPhone screen.");
    if (phone.session) return phone.session;
    const session = ref(context);
    phone.session = session;
    try {
      const opened = await this.#bridge.iphoneRequest(
        "iphone.session.open",
        { ...sessionParams(session), access: context.access === "read" ? "observe" : "control" },
        { deadline: context.deadline, signal: work.abort.signal },
      );
      check();
      session.epoch = opened.nativeEpoch;
      if (phone.target) phone.target = { ...phone.target, nativeEpoch: opened.nativeEpoch };
      return session;
    } catch (error) {
      if (phone.session === session) this.#cancelSession(phone);
      throw error;
    }
  }
  async #observe(phone: Phone, work: Work, check: () => void, includeScreenshot: boolean) {
    phone.latest = undefined;
    const session = await this.#open(phone, work, check);
    const native = iphoneRunnerResults["iphone.observe"].parse(
      await this.#bridge.iphoneRequest(
        "iphone.observe",
        { ...sessionParams(session), includeScreenshot },
        { deadline: work.context.deadline, signal: work.abort.signal },
      ),
    );
    check();
    if (
      native.nativeEpoch !== session.epoch ||
      (phone.target && phone.target.nativeEpoch !== native.nativeEpoch)
    ) {
      phone.latest = undefined;
      failure("stale-observation", "The iPhone connection changed; observe again.");
    }
    if (
      native.geometry.rotation === null ||
      native.state.rotation !== native.geometry.rotation ||
      native.state.displayId !== native.geometry.displayId
    )
      failure("unsupported", "The iPhone display geometry is unavailable.");
    const hidden = iphoneScreenshotHiddenReason(native);
    const observation = IphoneScreenObservationResultSchema.parse({
      observation: {
        capturedAt: new Date(this.#now()).toISOString(),
        observationId: randomUUID(),
        geometry: { width: native.geometry.width, height: native.geometry.height },
        rotation: native.geometry.rotation,
        locked: native.state.lock === "unknown" ? null : native.state.lock === "locked",
        secureLock: null,
        screen: native.state.display === "off" ? "off" : "on",
        foreground: native.foreground
          ? { appId: native.foreground.appId, label: phoneLabel(native.foreground.label) || null }
          : null,
        screenshot:
          hidden || !includeScreenshot || !native.screenshot
            ? null
            : {
                mime: native.screenshot.mimeType,
                base64: native.screenshot.base64,
                width: native.screenshot.width,
                height: native.screenshot.height,
              },
        screenshotUnavailable:
          hidden ?? (!includeScreenshot ? "not-requested" : native.screenshot ? null : "failed"),
        ...(hidden ? { tree: "", elementCount: 0, truncated: false } : phoneTree(native)),
      },
    }).observation;
    phone.latest = { native, public: observation, session };
    this.#status(
      phone,
      hidden === "locked"
        ? "phone-locked"
        : hidden === "protected"
          ? "lock-state-unknown"
          : phone.target?.ready
            ? null
            : (phone.target?.reason ?? "not-initialized"),
      native,
    );
    return { observation };
  }
  observe(context: PhoneScreenContext, params: PhoneDisplayDispatchObserveParams) {
    return this.#run(context, async (phone, work, check) => {
      try {
        return await this.#observe(phone, work, check, params.includeScreenshot);
      } catch (error) {
        this.#cancelSession(phone);
        throw error;
      }
    });
  }
  async act(
    context: PhoneScreenContext,
    input: IphoneScreenDispatchActParams,
  ): Promise<IphoneScreenActResult> {
    try {
      return await this.#run(context, async (phone, work, check) => {
        const params = IphoneScreenDispatchActParamsSchema.parse(input);
        if (context.access !== "read-write")
          failure("permission-required", "This iPhone session permits observation only.");
        const snapshot = phone.latest;
        if (
          !snapshot ||
          snapshot.public.observationId !== params.observationId ||
          !sameSession(snapshot.session, context) ||
          snapshot.session !== phone.session
        )
          failure("stale-observation", "Observe this iPhone again before acting.");
        const groups = this.#actions(phone, snapshot, params.actions);
        const actions = groups.flat();
        if (actions.length > 32)
          failure(
            "unsupported",
            "This iPhone input batch needs more than 32 gestures; use a smaller scroll amount.",
          );
        const duration = params.actions.reduce((sum, a) => sum + phoneDisplayTimedActionMs(a), 0);
        if (this.#now() + duration + 1000 >= context.deadline)
          failure("failed", "There is not enough time for input and a resulting observation.");
        check();
        phone.latest = undefined;
        let performed: string[] = [];
        let error: IphoneScreenActResult["error"] = null;
        try {
          const result = await this.#bridge.iphoneRequest(
            "iphone.perform",
            {
              ...sessionParams(snapshot.session),
              nativeEpoch: snapshot.native.nativeEpoch,
              geometryRevision: snapshot.native.geometryRevision,
              observationToken: snapshot.native.observationToken,
              actions,
            },
            { deadline: context.deadline - 1000, signal: work.abort.signal },
          );
          const receipt = "error" in result ? result.error : result;
          let completed = receipt.completedSteps;
          for (const [index, action] of params.actions.entries()) {
            const count = groups[index]!.length;
            if (action.type === "scroll" && completed > 0)
              performed.push(
                completed >= count
                  ? `Sent ${action.amount} scroll steps.`
                  : `Sent ${completed} of ${action.amount} scroll steps.`,
              );
            else if (completed >= count)
              performed.push(action.type === "wait" ? "Waited." : `Sent ${action.type} input.`);
            completed -= count;
            if (completed < 0) break;
          }
          if ("error" in result)
            error = nativeError(
              result.error.code,
              result.error.completedSteps > 0 ? "submitted" : result.error.effect,
            );
          else if (receipt.completedSteps !== actions.length)
            error = {
              code: "outcome-unknown",
              message: "The iPhone did not confirm the whole input batch; observe again.",
            };
        } catch (caught) {
          error = errorBody(caught);
        }
        let observation: IphoneScreenObservation | null = null;
        try {
          check();
          observation = (await this.#observe(phone, work, check, params.includeScreenshot))
            .observation;
        } catch (caught) {
          error ??= errorBody(caught);
          this.#cancelSession(phone);
        }
        return { performed, error, observation };
      });
    } catch (error) {
      return { performed: [], error: errorBody(error), observation: null };
    }
  }
  #actions(
    phone: Phone,
    snapshot: Snapshot,
    actions: IphoneScreenAction[],
  ): IphoneNativeAction[][] {
    const point = (target: { index: number } | { x: number; y: number }) => {
      if ("index" in target)
        failure(
          "unsupported",
          "iPhone element coordinates are unqualified; use screenshot pixels.",
        );
      const { width, height } = snapshot.native.geometry;
      if (target.x < 0 || target.y < 0 || target.x > width - 1 || target.y > height - 1)
        failure("stale-observation", "The target is outside this iPhone observation.");
      return { x: target.x, y: target.y };
    };
    return actions.map((action): IphoneNativeAction[] => {
      const capabilities = phone.target?.capabilities;
      const reason = action.type === "launch" ? capabilities?.launch : capabilities?.act;
      if (reason || (!capabilities && !phone.target?.ready))
        failure(
          "unsupported",
          `iPhone ${action.type} is unavailable: ${reason ?? phone.target?.reason ?? "not-initialized"}.`,
        );
      if (
        ["locked", "protected", "screen-off"].includes(
          snapshot.public.screenshotUnavailable ?? "",
        ) &&
        action.type !== "wait" &&
        action.type !== "wake"
      )
        failure("permission-required", "Unlock this iPhone on the phone before controlling it.");
      if (
        snapshot.public.screenshotUnavailable === "opensteer-app" &&
        action.type !== "navigate" &&
        action.type !== "wait"
      )
        failure(
          "permission-required",
          "Navigate away from Opensteer before controlling the screen.",
        );
      switch (action.type) {
        case "tap":
          if (action.count !== 1)
            failure("unsupported", "Double tap is not qualified on this iPhone.");
          return [{ kind: "tap", target: { point: point(action.target) } }];
        case "longPress":
          return [
            {
              kind: "longPress",
              target: { point: point(action.target) },
              durationMs: action.durationMs,
            },
          ];
        case "swipe":
          return [
            {
              kind: "swipe",
              target: { point: point(action.from) },
              to: point(action.to),
              durationMs: action.durationMs,
            },
          ];
        case "drag":
          if (action.holdMs > 2000)
            failure("unsupported", "This iPhone supports drag holds up to 2000 ms.");
          return [
            {
              kind: "drag",
              target: { point: point(action.from) },
              to: point(action.to),
              durationMs: action.durationMs,
              holdMs: action.holdMs,
            },
          ];
        case "scroll": {
          const at = point(action.target);
          const { width, height } = snapshot.native.geometry;
          if (width < 4 || height < 4)
            failure("unsupported", "The iPhone viewport is too small to scroll safely.");
          // AX frames and safe-area insets are unqualified; keep gestures in the image's central half.
          const left = Math.floor(width / 4),
            right = Math.floor((width * 3) / 4);
          const top = Math.floor(height / 4),
            bottom = Math.floor((height * 3) / 4);
          const x = Math.max(left, Math.min(right, at.x));
          const y = Math.max(top, Math.min(bottom, at.y));
          const [from, to] = {
            down: [
              { x, y: bottom },
              { x, y: top },
            ],
            up: [
              { x, y: top },
              { x, y: bottom },
            ],
            right: [
              { x: right, y },
              { x: left, y },
            ],
            left: [
              { x: left, y },
              { x: right, y },
            ],
          }[action.direction];
          return Array.from({ length: action.amount }, () => ({
            kind: "swipe",
            target: { point: from! },
            to: to!,
            durationMs: phoneDisplayTimedActionMs(action) / action.amount,
          }));
        }
        case "navigate": {
          const button = snapshot.native.buttons.find((b) => b === action.to);
          if (!button)
            failure("unsupported", "This iPhone does not advertise that navigation button.");
          return [{ kind: "navigate", button }];
        }
        case "launch":
          if (!phone.apps.has(action.appId))
            failure("app-not-found", "Choose an appId returned by this iPhone's installed_apps.");
          return [{ kind: "launch", appId: action.appId }];
        case "wake":
          if (snapshot.native.state.display !== "on")
            failure("permission-required", "Wake this iPhone on the phone.");
          return [{ kind: "wake" }];
        case "wait":
          return [{ kind: "wait", durationMs: action.ms }];
        case "type":
        case "clear":
          return failure("unsupported", `This iPhone does not support ${action.type}.`);
      }
    });
  }
  async installedApps(context: PhoneScreenContext, input: PhoneDisplayInstalledAppsParams) {
    return this.#run(context, async (phone, work, check) => {
      const params = PhoneDisplayInstalledAppsParamsSchema.parse(input);
      if (params.query.length > 200)
        failure("unsupported", "The iPhone app query must be at most 200 characters.");
      const page = await this.#bridge.iphoneRequest(
        "iphone.installedApps",
        {
          deviceId: context.deviceId,
          driverGeneration: context.driverGeneration,
          filter: params.query,
          limit: params.limit,
          offset: Math.min(params.offset, 10000),
        },
        { deadline: context.deadline, signal: work.abort.signal },
      );
      check();
      if (page.offset !== Math.min(params.offset, 10000))
        failure("failed", "The iPhone app page did not match the requested offset.");
      const apps = page.apps.map((a) => ({
        appId: a.appId,
        label: phoneLabel(a.label, 199) || a.appId,
      }));
      for (const app of apps) phone.apps.add(app.appId);
      return { apps, total: page.total };
    });
  }
  async close(context: PhoneScreenContext) {
    const phone = this.#phone(context);
    if (phone.session && !sameSession(phone.session, context))
      failure("no-session", "That iPhone session has ended.");
    this.#invalidate(phone, true);
    await phone.tail.catch(() => undefined);
    await phone.closing;
    return {};
  }
  async ownerView(frame: PhoneScreenOwnerView, _signal: AbortSignal, _receivedAt: number) {
    this.#phone(frame);
    return {
      viewId: frame.viewId,
      generation: frame.generation,
      kind: "unavailable" as const,
      reason: "unsupported",
    };
  }
  display(frame: PhoneScreenDisplayFrame) {
    this.#phone(frame);
    if (frame.type === "host.integrations.display.input") {
      this.#emit({
        type: "runner.integrations.display.input-result",
        deviceId: frame.deviceId,
        driverGeneration: frame.driverGeneration,
        streamId: frame.streamId,
        ...(frame.sessionId ? { sessionId: frame.sessionId } : { source: frame.source! }),
        geometry: frame.geometry,
        sequence: frame.sequence,
        outcome: "refused",
        reason: "unsupported",
      });
      return;
    }
    if (frame.type === "host.integrations.display.power") {
      this.#emit({
        type: "runner.integrations.display.power-result",
        deviceId: frame.deviceId,
        driverGeneration: frame.driverGeneration,
        streamId: frame.streamId,
        source: frame.source,
        sequence: frame.sequence,
        outcome: "refused",
        reason: "unsupported",
      });
      return;
    }
    if (
      frame.type === "host.integrations.display.start" ||
      frame.type === "host.integrations.display.refresh"
    )
      this.#emit({
        deviceId: frame.deviceId,
        driverGeneration: frame.driverGeneration,
        type: "runner.integrations.display.state",
        streamId: frame.streamId,
        display: "main",
        state: "failed",
        reason: "target-unavailable",
        generation: 0,
        width: 0,
        height: 0,
        rotation: 0,
      });
  }
  cancel(frame: PhoneScreenCancel) {
    const phone = this.#phone(frame);
    for (const work of phone.work)
      if (work.context.requestId === frame.requestId) {
        work.abort.abort();
        phone.latest = undefined;
        if (phone.session && sameSession(phone.session, work.context)) this.#cancelSession(phone);
      }
  }
  stopRecorded(frame: PhoneScreenStopRecorded) {
    this.#phone(frame);
  }
  detach() {
    if (!this.#alive) return;
    this.#alive = false;
    ++this.#assignmentRevision;
    for (const unsub of this.#unsub) unsub();
    for (const phone of this.#phones.values()) this.#invalidate(phone, true);
    this.#phones.clear();
    this.#sync = this.#assignments.tail
      .catch(() => undefined)
      .then(async () => {
        await this.#bridge
          .iphoneRequest("iphone.targets", { assignments: [] }, { deadline: this.#now() + 5000 })
          .catch(() => undefined);
      });
    this.#assignments.tail = this.#sync;
  }
  async settleCleanup() {
    while (this.#cleanup.size) await Promise.all(this.#cleanup);
  }
  async settle() {
    await this.#sync;
    await this.settleCleanup();
  }
  #track(promise: Promise<unknown>) {
    this.#cleanup.add(promise);
    void promise.finally(() => this.#cleanup.delete(promise)).catch(() => undefined);
  }
  #cancelSession(phone: Phone) {
    const session = phone.session;
    phone.session = undefined;
    phone.latest = undefined;
    if (!session) return;
    const cancelled = this.#bridge
      .iphoneRequest("iphone.cancel", sessionParams(session), { deadline: this.#now() + 5000 })
      .catch(() => undefined);
    const released = Promise.all([cancelled, phone.tail.catch(() => undefined)]).then(async () => {
      await this.#bridge
        .iphoneRequest("iphone.session.close", sessionParams(session), {
          deadline: this.#now() + 5000,
        })
        .catch(() => undefined);
    });
    phone.closing = released;
    this.#lanes.set(session.deviceId, released);
    void released.finally(() => {
      if (this.#lanes.get(session.deviceId) === released) this.#lanes.delete(session.deviceId);
    });
    this.#track(released);
  }
  #invalidate(phone: Phone, cancel: boolean) {
    ++phone.revision;
    phone.latest = undefined;
    phone.apps.clear();
    for (const work of phone.work) work.abort.abort();
    if (cancel) this.#cancelSession(phone);
    else phone.session = undefined;
  }
  #target(target: IphoneRunnerResult<"iphone.targets">["targets"][number]) {
    const phone = this.#phones.get(target.deviceId);
    if (!phone || phone.assignment.generation !== target.driverGeneration) return;
    if (
      (phone.target && phone.target.nativeEpoch !== target.nativeEpoch) ||
      (phone.session && phone.session.epoch > 0 && phone.session.epoch !== target.nativeEpoch) ||
      (target.ready === false && phone.target?.ready === true)
    )
      this.#invalidate(phone, true);
    phone.target = target;
    this.#status(phone, target.ready ? null : target.reason);
  }
  #event(event: IphoneRunnerEvent) {
    if (!this.#alive) return;
    if (event.event === "iphone.targetsChanged") {
      this.#target(event.params);
      return;
    }
    const phone = this.#phones.get(event.params.deviceId);
    if (
      !phone ||
      phone.assignment.generation !== event.params.driverGeneration ||
      !phone.session ||
      !sameSession(phone.session, event.params) ||
      phone.session.epoch !== event.params.nativeEpoch
    )
      return;
    const session = phone.session;
    this.#invalidate(phone, true);
    this.#status(phone, event.params.reason);
    if (event.params.reason === "cancelled")
      this.#emit({
        type: "runner.integrations.computer-use-event",
        deviceId: phone.assignment.deviceId,
        driverGeneration: phone.assignment.generation,
        event: {
          event: "session.stopped",
          params: {
            sessionId: session.sessionId,
            runId: session.runId,
            reason: "user",
          },
        },
      });
  }
  #status(phone: Phone, reason: string | null | undefined, observation = phone.latest?.native) {
    const available = reason === null;
    const capabilityReason = available ? null : iphoneCapabilityReason(reason);
    const capabilities = phone.target?.capabilities;
    const inventoryReady =
      available ||
      (Boolean(phone.target?.nativeEpoch) &&
        (reason === "qualification-required" ||
          ["locked", "paused", "protected"].includes(capabilityReason?.kind ?? "")));
    const operationReasons = {
      observe: capabilities
        ? capabilities.observe
        : available
          ? null
          : (reason ?? "not-initialized"),
      act: capabilities ? capabilities.act : available ? null : (reason ?? "not-initialized"),
      close: null,
      installed_apps: capabilities
        ? capabilities.installedApps
        : inventoryReady
          ? null
          : (reason ?? "not-initialized"),
    };
    const inputReady = operationReasons.act === null;
    const selfApp = observation?.foreground?.appId === "com.opensteer.opensteer";
    const actions: Extract<
      PhoneScreenDriverEvent,
      { type: "runner.integrations.device-status" }
    >["actions"] = [];
    if (available && observation) {
      if (inputReady)
        actions.push(
          ...(selfApp
            ? ["navigate" as const]
            : (["tap", "longPress", "swipe", "drag", "scroll", "navigate"] as const)),
        );
      if (!selfApp && (!capabilities || capabilities.launch === null)) actions.push("launch");
      actions.push("wait");
    }
    this.#emit({
      deviceId: phone.assignment.deviceId,
      driverGeneration: phone.assignment.generation,
      type: "runner.integrations.device-status",
      definitionId: "iphone-screen",
      availability: available
        ? { state: "ready", reason: null }
        : { state: "unavailable", reason: capabilityReason },
      operations: (["observe", "act", "close", "installed_apps"] as const).map((operation) => ({
        operation,
        state: operationReasons[operation] === null ? "ready" : "unavailable",
        detail: capabilities ? operationReasons[operation] : null,
        remedy: null,
      })),
      navigationButtons: (inputReady ? (observation?.buttons ?? []) : []).map((id) => ({
        id,
        label: { home: "Home", lock: "Lock", volumeUp: "Volume up", volumeDown: "Volume down" }[id],
      })),
      actions,
      wake: false,
      lock: observation
        ? observation.state.lock === "unknown"
          ? null
          : observation.state.lock === "locked"
        : null,
      displayVersion: null,
      ownerViewVersion: null,
      inputVersion: null,
      powerVersion: null,
    });
  }
  #emit(event: PhoneScreenDriverEvent) {
    if (this.#alive) this.#track(this.#options.emit(event).catch(() => undefined));
  }
}
