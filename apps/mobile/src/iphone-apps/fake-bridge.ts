import type { MockHostClient } from "@opensteer/client/mock";
import type { HostApiCommandInput } from "@opensteer/protocol";
import type {
  IphoneAppId,
  IphoneAppsApproval,
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
  listApprovals(approvals: readonly IphoneAppsApproval[]): void;
  mintKey(): string | null;
  onEnroll(listener: () => void): void;
  publicKey(): string;
  raise(issue: IphoneAppsIssue, message?: string): void;
  reconnect(): void;
  registerKey(): void;
  removedByHost(): void;
  runnerId(): string;
  setLocationAccuracy(accuracy: "approximate" | "precise" | null): void;
  setPermission(app: IphoneAppId, permission: IphonePermission): void;
  /** Mock mode: re-reads the requests the Host would push to this iPhone. */
  syncFromHost(): Promise<void>;
}

const iphoneAppIds: readonly IphoneAppId[] = [
  "apple-calendar",
  "apple-contacts",
  "apple-reminders",
  "iphone-location",
  "iphone-photos",
];
const fakePublicKey =
  "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAZmFrZS1pcGhvbmUtYXBwcm92YWwta2V5LTAwMDAwMDA=\n-----END PUBLIC KEY-----\n";

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
    approvalKey: null,
    approvals: [],
    connection: "none",
    deviceName: options.deviceName ?? "iPhone",
    enrollment: null,
    issue: null,
    issueMessage: null,
    ...(offered("iphone-location") ? { locationAccuracy: null } : {}),
    permissions: {
      "apple-calendar": "not-determined",
      "apple-contacts": "not-determined",
      "apple-reminders": "not-determined",
      ...Object.fromEntries(
        offers.filter((app) => app.startsWith("iphone-")).map((app) => [app, "not-determined"]),
      ),
    },
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

  const key = () => ({
    keyId: `sha256:${runnerId
      .replace(/[^A-Za-z0-9]/gu, "")
      .padStart(43, "K")
      .slice(-43)}`,
    publicKey: fakePublicKey,
    registered: snapshot.approvalKey?.registered ?? false,
  });

  const connect = (): void => {
    set({
      approvalKey: key(),
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
      approvalKey: null,
      approvals: [],
      connection: "none",
      enrollment: null,
      issue,
      issueMessage: null,
      retryAt: null,
      working: 0,
    });
  };

  /** Mock mode: the requests the Host pushes to this iPhone, as native lists them. */
  const syncApprovals = async (host: MockHostClient): Promise<void> => {
    const result = await host.rpc["integration.computer.setup.list"]({});
    if (!result.ok || snapshot.enrollment === null) return;
    const ownRunnerId = runnerId;
    set({
      approvals: result.data.requests.flatMap((request): IphoneAppsApproval[] =>
        request.kind === "app" && request.runnerId === ownRunnerId && offered(request.definitionId)
          ? [
              {
                access: request.access,
                createdAt: request.createdAt,
                definitionId: request.definitionId,
                expiresAt: request.expiresAt,
                reason: request.reason,
                setupRequestId: request.id,
                threadTitle: request.threadTitle,
                workspaceName: request.workspaceName,
              },
            ]
          : [],
      ),
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
      host.mockConnectIphone({ enrollmentId: input.enrollmentId, name: input.name, runnerId });
    } catch (error) {
      set({
        connection: "stopped",
        issue: "enrollment-refused",
        issueMessage: error instanceof Error ? error.message : null,
      });
      return;
    }
    connect();
    detachHost = host.subscribe(() => void syncApprovals(host).catch(() => undefined));
    void syncApprovals(host).catch(() => undefined);
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
      return snapshot.permissions["apple-contacts"];
    },

    async choosePhotos() {
      calls.push("choosePhotos");
      const current = permissionOf("iphone-photos");
      if (current === null) throw bridgeError("unsupported");
      // The fake picker chooses nothing; closing it changes nothing.
      return current;
    },

    async answerApproval(input) {
      calls.push(
        `answerApproval:${input.setupRequestId}:${input.decision}:${input.expected.definitionId}:${input.expected.access}`,
      );
      const listed = snapshot.approvals.find(
        ({ setupRequestId }) => setupRequestId === input.setupRequestId,
      );
      if (
        listed === undefined ||
        !offered(listed.definitionId) ||
        listed.definitionId !== input.expected.definitionId ||
        listed.access !== input.expected.access ||
        Date.parse(listed.expiresAt) <= Date.now()
      ) {
        return {
          kind: "unavailable",
          message: "This request is no longer waiting on this iPhone.",
        };
      }
      const host =
        snapshot.enrollment === null
          ? null
          : (options.host?.(snapshot.enrollment.deploymentId) ?? null);
      if (host !== null) {
        try {
          await host.mockAnswerIphoneApproval({
            decision: input.decision,
            setupRequestId: input.setupRequestId,
          });
        } catch (error) {
          return {
            kind: "refused",
            message: error instanceof Error ? error.message : "The Host refused this answer.",
          };
        }
      }
      set({
        approvals: snapshot.approvals.filter(
          ({ setupRequestId }) => setupRequestId !== input.setupRequestId,
        ),
      });
      return input.decision === "allow" ? { kind: "allowed" } : { kind: "declined" };
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
        approvalKey: key(),
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
    listApprovals(approvals) {
      set({ approvals });
    },
    mintKey: () => prepared?.mintKey ?? null,
    onEnroll(listener) {
      enrollListeners.push(listener);
    },
    publicKey: () => fakePublicKey,
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
    registerKey() {
      set({ approvalKey: { ...key(), registered: true } });
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
    async syncFromHost() {
      const host =
        snapshot.enrollment === null
          ? null
          : (options.host?.(snapshot.enrollment.deploymentId) ?? null);
      if (host !== null) await syncApprovals(host);
    },
  };

  return { bridge, device };
}

/**
 * Mock mode's stand-in for what a real Host pushes to the iPhone after a
 * command lands: its registered key, once the iPhone proved it holds it, and
 * the requests waiting on it whenever they change.
 */
export async function observeMockHostCommand(
  fake: FakeIphoneApps,
  command: HostApiCommandInput,
): Promise<void> {
  if (
    command.type === "integration.computer.approval-key.set" &&
    command.input.runnerId === fake.device.runnerId() &&
    fake.bridge.getSnapshot().approvalKey !== null
  ) {
    fake.device.registerKey();
  }
  if (
    command.type === "integration.computer.setup.request" ||
    command.type === "integration.computer.setup.cancel" ||
    command.type === "integration.computer.setup.set" ||
    command.type === "integration.disconnect"
  ) {
    await fake.device.syncFromHost();
  }
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
