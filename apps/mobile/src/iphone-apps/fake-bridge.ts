import type { MockHostClient } from "@opensteer/client/mock";
import type {
  IphoneAppId,
  IphoneAppsBridge,
  IphoneAppsConnection,
  IphoneAppsEnrollment,
  IphoneAppsErrorCode,
  IphoneAppsIssue,
  IphoneAppsSnapshot,
  IphonePairingTarget,
  IphonePermission,
} from "../platform/iphone-apps.js";
import { iphonePermissionOf } from "./controller.js";

/**
 * A JS stand-in for the native iPhone apps module, for tests and mock mode
 * only. It keeps the bridge's contract — one Deployment at a time, a mint key
 * stable until discarded, signatures only for listed requests — and nothing
 * else: it holds no keys, opens no socket, prompts nothing and runs no app.
 * Production never constructs it; the composition root picks it only when the
 * build runs against the in-memory Host.
 */
export interface FakeIphoneApps {
  readonly bridge: IphoneAppsBridge;
  /** What iOS, the native executor and the Host would do on their own. */
  readonly device: FakeIphoneDevice;
}

export interface FakeIphoneDevice {
  /** Every bridge call that acts, in order; snapshot reads are not acts. */
  readonly calls: readonly string[];
  answerPermissionWith(
    app: IphoneAppId,
    answer: IphonePermission | Promise<IphonePermission>,
  ): void;
  connect(): void;
  enrolledTo(input: {
    readonly connection?: IphoneAppsConnection;
    readonly deploymentId: string;
    readonly hostUrl?: string;
    readonly name: string;
  }): void;
  lastRetarget(): IphonePairingTarget | null;

  mintKey(): string | null;
  onEnroll(listener: () => void): void;

  raise(issue: IphoneAppsIssue, message?: string): void;
  reconnect(): void;

  removedByHost(): void;
  runnerId(): string;
  setLocationAccuracy(accuracy: "approximate" | "precise" | null): void;
  setPermission(app: IphoneAppId, permission: IphonePermission): void;
  /** Mock mode: re-reads the requests the Host would push to this iPhone. */
}

const iphoneAppIds: readonly IphoneAppId[] = [
  "apple-calendar",
  "apple-contacts",
  "apple-reminders",
  "iphone-location",
  "iphone-photos",
];
export function createFakeIphoneApps(
  options: {
    /** Connects as soon as an enrollment is stored, as a reachable Host would let it. */
    readonly autoConnect?: boolean;
    readonly deviceName?: string;
    /** Mock mode: the in-memory Host for a Deployment, which this phone joins and answers. */
    readonly host?: (deploymentId: string) => MockHostClient | null;
    /**
     * The apps this build offers; an older build omits later ones from its
     * permissions, has no method for them and lists no request for them.
     */
    readonly offers?: readonly IphoneAppId[];
    /** False for a phone whose browser did not qualify, which then advertises none. */
    readonly browser?: boolean;
    /** Removal leaves its browser profiles to erase at the next launch, as Android's WebView must. */
    readonly erasesOnRestart?: boolean;
    readonly platform?: "android" | "ios";
    /** Mock mode: what becomes of the phone once it has joined its Host. */
    readonly scenario?: "away" | "needs-update" | null;
    readonly runnerId?: string;
    /** False on a device that cannot share its apps, which never offers to. */
    readonly supported?: boolean;
  } = {},
): FakeIphoneApps {
  const calls: string[] = [];
  const listeners = new Set<(snapshot: IphoneAppsSnapshot) => void>();
  const enrollListeners: (() => void)[] = [];
  const permissionAnswers = new Map<IphoneAppId, IphonePermission | Promise<IphonePermission>>();
  const retargets: IphonePairingTarget[] = [];
  const offers = options.offers ?? iphoneAppIds;
  const offered = (app: string): app is IphoneAppId => offers.some((id) => id === app);
  let runnerId = options.runnerId ?? fakeRunnerId();
  let prepared: { readonly deploymentId: string; mintKey: string } | null = null;
  let hostInstanceId: string | null = null;
  let detachHost: (() => void) | null = null;
  let snapshot: IphoneAppsSnapshot = {
    connection: "none",
    deviceName: options.deviceName ?? "iPhone",
    enrollment: null,
    issue: null,
    issueMessage: null,
    ...(offered("iphone-location") ? { locationAccuracy: null } : {}),
    permissions: Object.fromEntries(offers.map((app) => [app, "not-determined"])),
    retryAt: null,
    revision: 0,
    supported: options.supported ?? true,
    unsupportedReason: options.supported === false ? "not-iphone" : null,
    working: 0,
  };

  const permissionOf = (app: IphoneAppId): IphonePermission | null =>
    offered(app) ? iphonePermissionOf(snapshot, app) : null;

  const set = (patch: Partial<IphoneAppsSnapshot>): void => {
    snapshot = { ...snapshot, ...patch, revision: snapshot.revision + 1 };
    for (const listener of listeners) listener(snapshot);
  };

  const enrollment = (patch: Partial<IphoneAppsEnrollment>): IphoneAppsEnrollment | null =>
    snapshot.enrollment === null ? null : { ...snapshot.enrollment, ...patch };

  const connect = (): void => {
    set({
      connection: "online",
      enrollment: enrollment({ enrollmentId: null, state: "enrolled" }),
      issue: null,
      issueMessage: null,
      retryAt: null,
    });
  };

  const wipe = (issue: IphoneAppsIssue | null): void => {
    detachHost?.();
    detachHost = null;
    prepared = null;
    hostInstanceId = null;
    runnerId = fakeRunnerId();
    set({
      connection: "none",
      enrollment: null,
      issue,
      issueMessage: null,
      retryAt: null,
      working: 0,
    });
  };

  const joinMockHost = (input: {
    readonly deploymentId: string;
    readonly enrollmentId: string;
    readonly name: string;
  }): void => {
    const host = options.host?.(input.deploymentId) ?? null;
    if (host === null) return;
    try {
      host.mockConnectIphone({
        enrollmentId: input.enrollmentId,
        modules: [
          ...(options.browser === false ? [] : ["browser" as const]),
          ...(offers.length > 0 ? ["integrations" as const] : []),
        ],
        name: input.name,
        platform: options.platform ?? "ios",
        runnerId,
      });
    } catch (error) {
      set({
        connection: "stopped",
        issue: "enrollment-refused",
        issueMessage: error instanceof Error ? error.message : null,
      });
      return;
    }
    connect();
    const scenario = options.scenario ?? null;
    if (scenario === null) return;
    // After Add has settled, as a phone that later loses its Host would.
    setTimeout(() => {
      if (scenario === "away") {
        host.mockPhoneAway(runnerId);
        set({ connection: "retrying", issue: "host-unreachable" });
      } else {
        set({ connection: "stopped", issue: "needs-update" });
      }
    }, 3_000);
  };

  const bridge: IphoneAppsBridge = {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async prepare({ deploymentId }) {
      calls.push("prepare");
      const held = snapshot.enrollment?.deploymentId ?? prepared?.deploymentId ?? null;
      if (held !== null && held !== deploymentId) throw bridgeError("enrolled-elsewhere");
      prepared ??= { deploymentId, mintKey: fakeMintKey() };
      return { mintKey: prepared.mintKey, runnerId };
    },

    async enroll(input) {
      calls.push("enroll");
      if (prepared === null) throw bridgeError("not-prepared");
      if (input.pairing.deploymentId !== prepared.deploymentId) {
        throw bridgeError("wrong-deployment");
      }
      hostInstanceId = input.pairing.hostInstanceId;
      set({
        connection: "connecting",
        enrollment: {
          deploymentId: input.pairing.deploymentId,
          deploymentName: input.pairing.deploymentName,
          enrollmentId: input.enrollmentId,
          hostUrl: input.pairing.hostUrl,
          name: input.name,
          runnerId,
          state: "pending",
        },
        issue: null,
        issueMessage: null,
      });
      for (const listener of enrollListeners) listener();
      if (options.host !== undefined) {
        joinMockHost({
          deploymentId: input.pairing.deploymentId,
          enrollmentId: input.enrollmentId,
          name: input.name,
        });
      } else if (options.autoConnect === true) {
        connect();
      }
    },

    async discardPendingEnrollment() {
      calls.push("discardPendingEnrollment");
      if (prepared === null) throw bridgeError("not-prepared");
      prepared.mintKey = fakeMintKey();
      set({ connection: "none", enrollment: null, issue: null, issueMessage: null });
      return { mintKey: prepared.mintKey };
    },

    async retarget(pairing) {
      calls.push("retarget");
      if (
        snapshot.enrollment === null ||
        pairing.deploymentId !== snapshot.enrollment.deploymentId ||
        (hostInstanceId !== null && pairing.hostInstanceId !== hostInstanceId)
      ) {
        throw bridgeError("invalid-target");
      }
      retargets.push(pairing);
      set({
        enrollment: enrollment({ hostUrl: pairing.hostUrl }),
        ...(snapshot.issue === "host-unreachable" ? { issue: null, issueMessage: null } : {}),
      });
    },

    disconnect() {
      calls.push("disconnect");
      const stopped = {
        deploymentId: snapshot.enrollment?.deploymentId ?? prepared?.deploymentId ?? null,
        runnerId: snapshot.enrollment !== null || prepared !== null ? runnerId : null,
      };
      wipe(null);
      if (options.erasesOnRestart === true && stopped.runnerId !== null)
        set({ pendingErasure: true });
      return stopped;
    },

    async requestPermission(app) {
      calls.push(`requestPermission:${app}`);
      const current = permissionOf(app);
      if (current === null) throw bridgeError("unsupported");
      const answered = await (permissionAnswers.get(app) ??
        (current === "not-determined" ? "granted" : current));
      permissionAnswers.delete(app);
      set({
        permissions: { ...snapshot.permissions, [app]: answered },
        ...(app === "iphone-location"
          ? {
              locationAccuracy:
                answered === "granted" ? (snapshot.locationAccuracy ?? "precise") : null,
            }
          : {}),
      });
      return answered;
    },

    async chooseContacts() {
      calls.push("chooseContacts");
      const current = permissionOf("apple-contacts");
      if (current === null) throw bridgeError("unsupported");
      return current;
    },

    async choosePhotos() {
      calls.push("choosePhotos");
      const current = permissionOf("iphone-photos");
      if (current === null) throw bridgeError("unsupported");
      // The fake picker chooses nothing; closing it changes nothing.
      return current;
    },
  };

  const device: FakeIphoneDevice = {
    calls,
    answerPermissionWith(app, answer) {
      permissionAnswers.set(app, answer);
    },
    connect,
    enrolledTo(input) {
      prepared = { deploymentId: input.deploymentId, mintKey: fakeMintKey() };
      set({
        connection: input.connection ?? "online",
        enrollment: {
          deploymentId: input.deploymentId,
          deploymentName: "Mac mini",
          enrollmentId: null,
          hostUrl: input.hostUrl ?? "https://mac-mini.example.test",
          name: input.name,
          runnerId,
          state: "enrolled",
        },
        issue: null,
        issueMessage: null,
      });
    },
    lastRetarget: () => retargets.at(-1) ?? null,

    mintKey: () => prepared?.mintKey ?? null,
    onEnroll(listener) {
      enrollListeners.push(listener);
    },

    raise(issue, message) {
      set({
        connection:
          issue === "host-unreachable" || issue === "remote-access-off" ? "retrying" : "stopped",
        issue,
        issueMessage: message ?? null,
      });
    },
    reconnect() {
      set({ connection: "retrying" });
      connect();
    },

    removedByHost() {
      wipe("removed");
    },
    runnerId: () => runnerId,
    setLocationAccuracy(accuracy) {
      set({ locationAccuracy: accuracy });
    },
    setPermission(app, permission) {
      if (!offered(app)) throw new Error(`This fake build doesn't offer ${app}.`);
      set({
        permissions: { ...snapshot.permissions, [app]: permission },
        ...(app === "iphone-location" && permission !== "granted"
          ? { locationAccuracy: null }
          : {}),
      });
    },
  };

  return { bridge, device };
}

function bridgeError(code: IphoneAppsErrorCode): Error & { readonly code: IphoneAppsErrorCode } {
  return Object.assign(new Error(`The iPhone refused: ${code}.`), { code });
}

function fakeRunnerId(): string {
  return `rnr_${crypto.randomUUID()}`;
}

function fakeMintKey(): string {
  return `iphone-enroll:${crypto.randomUUID()}`;
}
