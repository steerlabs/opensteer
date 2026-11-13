import { deviceMembership, type DeviceMembership } from "@opensteer/client/computers";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import { RunnerIdSchema } from "@opensteer/core";
import type { DeviceInitialAccess } from "@opensteer/protocol";
import type { NotificationChoice } from "../notifications/push-registration.js";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import {
  iphonePermissionOf,
  type IphoneAddFailure,
  type IphoneAllowFailure,
  type IphoneAppsController,
  type IphoneAppsState,
} from "../iphone-apps/controller.js";
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

export type PhoneSetupPhase =
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
export interface SetupNotifications {
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
export function phoneInitialAccess(draft: PhoneSetupDraft): DeviceInitialAccess {
  return {
    browser: draft.browser,
    apps: Object.values(draft.apps).some(Boolean),
    files: false,
  };
}

/**
 * Set up this phone, from Continue to Ready: enroll with the chosen switches,
 * then one system prompt at a time — Notifications first, then each chosen
 * app — and read back how each settled. Nothing the OS refuses holds up Ready;
 * only enrollment can fail the step.
 */
export class PhoneSetup {
  readonly #listeners = new Set<() => void>();
  #state: PhoneSetupState;
  #running = false;

  constructor(draft: PhoneSetupDraft) {
    this.#state = {
      phase: { kind: "editing" },
      browser: draft.browser ? "on" : "off",
      notifications: draft.notifications ? "on" : "off",
      apps: Object.fromEntries(
        Object.entries(draft.apps).map(([app, on]) => [app, on ? "on" : "off"]),
      ),
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
      const host = hostClient.getSnapshot();
      this.#set({
        phase: { kind: "enrolling" },
        browser: draft.browser ? "on" : "off",
        notifications: draft.notifications ? "on" : "off",
        apps: Object.fromEntries(
          Object.entries(draft.apps).map(([app, on]) => [app, on ? "on" : "off"]),
        ),
      });
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
      if (draft.notifications) this.#set({ phase: { kind: "asking", item: "notifications" } });
      const notifications = await input.notifications
        .choose(draft.notifications)
        .catch((): NotificationChoice => "unavailable");
      this.#set({ notifications });
      const chosen = iphoneAppIds.filter((app) => draft.apps[app] === true);
      for (const app of chosen) {
        this.#set({ phase: { kind: "asking", item: app } });
        await controller.share({
          apps: [{ access: iphoneDefaultAccess(app, null), app }],
          hostClient,
        });
        const after = controller.getState();
        const outcome =
          after.changes[app]?.phase === "unknown" ? "waiting" : outcomeOf(after.failures[app]);
        this.#set({ apps: { ...this.#state.apps, [app]: outcome } });
      }
      this.#set({ phase: { kind: "ready", runnerId: added.runnerId } });
      return this.#state;
    } finally {
      this.#running = false;
    }
  }

  #set(patch: Partial<PhoneSetupState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }
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

/** Whether Ready can say the agent can use anything at all on this phone. */
export function phoneSetupSharesAnything(state: PhoneSetupState): boolean {
  return state.browser === "on" || Object.values(state.apps).some((outcome) => outcome === "on");
}

/** This phone's membership in one personal Deployment, from the shared derivation. */
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
      runnerId: RunnerIdSchema.safeParse(enrollment?.runnerId).data ?? null,
      state:
        input.iphone.removedFrom?.deploymentId === input.deploymentId
          ? "removed"
          : enrollment !== null
            ? "active"
            : "none",
    },
    settingUp: input.iphone.adding === input.deploymentId,
  });
}
