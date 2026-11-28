import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { runnerWebSocketTransport } from "@opensteer/runner-client";
import { rawDataBuffer } from "@opensteer/shared/webSocketFrame";
import { WebSocket } from "ws";
import {
  ComputerUseErrorCodeSchema,
  DisplayAckSchema,
  DisplayStreamReasonSchema,
  decodeDisplayMediaFrame,
  displayFirstFrameTimeoutMs,
  displayMaxEnvelopeBytes,
  displayMaxHeaderBytes,
  displaySourceKey,
  type DisplaySource,
  type DisplayStreamId,
  type DisplayStreamReason,
  IphoneScreenDispatchActParamsSchema,
  IphoneScreenObservationSchema,
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
  type IphoneScreenObservationResult,
  type PhoneDisplayDispatchObserveParams,
  type PhoneDisplayInstalledAppsParams,
} from "@opensteer/protocol";
import {
  iphoneScreenshotHiddenReason,
  iphoneRunnerResults,
  iphoneNativeActionSchema,
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
import { phoneLabel, phoneTree, type PhoneTreeTarget } from "./phone-tree.js";

export type IphoneScreenBridge = Pick<
  ComputerUseHandler,
  "iphoneRequest" | "onIphoneEvent" | "onIphoneConnection" | "openVideoAttachment"
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
  targets: ReadonlyMap<number, PhoneTreeTarget>;
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
  closing: Map<string, Promise<void>>;
};

type DisplayRef = DeviceDriverTarget & { streamId: DisplayStreamId };
type DisplayEntry = {
  ref: DisplayRef;
  abort: AbortController;
  data?: WebSocket;
  media?: WebSocket;
  starting?: Promise<IphoneRunnerResult<"iphone.display.start">>;
  state?: Extract<IphoneRunnerEvent, { event: "iphone.displayState" }>["params"];
  lastLiveGeometry?: { width: number; height: number; rotation: number } | undefined;
  demandActive: boolean;
  timeout?: ReturnType<typeof setTimeout> | undefined;
  tail: Promise<void>;
  revision: number;
  inputEpoch: number;
  sources: readonly DisplaySource[];
  inputSources: readonly DisplaySource[] | undefined;
  terminal: boolean;
};
const navigationLabels = {
  home: "Home",
  lock: "Lock",
  volumeUp: "Volume up",
  volumeDown: "Volume down",
  recents: "App Switcher",
  notifications: "Notification Center",
  quickSettings: "Control Center",
  action: "Action",
  siri: "Siri",
} as const;
const defaultNavigationButtons = Object.keys(
  navigationLabels,
) as readonly (keyof typeof navigationLabels)[];

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
    case "wifi-pairing-denied":
    case "wifi-pairing-failed":
      return { kind: "trust-required" };
    case "developer-mode-required":
    case "developer-mode-status-unknown":
      return { kind: "developer-mode-required" };
    case "phone-locked":
      return { kind: "locked" };
    case "wake-on-phone-required":
    case "screen-state-unknown":
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
function qualificationBlocker(reason: string | null | undefined): string | null {
  switch (reason) {
    case "qualification-required":
    case "unsupported":
    case "unsupported-ios":
    case "protocol-unsupported":
    case "native-service-missing":
      return reason;
    default:
      return null;
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
            : code === "app-not-launchable"
              ? ("app-not-found" as const)
              : code === "stale-native-epoch"
                ? ("stale-observation" as const)
                : ("failed" as const),
    message:
      effect !== "not-started"
        ? "iPhone input may have been sent; observe before continuing."
        : code === "app-not-launchable"
          ? "No installed app with that appId can be opened on this iPhone."
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

function closeKey(session: Pick<Session, "sessionId" | "runId">): string {
  return JSON.stringify([session.sessionId, session.runId]);
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
  readonly #displays = new Map<DisplayStreamId, DisplayEntry>();
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
        if (state === "lost") {
          for (const entry of this.#displays.values()) this.#stopDisplay(entry, false);
          for (const phone of this.#phones.values()) {
            this.#invalidate(phone, false);
            phone.target = undefined;
            void this.#status(phone, "phone-disconnected");
          }
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
      this.#stopPhoneDisplays(id);
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
          closing: new Map(),
        };
        this.#phones.set(assignment.deviceId, phone);
        void this.#status(phone, "phone-disconnected");
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
            this.#stopPhoneDisplays(phone.assignment.deviceId);
            if (phone.target || phone.session) this.#invalidate(phone, true);
            phone.target = undefined;
            void this.#status(phone, "phone-disconnected");
          }
          for (const target of result.targets) this.#target(target);
        } catch {
          if (this.#alive && revision === this.#assignmentRevision)
            for (const phone of this.#phones.values()) {
              this.#stopPhoneDisplays(phone.assignment.deviceId);
              if (phone.target || phone.session) this.#invalidate(phone, true);
              phone.target = undefined;
              void this.#status(phone, "native-service-failed");
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
    if (phone.closing.has(closeKey(context)))
      failure("no-session", "That iPhone session has ended.");
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
      if (phone.target) {
        if (phone.target.nativeEpoch !== opened.nativeEpoch)
          this.#stopPhoneDisplays(context.deviceId);
        phone.target = { ...phone.target, nativeEpoch: opened.nativeEpoch };
      }
      return session;
    } catch (error) {
      if (phone.session === session) this.#cancelSession(phone);
      throw error;
    }
  }
  async #observe(
    phone: Phone,
    work: Work,
    check: () => void,
    includeScreenshot: boolean,
  ): Promise<IphoneScreenObservationResult> {
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
    if ("reason" in native) {
      await this.#status(phone, native.reason);
      if (
        native.state.display === "off" &&
        native.wakeToken &&
        native.geometryRevision !== undefined &&
        phone.target?.capabilities?.wake === null
      ) {
        const observation = IphoneScreenObservationSchema.parse({
          capturedAt: new Date(this.#now()).toISOString(),
          observationId: randomUUID(),
          geometry: { width: 2, height: 2 },
          rotation: native.state.rotation ?? 0,
          locked: native.state.lock === "unknown" ? null : native.state.lock === "locked",
          secureLock: null,
          screen: "off",
          foreground: null,
          screenshot: null,
          screenshotUnavailable: "screen-off",
          tree: "",
          elementCount: 0,
          truncated: false,
        });
        phone.latest = {
          native: {
            observationToken: native.wakeToken,
            nativeEpoch: native.nativeEpoch,
            geometryRevision: native.geometryRevision,
            geometry: {
              width: 2,
              height: 2,
              captureWidth: 2,
              captureHeight: 2,
              displayId: native.state.displayId,
              rotation: native.state.rotation,
            },
            state: native.state,
            nodes: [],
            coverage: {
              coordinateSpace: "unqualified",
              status: "unavailable",
              reason: "accessibility-unavailable",
              received: 0,
              returned: 0,
              missingFrames: 0,
              missingChildren: 0,
              unreturned: 0,
              cycles: 0,
              truncated: false,
            },
            foreground: null,
            buttons: [],
            textReason: "unsupported-text",
            clearReason: "unsupported-clear",
            screenshot: null,
          },
          public: observation,
          session,
          targets: new Map(),
        };
        return { observation };
      }
      return {
        observation: null,
        status: {
          locked: native.state.lock === "unknown" ? null : native.state.lock === "locked",
          screen: native.state.display,
          reason:
            native.reason === "phone-locked"
              ? "locked"
              : native.reason === "wake-on-phone-required"
                ? "screen-off"
                : native.reason,
        },
      };
    }
    if (
      native.geometry.rotation === null ||
      native.state.rotation !== native.geometry.rotation ||
      native.state.displayId !== native.geometry.displayId
    )
      failure("unsupported", "The iPhone display geometry is unavailable.");
    const hidden = iphoneScreenshotHiddenReason(native);
    const { targets, ...tree } = hidden
      ? { tree: "", elementCount: 0, truncated: false, targets: new Map<number, PhoneTreeTarget>() }
      : phoneTree(native, phone.target?.capabilities?.indexedTargets === null);
    const observation = IphoneScreenObservationSchema.parse({
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
      ...tree,
    });
    phone.latest = {
      native: hidden ? { ...native, nodes: [], screenshot: null } : native,
      public: observation,
      session,
      targets,
    };
    await this.#status(
      phone,
      hidden === "locked"
        ? "phone-locked"
        : hidden === "protected"
          ? "lock-state-unknown"
          : hidden === "screen-off"
            ? "wake-on-phone-required"
            : qualificationBlocker(
                phone.target?.capabilities?.observe ??
                  (phone.target?.capabilities ? null : phone.target?.reason),
              ),
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
        if (actions.some((action) => !iphoneNativeActionSchema.safeParse(action).success))
          failure("unsupported", "This input exceeds the iPhone's native action limits.");
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
        try {
          check();
          const result = await this.#observe(phone, work, check, params.includeScreenshot);
          return { performed, error, ...result };
        } catch (caught) {
          this.#cancelSession(phone);
          return { performed, error: error ?? errorBody(caught), observation: null };
        }
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
    type Target = { index: number } | { x: number; y: number };
    const indexed = (target: { index: number }) => {
      if (
        snapshot.native.coverage.coordinateSpace !== "qualified" ||
        phone.target?.capabilities?.indexedTargets !== null
      )
        failure("unsupported", "iPhone element indices are unavailable; use screenshot pixels.");
      const node = snapshot.targets.get(target.index);
      if (!node)
        failure("stale-observation", "The element is absent from this iPhone observation.");
      return node;
    };
    const point = (target: Target) => {
      if ("index" in target) {
        const { frame } = indexed(target);
        return {
          x: Math.floor(frame.x + frame.width / 2),
          y: Math.floor(frame.y + frame.height / 2),
        };
      }
      const { width, height } = snapshot.native.geometry;
      if (target.x < 0 || target.y < 0 || target.x > width - 1 || target.y > height - 1)
        failure("stale-observation", "The target is outside this iPhone observation.");
      return { x: target.x, y: target.y };
    };
    const nativeTarget = (target: Target) =>
      "index" in target ? { nodeId: indexed(target).nodeId } : { point: point(target) };
    const checkTextTarget = (target: Target | undefined) => {
      const secure =
        target && "index" in target
          ? indexed(target).secure === "yes"
          : snapshot.native.nodes.some(
              (node) =>
                node.secure === "yes" &&
                (target && node.frame && snapshot.native.coverage.coordinateSpace === "qualified"
                  ? target.x >= node.frame.x &&
                    target.y >= node.frame.y &&
                    target.x < node.frame.x + node.frame.width &&
                    target.y < node.frame.y + node.frame.height
                  : node.focused === true),
            );
      if (secure) failure("permission-required", "The iPhone field is protected.");
    };
    return actions.map((action): IphoneNativeAction[] => {
      const reason = this.#observationCapability(
        phone,
        action.type === "launch" ? "launch" : "act",
      );
      if (reason && action.type !== "wake")
        failure("unsupported", `iPhone ${action.type} is unavailable: ${reason}.`);
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
        action.type !== "launch" &&
        action.type !== "wait"
      )
        failure(
          "permission-required",
          "Navigate away from Opensteer or launch another app before controlling the screen.",
        );
      switch (action.type) {
        case "tap":
          return [
            {
              kind: "tap",
              target: nativeTarget(action.target),
              ...(action.count === 2 ? { count: 2 } : {}),
            },
          ];
        case "longPress":
          return [
            {
              kind: "longPress",
              target: nativeTarget(action.target),
              durationMs: action.durationMs,
            },
          ];
        case "swipe":
          return [
            {
              kind: "swipe",
              target: nativeTarget(action.from),
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
              target: nativeTarget(action.from),
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
          return [{ kind: "launch", appId: action.appId }];
        case "wake":
          if (phone.target?.capabilities?.wake !== null)
            failure("unsupported", "Wake this iPhone on the phone.");
          return [{ kind: "wake" }];
        case "wait":
          return [{ kind: "wait", durationMs: action.ms }];
        case "type":
          if (phone.target?.capabilities?.text !== null || snapshot.native.textReason !== null)
            failure("unsupported", "This iPhone does not support typing here.");
          checkTextTarget(action.target);
          return [
            {
              kind: "type",
              text: action.text,
              submit: action.submit,
              ...(action.target ? { target: nativeTarget(action.target) } : {}),
            },
          ];
        case "clear":
          if (phone.target?.capabilities?.clear !== null || snapshot.native.clearReason !== null)
            failure("unsupported", "This iPhone does not support clearing text here.");
          checkTextTarget(action.target);
          return [{ kind: "clear", target: nativeTarget(action.target) }];
      }
    });
  }
  async installedApps(context: PhoneScreenContext, input: PhoneDisplayInstalledAppsParams) {
    return this.#run(context, async (_phone, work, check) => {
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
      return { apps, total: page.total };
    });
  }
  async close(context: PhoneScreenContext) {
    const phone = this.#phones.get(context.deviceId);
    if (!this.#alive || phone?.assignment.generation !== context.driverGeneration)
      failure("outcome-unknown", "That iPhone driver assignment has ended.");
    if (!phone.session || sameSession(phone.session, context)) this.#invalidate(phone, true);
    await this.#closeSession(
      phone,
      ref(context),
      phone.tail.catch(() => undefined),
    );
    return {};
  }
  async ownerView(frame: PhoneScreenOwnerView, signal: AbortSignal, _receivedAt: number) {
    await this.#sync;
    const phone = this.#phone(frame);
    const ref = { viewId: frame.viewId, generation: frame.generation };
    if (signal.aborted) failure("stopped-by-user", "The iPhone view was cancelled.");
    if (frame.operation === "close")
      return { ...ref, state: "closed" as const, captureTargetId: null };
    if (phone.target?.capabilities?.liveVideo === null)
      return { ...ref, state: "ready" as const, captureTargetId: null };
    return { ...ref, kind: "unavailable" as const, reason: "unsupported" };
  }

  display(frame: PhoneScreenDisplayFrame): void {
    const phone = this.#phone(frame);
    const ref = {
      deviceId: frame.deviceId,
      driverGeneration: frame.driverGeneration,
      streamId: frame.streamId,
    };
    let entry = this.#displays.get(ref.streamId);
    if (
      entry &&
      (entry.ref.deviceId !== ref.deviceId || entry.ref.driverGeneration !== ref.driverGeneration)
    )
      return;
    if (frame.type === "host.integrations.display.start") {
      if (entry) return;
      entry = {
        ref,
        abort: new AbortController(),
        tail: Promise.resolve(),
        revision: frame.revision,
        inputEpoch: 0,
        sources: frame.sources,
        inputSources: frame.inputSources,
        demandActive: false,
        terminal: false,
      };
      this.#displays.set(ref.streamId, entry);
      const active = entry;
      this.#armFirstFrameTimeout(active);
      active.tail = this.#startDisplay(phone, active, frame).catch(() =>
        this.#failDisplay(active, "capture-failed"),
      );
      this.#track(active.tail);
      return;
    }
    if (frame.type === "host.integrations.display.stop") {
      if (entry) this.#stopDisplay(entry);
      return;
    }
    if (!entry || entry.terminal || entry.abort.signal.aborted) {
      if (
        frame.type === "host.integrations.display.input" ||
        frame.type === "host.integrations.display.power"
      )
        this.#refuseDisplayInput(
          frame,
          phone.target?.capabilities?.liveVideo === null ? "unavailable" : "unsupported",
        );
      return;
    }
    if (frame.type === "host.integrations.display.input-reset") {
      entry.inputEpoch++;
      const active = entry;
      const reset = this.#bridge
        .iphoneRequest("iphone.display.inputReset", ref, {
          deadline: this.#now() + 5000,
          signal: active.abort.signal,
        })
        .catch(() => undefined);
      this.#track(reset);
      return;
    }
    if (frame.type === "host.integrations.display.demand") {
      if (frame.revision <= entry.revision) return;
      entry.revision = frame.revision;
      entry.sources = frame.sources;
      entry.inputSources = frame.inputSources;
      if (frame.sources.length === 0) this.#clearFirstFrameTimeout(entry);
      else if (entry.state?.state === "protected" && entry.state.reason === "paused")
        this.#armFirstFrameTimeout(entry);
    }
    const active = entry;
    const inputEpoch = active.inputEpoch;
    active.tail = active.tail
      .then(async () => {
        if (active.abort.signal.aborted || active.terminal) return;
        const options = { deadline: this.#now() + 5000, signal: active.abort.signal };
        switch (frame.type) {
          case "host.integrations.display.demand": {
            const includeActive = active.demandActive;
            if (!includeActive && frame.maxLongSide === undefined) break;
            await this.#bridge.iphoneRequest(
              "iphone.display.demand",
              {
                ...ref,
                ...(includeActive ? { active: frame.sources.length > 0 } : {}),
                ...(frame.maxLongSide === undefined ? {} : { maxLongSide: frame.maxLongSide }),
              },
              options,
            );
            break;
          }
          case "host.integrations.display.refresh":
            await this.#bridge.iphoneRequest("iphone.display.refresh", ref, options);
            break;
          case "host.integrations.display.input": {
            const source = frame.source ?? {
              kind: "task-session" as const,
              sessionId: frame.sessionId!,
            };
            if (
              active.inputEpoch !== inputEpoch ||
              !this.#displayInputAllowed(active, source) ||
              phone.target?.capabilities?.act !== null
            ) {
              this.#refuseDisplayInput(frame, "unavailable");
              return;
            }
            phone.latest = undefined;
            const result = await this.#bridge.iphoneRequest(
              "iphone.display.input",
              {
                ...ref,
                geometry: frame.geometry,
                sequence: frame.sequence,
                events: frame.events,
              },
              options,
            );
            if (!active.abort.signal.aborted)
              void this.#emit({
                ...ref,
                ...result,
                type: "runner.integrations.display.input-result",
                ...(frame.sessionId ? { sessionId: frame.sessionId } : { source }),
                geometry: frame.geometry,
                sequence: frame.sequence,
              });
            break;
          }
          case "host.integrations.display.power": {
            if (
              !this.#displayInputAllowed(active, frame.source) ||
              phone.target?.capabilities?.wake !== null
            ) {
              this.#refuseDisplayInput(frame, "unavailable");
              return;
            }
            const result = await this.#bridge.iphoneRequest(
              "iphone.display.power",
              {
                ...ref,
                action: frame.action,
              },
              options,
            );
            if (!active.abort.signal.aborted) {
              phone.latest = undefined;
              void this.#emit({
                ...ref,
                ...result,
                type: "runner.integrations.display.power-result",
                source: frame.source,
                sequence: frame.sequence,
              });
            }
            break;
          }
        }
      })
      .catch(() => {
        if (active.abort.signal.aborted || active.terminal) return;
        if (
          frame.type === "host.integrations.display.input" ||
          frame.type === "host.integrations.display.power"
        )
          this.#refuseDisplayInput(frame, "unavailable");
        else if (frame.type !== "host.integrations.display.refresh")
          this.#failDisplay(active, "capture-failed");
      });
    this.#track(active.tail);
  }

  #displayInputAllowed(entry: DisplayEntry, source: DisplaySource): boolean {
    const paths =
      entry.inputSources ?? entry.sources.filter((item) => item.kind === "task-session");
    return paths.some((item) => displaySourceKey(item) === displaySourceKey(source));
  }

  #refuseDisplayInput(
    frame: Extract<
      PhoneScreenDisplayFrame,
      { type: "host.integrations.display.input" | "host.integrations.display.power" }
    >,
    reason: "unavailable" | "unsupported",
  ) {
    const base = {
      deviceId: frame.deviceId,
      driverGeneration: frame.driverGeneration,
      streamId: frame.streamId,
      sequence: frame.sequence,
      outcome: "refused" as const,
      reason,
    };
    void this.#emit(
      frame.type === "host.integrations.display.input"
        ? {
            ...base,
            type: "runner.integrations.display.input-result",
            geometry: frame.geometry,
            ...(frame.sessionId ? { sessionId: frame.sessionId } : { source: frame.source! }),
          }
        : { ...base, type: "runner.integrations.display.power-result", source: frame.source },
    );
  }

  async #startDisplay(
    phone: Phone,
    entry: DisplayEntry,
    frame: Extract<PhoneScreenDisplayFrame, { type: "host.integrations.display.start" }>,
  ): Promise<void> {
    const deadline = this.#now() + displayFirstFrameTimeoutMs;
    const signal = entry.abort.signal;
    await this.#sync;
    if (signal.aborted) return;
    if (!this.#options.transport || phone.target?.capabilities?.liveVideo !== null) {
      this.#failDisplay(entry, "target-unavailable");
      return;
    }
    // Retain the start reply so stop can release a native attachment even if
    // the caller stops before Desktop has registered the stream.
    entry.starting = this.#bridge.iphoneRequest(
      "iphone.display.start",
      {
        ...entry.ref,
        maxLongSide: frame.maxLongSide,
        maxFps: frame.maxFps,
      },
      { deadline },
    );
    const started = await entry.starting;
    if (signal.aborted || entry.terminal) return;
    entry.demandActive = started.demandActive === true;
    const transport = await runnerWebSocketTransport(
      this.#options.transport,
      "/internal/v1/computer-use/display",
    );
    if (signal.aborted || entry.terminal) return;
    const data = new WebSocket(transport.url, {
      headers: { authorization: `Bearer ${frame.dataTicket}` },
      ...(transport.ca ? { ca: transport.ca } : {}),
      rejectUnauthorized: true,
      perMessageDeflate: false,
      followRedirects: false,
      maxPayload: displayMaxHeaderBytes,
    });
    entry.data = data;
    const dataEnded = () => {
      if (!entry.terminal) this.#failDisplay(entry, "data-socket-failed");
      this.#stopDisplay(entry);
    };
    data.on("error", dataEnded);
    data.once("close", dataEnded);
    await once(data, "open", { signal });
    if (signal.aborted || entry.terminal) return;
    const media = this.#bridge.openVideoAttachment(started.attachmentToken);
    entry.media = media;
    let mediaEndedOnce = false;
    const mediaEnded = () => {
      if (!mediaEndedOnce && !entry.terminal && !signal.aborted) {
        mediaEndedOnce = true;
        // The native state and media close travel separately. Allow the terminal
        // state to arrive before classifying a closed socket as a transport failure.
        this.#track(
          this.#bridge
            .iphoneRequest("iphone.display.refresh", entry.ref, {
              deadline: this.#now() + 5000,
              signal,
            })
            .catch(() => undefined)
            .then(() => this.#failDisplay(entry, "data-socket-failed")),
        );
      }
    };
    media.on("error", mediaEnded);
    media.once("close", mediaEnded);
    media.on("message", (raw, binary) => {
      if (signal.aborted || entry.terminal) return;
      try {
        const bytes = rawDataBuffer(raw);
        if (!binary || decodeDisplayMediaFrame(bytes).header.streamId !== entry.ref.streamId)
          throw new Error();
        if (
          data.readyState !== WebSocket.OPEN ||
          data.bufferedAmount + bytes.byteLength > displayMaxEnvelopeBytes
        )
          throw new Error();
        this.#clearFirstFrameTimeout(entry);
        data.send(bytes, { binary: true }, (error) => {
          if (error) dataEnded();
        });
      } catch {
        this.#failDisplay(entry, "data-socket-failed");
      }
    });
    data.on("message", (raw, binary) => {
      if (signal.aborted || entry.terminal) return;
      try {
        if (
          binary ||
          media.readyState !== WebSocket.OPEN ||
          media.bufferedAmount > displayMaxHeaderBytes
        )
          throw new Error();
        const ack = DisplayAckSchema.parse(JSON.parse(rawDataBuffer(raw).toString("utf8")));
        media.send(JSON.stringify(ack), (error) => {
          if (error) mediaEnded();
        });
      } catch {
        this.#failDisplay(entry, "data-socket-failed");
      }
    });
  }

  #failDisplay(entry: DisplayEntry, reason: DisplayStreamReason): void {
    if (entry.abort.signal.aborted || entry.terminal) return;
    this.#finishDisplay(entry, {
      ...entry.ref,
      display: "main",
      type: "runner.integrations.display.state",
      state: "failed",
      reason,
      generation: Number.MAX_SAFE_INTEGER,
      width: 0,
      height: 0,
      rotation: 0,
    });
  }

  #finishDisplay(
    entry: DisplayEntry,
    event: Extract<PhoneScreenDriverEvent, { type: "runner.integrations.display.state" }>,
  ) {
    entry.terminal = true;
    clearTimeout(entry.timeout);
    entry.media?.terminate();
    // Host handles the terminal state before the data socket closes.
    const sent = this.#emit(event);
    void sent?.then(() => this.#stopDisplay(entry));
  }

  #armFirstFrameTimeout(entry: DisplayEntry) {
    this.#clearFirstFrameTimeout(entry);
    if (entry.terminal || entry.abort.signal.aborted) return;
    entry.timeout = setTimeout(
      () => this.#failDisplay(entry, "capture-timeout"),
      displayFirstFrameTimeoutMs,
    );
    entry.timeout.unref();
  }

  #clearFirstFrameTimeout(entry: DisplayEntry) {
    if (entry.timeout !== undefined) {
      clearTimeout(entry.timeout);
      entry.timeout = undefined;
    }
  }

  #stopDisplay(entry: DisplayEntry, stopNative = true) {
    if (entry.abort.signal.aborted) return;
    entry.abort.abort();
    clearTimeout(entry.timeout);
    entry.media?.terminate();
    entry.data?.terminate();
    const release = async () => {
      if (stopNative && entry.starting) {
        await entry.starting.catch(() => undefined);
        await this.#bridge
          .iphoneRequest("iphone.display.stop", entry.ref, {
            deadline: this.#now() + 5000,
          })
          .catch(() => undefined);
      }
      this.#displays.delete(entry.ref.streamId);
    };
    this.#track(release());
  }

  #stopPhoneDisplays(deviceId: string) {
    for (const entry of this.#displays.values())
      if (entry.ref.deviceId === deviceId) this.#stopDisplay(entry);
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
    for (const entry of this.#displays.values()) this.#stopDisplay(entry);
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
      .then(
        () => null,
        (error: unknown) =>
          error instanceof ComputerUseBridgeError && error.code === "no-session" ? null : error,
      );
    const ready = Promise.all([cancelled, phone.tail.catch(() => undefined)]).then(([error]) => {
      if (error !== null) throw error;
    });
    void this.#closeSession(phone, session, ready);
  }
  #closeSession(phone: Phone, session: Session, ready: Promise<unknown>): Promise<void> {
    const key = closeKey(session);
    const closing = phone.closing.get(key);
    if (closing) return closing;
    const released = ready
      .then(async () => {
        await this.#bridge.iphoneRequest("iphone.session.close", sessionParams(session), {
          deadline: this.#now() + 5000,
        });
      })
      .catch((error: unknown) => {
        if (error instanceof ComputerUseBridgeError) {
          if (error.code === "no-session") return;
          throw error;
        }
        throw new ComputerUseBridgeError(
          "outcome-unknown",
          "The iPhone could not complete this request.",
        );
      });
    phone.closing.set(key, released);
    this.#lanes.set(session.deviceId, released);
    const finished = (unknown: boolean) => {
      if (this.#lanes.get(session.deviceId) === released) this.#lanes.delete(session.deviceId);
      if (!unknown) phone.closing.delete(key);
    };
    this.#track(
      released.then(
        () => finished(false),
        (error: unknown) =>
          finished(
            error instanceof ComputerUseBridgeError &&
              (error.code === "outcome-unknown" || error.code === "device-offline"),
          ),
      ),
    );
    return released;
  }
  #invalidate(phone: Phone, cancel: boolean) {
    ++phone.revision;
    phone.latest = undefined;
    for (const work of phone.work) work.abort.abort();
    if (cancel) this.#cancelSession(phone);
    else if (phone.session) {
      const session = phone.session;
      const lost = Promise.reject<void>(
        new ComputerUseBridgeError("outcome-unknown", "That iPhone driver assignment has ended."),
      );
      phone.closing.set(closeKey(session), lost);
      void lost.catch(() => undefined);
      phone.session = undefined;
    }
  }
  #target(target: IphoneRunnerResult<"iphone.targets">["targets"][number]) {
    const phone = this.#phones.get(target.deviceId);
    if (!phone || phone.assignment.generation !== target.driverGeneration) return;
    if (
      (phone.target && phone.target.nativeEpoch !== target.nativeEpoch) ||
      (phone.session && phone.session.epoch > 0 && phone.session.epoch !== target.nativeEpoch)
    ) {
      this.#stopPhoneDisplays(target.deviceId);
      this.#invalidate(phone, true);
    }
    phone.target = target;
    void this.#status(phone, target.ready ? null : target.reason);
  }
  #event(event: IphoneRunnerEvent) {
    if (!this.#alive) return;
    if (event.event === "iphone.targetsChanged") {
      this.#target(event.params);
      return;
    }
    if (event.event === "iphone.displayState") {
      const { reason, ...params } = event.params;
      const entry = this.#displays.get(params.streamId);
      if (
        !entry ||
        entry.abort.signal.aborted ||
        entry.terminal ||
        entry.ref.deviceId !== params.deviceId ||
        entry.ref.driverGeneration !== params.driverGeneration ||
        (entry.state && params.generation < entry.state.generation)
      )
        return;
      const phone = this.#phones.get(params.deviceId);
      const demandPause = params.state === "protected" && reason === "paused";
      const realShield =
        (params.state === "protected" && !demandPause) || params.state === "screen-off";
      const resumingDemandPause =
        entry.state?.state === "protected" &&
        entry.state.reason === "paused" &&
        (params.state === "starting" || params.state === "live") &&
        entry.lastLiveGeometry !== undefined &&
        entry.lastLiveGeometry.rotation === params.rotation;
      const liveGeometryChanged =
        params.state === "live" &&
        entry.lastLiveGeometry !== undefined &&
        (entry.lastLiveGeometry.width !== params.width ||
          entry.lastLiveGeometry.height !== params.height ||
          entry.lastLiveGeometry.rotation !== params.rotation);
      if (
        phone &&
        (realShield ||
          liveGeometryChanged ||
          (!demandPause &&
            !resumingDemandPause &&
            entry.state !== undefined &&
            entry.state.generation !== params.generation))
      )
        phone.latest = undefined;
      if (realShield) entry.lastLiveGeometry = undefined;
      else if (params.state === "live")
        entry.lastLiveGeometry = {
          width: params.width,
          height: params.height,
          rotation: params.rotation,
        };
      entry.state = event.params;
      if (params.state === "protected" || params.state === "screen-off" || params.state === "live")
        this.#clearFirstFrameTimeout(entry);
      else if (params.state === "starting" && entry.sources.length > 0)
        this.#armFirstFrameTimeout(entry);
      const parsed = DisplayStreamReasonSchema.safeParse(reason);
      const forwarded = {
        ...params,
        ...entry.ref,
        type: "runner.integrations.display.state" as const,
        display: "main" as const,
        ...(parsed.success ? { reason: parsed.data } : {}),
      };
      if (params.state === "failed" || params.state === "stopped")
        this.#finishDisplay(entry, forwarded);
      else void this.#emit(forwarded);
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
    void this.#status(phone, event.params.reason);
    if (event.params.reason === "cancelled")
      void this.#emit({
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
  #observationCapability(phone: Phone, operation: "act" | "launch") {
    const capabilities = phone.target?.capabilities;
    return qualificationBlocker(capabilities ? capabilities[operation] : phone.target?.reason);
  }

  #status(phone: Phone, reason: string | null | undefined, observation = phone.latest?.native) {
    const available = reason === null;
    const capabilities = phone.target?.capabilities;
    // Keep locked/screen-off routes ready when wake or live view is supported so Host
    // does not invalidate in-flight wake observations or tear down active owner views.
    const privacyShieldRouteReady =
      !available &&
      Boolean(phone.target?.nativeEpoch) &&
      (reason === "wake-on-phone-required" || reason === "phone-locked") &&
      (capabilities?.wake === null || capabilities?.liveVideo === null);
    const routeAvailable = available || privacyShieldRouteReady;
    const capabilityReason = routeAvailable ? null : iphoneCapabilityReason(reason);
    const inventoryReady =
      available ||
      (Boolean(phone.target?.nativeEpoch) &&
        (reason === "qualification-required" ||
          ["locked", "paused", "protected"].includes(capabilityReason?.kind ?? "")));
    const operationReasons = {
      observe: reason ?? null,
      act:
        available && observation
          ? this.#observationCapability(phone, "act")
          : (reason ?? capabilities?.act ?? null),
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
    if (available) {
      if (observation) {
        if (inputReady)
          actions.push(
            ...(selfApp
              ? ["navigate" as const]
              : (["tap", "longPress", "swipe", "drag", "scroll", "navigate"] as const)),
          );
        if (!this.#observationCapability(phone, "launch")) actions.push("launch");
        if (inputReady && !selfApp) {
          if (capabilities?.text === null && observation.textReason === null) actions.push("type");
          if (capabilities?.clear === null && observation.clearReason === null)
            actions.push("clear");
        }
        actions.push("wait");
      } else if (capabilities?.liveVideo === null && inputReady) {
        // Advertise interactive viewer controls immediately before an agent observes.
        actions.push("tap", "longPress", "swipe", "drag", "scroll", "navigate");
        if (capabilities.launch === null) actions.push("launch");
        if (capabilities.text === null) actions.push("type");
        if (capabilities.clear === null) actions.push("clear");
        actions.push("wait");
      }
    }
    if (capabilities?.wake === null) actions.push("wake");
    const buttons = inputReady
      ? (observation?.buttons ?? (capabilities?.liveVideo === null ? defaultNavigationButtons : []))
      : [];
    const ownerControlReady =
      capabilities?.liveVideo === null &&
      (inputReady || (privacyShieldRouteReady && capabilities?.wake === null));
    return this.#emit({
      deviceId: phone.assignment.deviceId,
      driverGeneration: phone.assignment.generation,
      type: "runner.integrations.device-status",
      definitionId: "iphone-screen",
      availability: routeAvailable
        ? { state: "ready", reason: null }
        : { state: "unavailable", reason: capabilityReason },
      operations: (["observe", "act", "close", "installed_apps"] as const).map((operation) => ({
        operation,
        state: operationReasons[operation] === null ? "ready" : "unavailable",
        detail: capabilities ? operationReasons[operation] : null,
        remedy: null,
      })),
      navigationButtons: buttons.map((id) => ({
        id,
        label: navigationLabels[id],
      })),
      actions,
      wake: capabilities?.wake === null,
      lock: capabilities?.wake === null ? true : null,
      displayVersion: capabilities?.liveVideo === null ? 1 : null,
      ownerViewVersion: capabilities?.liveVideo === null ? 1 : null,
      inputVersion: ownerControlReady ? 1 : null,
      powerVersion: capabilities?.wake === null ? 1 : null,
    });
  }
  #emit(event: PhoneScreenDriverEvent) {
    if (!this.#alive) return;
    const published = this.#options.emit(event).catch(() => undefined);
    this.#track(published);
    return published;
  }
}
