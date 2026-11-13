import {
  deviceMembership,
  withDeviceSwitch,
  type DeviceMembership,
} from "@opensteer/client/computers";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { RunnerIdSchema } from "@opensteer/core";
import { deviceAccess, type DeviceInitialAccess } from "@opensteer/protocol";
import type { NotificationChoice } from "../notifications/push-registration.js";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import {
  iphonePermissionOf,
  type IphoneAddFailure,
  type IphoneAllowFailure,
  type IphoneAppsController,
  type IphoneAppsState,
} from "../iphone-apps/controller.js";
import type { PhoneSetupProgress } from "./setup-file.js";
import { iphoneAppIds, iphoneDefaultAccess } from "../iphone-apps/model.js";

/** What the person chose on Set up this phone; nothing is asked of the OS before Continue. */
export interface PhoneSetupDraft {
  readonly name: string;
  readonly browser: boolean;
  readonly apps: Readonly<Partial<Record<IphoneAppId, boolean>>>;
  readonly notifications: boolean;
}

/**
 * How one switch settled. `denied` is the OS saying no: the switch reads off
 * and its footer offers Settings. Neither it nor `waiting` blocks Ready.
 */
export type PhoneSetupOutcome = "on" | "off" | "denied" | "waiting" | "unavailable";

type PhoneSetupPhase =
  | { readonly kind: "editing" }
  | { readonly kind: "enrolling" }
  | { readonly kind: "asking"; readonly item: "notifications" | IphoneAppId }
  | { readonly kind: "failed"; readonly failure: IphoneAddFailure }
  | { readonly kind: "ready"; readonly runnerId: string };

export interface PhoneSetupState {
  readonly phase: PhoneSetupPhase;
  readonly browser: PhoneSetupOutcome;
  readonly notifications: PhoneSetupOutcome;
  readonly apps: Readonly<Partial<Record<IphoneAppId, PhoneSetupOutcome>>>;
}

/** The Notifications choice, applied durably after Continue; only on asks the OS. */
interface SetupNotifications {
  choose(on: boolean): Promise<NotificationChoice>;
}

/** The apps this build offers on Set up, with Photos off by default: it shares the whole library. */
export function phoneSetupDraft(
  controller: IphoneAppsController,
  platform: "android" | "ios",
): PhoneSetupDraft {
  const snapshot = controller.getState().snapshot;
  return {
    name: snapshot.deviceName,
    browser: true,
    apps:
      platform === "ios"
        ? Object.fromEntries(
            iphoneAppIds
              .filter((app) => iphonePermissionOf(snapshot, app) !== null)
              .map((app) => [app, app !== "iphone-photos"]),
          )
        : {},
    notifications: true,
  };
}

/** The initial switches the Host stores with the enrollment; a phone never offers files. */
function phoneInitialAccess(draft: PhoneSetupDraft): DeviceInitialAccess {
  return {
    browser: draft.browser,
    apps: Object.values(draft.apps).some(Boolean),
    files: false,
  };
}

/** Nothing the OS refuses holds up Ready; only enrollment can fail the step. */
export class PhoneSetup {
  readonly #listeners = new Set<() => void>();
  #state: PhoneSetupState;
  #running = false;

  constructor(draft: PhoneSetupDraft, progress?: PhoneSetupProgress) {
    this.#state = {
      phase: { kind: "editing" },
      browser: progress?.browser ?? (draft.browser ? "on" : "off"),
      notifications: progress?.notifications ?? (draft.notifications ? "on" : "off"),
      apps:
        progress?.apps ??
        Object.fromEntries(Object.entries(draft.apps).map(([app, on]) => [app, on ? "on" : "off"])),
    };
  }

  getState = (): PhoneSetupState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async run(input: {
    readonly controller: IphoneAppsController;
    readonly deploymentId: string;
    readonly draft: PhoneSetupDraft;
    readonly hostClient: HostClient;
    readonly notifications: SetupNotifications;
  }): Promise<PhoneSetupState> {
    if (this.#running) return this.#state;
    this.#running = true;
    try {
      const { controller, draft, hostClient } = input;
      const saved = controller.getState().phoneSetups?.[input.deploymentId];
      const progress = saved && sameDraft(saved.draft, draft) ? saved : undefined;
      const completed = [...(progress?.completed ?? [])];
      let runnerId = progress?.runnerId ?? null;
      const persist = async (): Promise<void> => {
        await controller.savePhoneSetup(input.deploymentId, {
          draft: { ...draft, apps: { ...draft.apps } },
          runnerId,
          completed: [...completed],
          deferred: false,
          browser: this.#state.browser,
          notifications: this.#state.notifications,
          apps: { ...this.#state.apps },
        });
      };
      this.#set({
        phase: { kind: "enrolling" },
        browser: progress?.browser ?? (draft.browser ? "on" : "off"),
        notifications: progress?.notifications ?? (draft.notifications ? "on" : "off"),
        apps:
          progress?.apps ??
          Object.fromEntries(
            Object.entries(draft.apps).map(([app, on]) => [app, on ? "on" : "off"]),
          ),
      });
      await persist();
      const host = hostClient.getSnapshot();
      const added = await controller.add({
        deploymentId: input.deploymentId,
        hostClient,
        iphoneAppsAvailable: host.iphoneAppsAvailable,
        name: draft.name.trim(),
        ...(host.devicesAvailable === true ? { access: phoneInitialAccess(draft) } : {}),
      });
      if (added.kind !== "added") {
        this.#set({
          phase: {
            kind: "failed",
            failure: added.kind === "failed" ? added.failure : { kind: "failed" },
          },
        });
        return this.#state;
      }
      if (runnerId !== null && runnerId !== added.runnerId) completed.length = 0;
      runnerId = added.runnerId;
      if (!completed.includes("enrollment")) {
        if (host.devicesAvailable === true) {
          const access = await applyPhoneAccess(hostClient, added.runnerId, draft);
          this.#set({ browser: access.browser ? "on" : "off" });
        }
        completed.push("enrollment");
        await persist();
      }
      if (!completed.includes("notifications")) {
        if (draft.notifications) this.#set({ phase: { kind: "asking", item: "notifications" } });
        const notifications = await input.notifications
          .choose(draft.notifications)
          .catch((): NotificationChoice => "unavailable");
        this.#set({ notifications });
        completed.push("notifications");
        await persist();
      }
      const chosen = iphoneAppIds.filter((app) => draft.apps[app] === true);
      for (const app of chosen) {
        if (completed.includes(app)) continue;
        this.#set({ phase: { kind: "asking", item: app } });
        if (controller.getState().changes[app]?.phase === "unknown") {
          await controller.check({ app, hostClient });
        } else {
          await controller.share({
            apps: [{ access: iphoneDefaultAccess(app, null), app }],
            hostClient,
          });
        }
        const after = controller.getState();
        const outcome =
          after.changes[app]?.phase === "unknown" ? "waiting" : outcomeOf(after.failures[app]);
        this.#set({ apps: { ...this.#state.apps, [app]: outcome } });
        completed.push(app);
        await persist();
      }
      if (host.devicesAvailable === true) {
        await hostClient.refresh();
        const access = phoneAccess(hostClient, added.runnerId);
        this.#set({
          browser: access.browser ? "on" : "off",
          apps: access.apps
            ? this.#state.apps
            : Object.fromEntries(Object.keys(this.#state.apps).map((app) => [app, "off"])),
        });
      }
      await controller.savePhoneSetup(input.deploymentId, null);
      this.#set({ phase: { kind: "ready", runnerId: added.runnerId } });
      return this.#state;
    } catch (error) {
      this.#set({ phase: { kind: "failed", failure: { kind: "failed" } } });
      throw error;
    } finally {
      this.#running = false;
    }
  }

  #set(patch: Partial<PhoneSetupState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
}

function sameDraft(left: PhoneSetupDraft, right: PhoneSetupDraft): boolean {
  return (
    left.name === right.name &&
    left.browser === right.browser &&
    left.notifications === right.notifications &&
    iphoneAppIds.every((app) => left.apps[app] === right.apps[app])
  );
}

function phoneAccess(host: HostClient, runnerId: string): ReturnType<typeof deviceAccess> {
  const access = host.getSnapshot().machines.find((machine) => machine.id === runnerId)?.access;
  if (!access) throw new Error("This phone's access could not be confirmed. Try again.");
  return deviceAccess(access.policy);
}

async function applyPhoneAccess(host: HostClient, runnerId: string, draft: PhoneSetupDraft) {
  await host.refresh();
  const wanted = phoneInitialAccess(draft);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const access = host.getSnapshot().machines.find((machine) => machine.id === runnerId)?.access;
    if (!access) throw new Error("This phone's access could not be confirmed. Try again.");
    const current = deviceAccess(access.policy);
    if (current.browser === wanted.browser && current.apps === wanted.apps && !current.files)
      return current;
    const result = await host.updateMachineAccess({
      runnerId,
      expectedRevision: access.revision,
      policy: {
        ...withDeviceSwitch(access.policy, "browser", wanted.browser),
        apps: wanted.apps,
        reach: "nobody",
      },
    });
    if (result.outcome === "updated") return phoneAccess(host, runnerId);
    await host.refresh();
  }
  throw new Error("This phone's access changed on another device. Try again.");
}

function outcomeOf(failure: IphoneAllowFailure | undefined): PhoneSetupOutcome {
  if (failure === undefined) return "on";
  switch (failure.kind) {
    case "blocked":
      return "denied";
    case "waiting":
      return "waiting";
    case "not-offered":
    case "not-allowed":
      return "unavailable";
  }
}

export function phoneSetupSharesAnything(state: PhoneSetupState): boolean {
  return state.browser === "on" || Object.values(state.apps).some((outcome) => outcome === "on");
}

export function phoneMembership(input: {
  readonly deploymentId: string;
  readonly host: Pick<HostSnapshot, "iphoneAppsAvailable">;
  readonly iphone: IphoneAppsState;
}): DeviceMembership | { readonly state: "elsewhere"; readonly deploymentName: string } {
  const { enrollment, pendingErasure, supported } = input.iphone.snapshot;
  if (enrollment !== null && enrollment.deploymentId !== input.deploymentId)
    return { state: "elsewhere", deploymentName: enrollment.deploymentName };
  return deviceMembership({
    applicable: supported && input.host.iphoneAppsAvailable && pendingErasure !== true,
    authenticated: true,
    hosting: false,
    membership: {
      generation: 0,
      enrolled: enrollment?.state === "enrolled",
      runnerId: RunnerIdSchema.safeParse(enrollment?.runnerId).data ?? null,
      state:
        input.iphone.removedFrom?.deploymentId === input.deploymentId
          ? "removed"
          : enrollment !== null
            ? "active"
            : "none",
    },
    finishSetupReason:
      enrollment?.state === "pending" ||
      (input.iphone.phoneSetups?.[input.deploymentId] !== undefined &&
        input.iphone.phoneSetups[input.deploymentId]?.deferred !== true)
        ? "Finish setting up this phone"
        : null,
    settingUp: input.iphone.adding === input.deploymentId,
  });
}
