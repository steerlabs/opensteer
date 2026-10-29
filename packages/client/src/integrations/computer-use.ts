import type {
  ComputerAppIdentity,
  ComputerAppSetupRequest,
  ComputerUseAppApproval,
  IntegrationAccess,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";
import { computerAppIdentityKey } from "@opensteer/integration-core";
import {
  androidPhoneDefinitionId,
  type ComputerUsePermissions,
  type ComputerUseSessionSummary,
  type MachineSummary,
} from "@opensteer/protocol";
import { turnComputer, type TranscriptGroup, type Turn } from "../host/agent-activity-model.js";
import { mutationIdempotencyKey, unwrapRpcResult } from "../host/host-session-client.js";
import type { HostClient } from "../host/index.js";

/**
 * Computer use on one Mac, and on one Android phone, as every client surface
 * reasons about it.
 *
 * Computer use is the one computer app with many connections on one machine,
 * one per approved app, so the one-row-per-definition projection in
 * `computer-apps.ts` does not describe it. This module does, framework free,
 * so web, desktop panels and the mobile app agree on what a Mac offers, what
 * still needs the person, and what is happening right now.
 *
 * An Android phone is used whole: one owner-set connection and one task at a
 * time on its entire screen. It has its own smaller view below, so no sentence
 * about a Mac is ever said about a phone.
 */

export const computerUseAccessLabel: Readonly<Record<IntegrationAccess, string>> = {
  read: "Can see",
  "read-write": "Can see and control",
};

export const computerUseAccessSummary: Readonly<Record<IntegrationAccess, string>> = {
  read: "Agents can read the app's interface and take screenshots of it. Nothing is clicked or typed.",
  "read-write":
    "Agents can see the app and click, type, scroll, press keys, and open it in the background. What the app can do, agents can do through it.",
};

/** The feature in one sentence, where the Mac is named as the viewer sees it. */
export function computerUseIntroduction(viewer: {
  readonly here: boolean;
  readonly machineName: string;
}): string {
  return `Let agents see and operate apps on ${viewer.here ? "this Mac" : viewer.machineName} while you keep using it.`;
}

export const macosAccessibilityLabel = "macOS Accessibility";
export const macosScreenRecordingLabel = "macOS Screen Recording";
/** How the macOS Privacy & Security lists name the helper. */
export const computerUseHelperName = "Opensteer Computer Use";

export type ComputerUseGrant = "accessibility" | "screen-recording";

export const computerUseGrantLabel: Readonly<Record<ComputerUseGrant, string>> = {
  accessibility: macosAccessibilityLabel,
  "screen-recording": macosScreenRecordingLabel,
};

/** The per-Mac App approvals policy, in the words of its two choices. */
export const computerUseAppApprovalLabel: Readonly<Record<ComputerUseAppApproval, string>> = {
  ask: "Ask for each app",
  automatic: "Allow any app automatically",
};

export const computerUseAppApprovalsTitle = "App approvals";
/** The same choice, asked once when a Mac has just been set up. */
export const computerUseSetupQuestion = "Which apps can agents use?";
/** Under automatic the list fills itself, so an empty one is not a problem to solve. */
export const computerUseAutomaticNote = "Apps appear below as agents use them.";

export function computerUseAppApprovalDetail(
  appApproval: ComputerUseAppApproval,
  machineName: string,
): string {
  return appApproval === "ask"
    ? `You approve each app on ${machineName} the first time a task needs it.`
    : "Agents can use any app a task needs without asking; password managers, terminals and automation tools stay off limits.";
}

/**
 * The confirmation for turning automatic approval on. It is the whole
 * consequence, said once, on the Mac it applies to: every app, including
 * later ones and the ones that reach everything else.
 */
export const computerUsePolicyConfirmation = {
  allow: "Allow any app",
  body: "Agents acting for you can see and control any app on this Mac when a task needs it, including apps installed later, and including browsers, Finder, Mail and System Settings with what they are signed in to. Password managers, terminals and automation tools stay off limits. Blocked apps stay blocked.",
  cancel: "Cancel",
  title: "Allow any app automatically on this Mac?",
} as const;

/** What the approval panel says when the helper judges an app to reach beyond itself. */
export const computerUseElevatedNote =
  "This app can reach your files, signed-in accounts or system settings. Agents can use whatever its interface offers.";

/** The approval panel's question: the task's own name when a task asked. */
export function computerUseApprovalTitle(input: {
  readonly appName: string;
  readonly threadTitle: string | null;
}): string {
  return input.threadTitle
    ? `Let "${input.threadTitle}" use ${input.appName} on this Mac?`
    : `Let agents use ${input.appName} on this Mac?`;
}

/**
 * Who is looking at a Mac's computer use: from that Mac itself (the desktop
 * app running there), or from anywhere else — another computer, a browser, or
 * the phone. Every sentence that names a place depends on it.
 */
export interface ComputerUseViewer {
  readonly here: boolean;
  readonly machineName: string;
}

/** `this Mac` on the Mac itself, its name everywhere else. */
export function computerUseWhere(viewer: ComputerUseViewer): string {
  return viewer.here ? "this Mac" : viewer.machineName;
}

/** Where an approval happens, for a surface that is not that Mac. */
export function computerUseApproveOn(machineName: string): string {
  return `Approve on ${machineName}`;
}

/** Where the grants are given, for a surface that is not that Mac. */
export function computerUseSetUpFrom(machineName: string): string {
  return `Set up from ${machineName}`;
}

/**
 * The way to that Mac's own page, said right after `computerUseSetUpFrom`. A
 * browser on the Mac is "elsewhere" too: only the desktop app can open the
 * macOS panels, so the instruction names the app rather than a URL.
 */
export function computerUseSetUpFromSteps(machineName: string): string {
  return `In the Opensteer desktop app there, open Settings → Computers → ${machineName}.`;
}

/** Automatic approval is confirmed on the Mac it covers, never from elsewhere. */
export function computerUseTurnOnFrom(machineName: string): string {
  return `Turn this on from ${machineName}.`;
}

/** A blocked app returns only through an ordinary approval on that Mac. */
export function computerUseUnblockOn(viewer: ComputerUseViewer): string {
  return `Unblock on ${computerUseWhere(viewer)}`;
}

/** Said while the policy change waits for its native confirmation. */
export const computerUseConfirmOnThisMac = "Confirm in the Opensteer window on this Mac.";

/**
 * Adding an app is approving it, and approving happens only on the Mac, in the
 * native panel. A surface that is not the Mac says where instead of offering it.
 */
export function computerUseAddAppsOn(machineName: string): string {
  return `New apps are approved on ${machineName}: a task asks there when it needs one, or add one from Opensteer on that Mac.`;
}

/** Why each grant is asked for, beside its name. */
export const computerUseGrantPurpose: Readonly<Record<ComputerUseGrant, string>> = {
  accessibility: "So agents can operate it.",
  "screen-recording": "So agents can see the app.",
};

/** Seeing comes before operating, on the page and in System Settings. */
export const computerUseGrantOrder: readonly ComputerUseGrant[] = [
  "screen-recording",
  "accessibility",
];

/**
 * No Mac in this deployment can do computer use yet. The desktop app is what
 * holds the helper, so installing it on a Mac and adding that Mac is the whole
 * next step.
 */
export const computerUseNoMac = {
  action: "Go to Computers",
  detail:
    "Install and open the Opensteer desktop app on the Mac agents should use, then add that Mac to this deployment from Computers.",
  title: "No Mac is set up for computer use yet.",
} as const;

/**
 * What to do about a Mac without the desktop app, from somewhere else. On the
 * Mac itself the status line already says it, in the Host's own words.
 */
export function computerUseInstallOn(machineName: string): string {
  return `Install and open the Opensteer desktop app on ${machineName}; its page there shows the next step.`;
}

export interface ComputerUseAppRow {
  readonly access: IntegrationAccess;
  /** The owner blocked it: no tools, no grants, and it never returns on its own. */
  readonly blocked: boolean;
  readonly connectionId: string;
  readonly identity: ComputerAppIdentity;
  /** True while one of the Mac's live sessions holds this app. */
  readonly inUse: boolean;
}

export interface ComputerUsePendingApp {
  readonly access: IntegrationAccess;
  readonly identity: ComputerAppIdentity;
  readonly request: ComputerAppSetupRequest;
}

export type ComputerUseState =
  | { readonly kind: "offline" }
  | { readonly detail: string; readonly kind: "unavailable" }
  | {
      readonly kind: "permission-required";
      readonly missing: readonly ComputerUseGrant[];
      readonly permissions: ComputerUsePermissions | null;
    }
  | { readonly kind: "ready" };

export interface ComputerUseView {
  /** Null means this Mac cannot answer app approvals until its desktop key is registered. */
  readonly approvalKeyId: string | null;
  readonly appApproval: ComputerUseAppApproval;
  readonly apps: readonly ComputerUseAppRow[];
  readonly definition: IntegrationDefinitionSummaryView;
  readonly pending: readonly ComputerUsePendingApp[];
  readonly sessions: readonly ComputerUseSessionSummary[];
  readonly state: ComputerUseState;
}

/**
 * The Mac's computer app: the one whose connections each name an app. A
 * phone's `display` definition is also operated in sessions, so the kind is
 * what tells them apart, never which one the catalog lists first.
 */
export function computerUseDefinition(
  definitions: readonly IntegrationDefinitionSummaryView[],
): IntegrationDefinitionSummaryView | null {
  return definitions.find((definition) => definition.computerApp?.kind === "gui") ?? null;
}

/**
 * Whether this computer is an Android phone, which agents use whole through
 * the Agent Phone app on it. The phone's Runner says so in its device; the
 * Host routes nothing on that, but every sentence about the computer depends
 * on it.
 */
export function isAndroidPhone(machine: Pick<MachineSummary, "device">): boolean {
  return machine.device?.platform === "android";
}

/**
 * Whether this computer is an iPhone, which lends only its own Calendar,
 * Contacts and Reminders, and only while Opensteer is open on it. It turns its
 * apps on and answers requests for more access itself.
 */
export function isIphone(machine: Pick<MachineSummary, "device">): boolean {
  return machine.device?.platform === "ios";
}

/**
 * Computer use on one machine, or `null` when nothing about it applies.
 *
 * A machine that is not a Mac, or a Mac the Host has never heard describe
 * computer use, is `null` and the page shows nothing. A Mac that reported once
 * keeps its block while offline, so approved apps stay visible. A phone is
 * always `null` here: `phoneUseView` describes it.
 */
export function computerUseView(input: {
  /** False when this client cannot confirm activity with its Host. */
  readonly hostConnected: boolean;
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly machine: MachineSummary;
  readonly setupRequests?: readonly ComputerAppSetupRequest[];
}): ComputerUseView | null {
  const definition = computerUseDefinition(input.definitions);
  if (!definition) return null;
  const { machine } = input;
  if (isAndroidPhone(machine)) return null;
  const report = machine.computerUse ?? null;
  // A disconnected Runner cannot have a confirmed live session. Keep its
  // approved apps visible, but never describe an old report as active use.
  const sessions =
    input.hostConnected && machine.status === "online" ? (report?.sessions ?? []) : [];
  const held = new Set(
    sessions.flatMap((session) => session.apps.map((app) => computerAppIdentityKey(app))),
  );
  const apps = input.connections
    .flatMap((connection): ComputerUseAppRow[] => {
      const computer = connection.computer;
      if (
        connection.status === "revoked" ||
        connection.definitionId !== definition.id ||
        computer?.runnerId !== machine.id ||
        !computer.app
      ) {
        return [];
      }
      return [
        {
          access: computer.access,
          blocked: computer.blockedAt !== null,
          connectionId: connection.id,
          identity: computer.app,
          inUse: held.has(computerAppIdentityKey(computer.app)),
        },
      ];
    })
    // Blocked apps read last: they are the ones agents cannot use.
    .sort(
      (left, right) =>
        Number(left.blocked) - Number(right.blocked) ||
        left.identity.displayName.localeCompare(right.identity.displayName),
    );
  const pending = (input.setupRequests ?? []).flatMap((request): ComputerUsePendingApp[] =>
    request.kind === "app" &&
    request.runnerId === machine.id &&
    request.definitionId === definition.id &&
    request.app
      ? [{ access: request.access, identity: request.app, request }]
      : [],
  );
  if (!report && apps.length === 0 && pending.length === 0) return null;
  return {
    approvalKeyId: report?.approvalKeyId ?? null,
    appApproval: report?.appApproval ?? "ask",
    apps,
    definition,
    pending,
    sessions,
    state: computerUseState(machine),
  };
}

/** The approval key is registered from the desktop app on the Mac itself. */
export function computerUseApprovalKeyStep(viewer: ComputerUseViewer): string {
  return viewer.here
    ? "Opensteer is setting up app approvals on this Mac."
    : `To enable app approvals, open Settings → Computers → ${viewer.machineName} in the Opensteer desktop app on that Mac.`;
}

export function computerUseState(machine: MachineSummary): ComputerUseState {
  if (machine.status !== "online") return { kind: "offline" };
  const report = machine.computerUse;
  if (!report || report.state === "unavailable") {
    return {
      detail: report?.detail ?? "Computer use needs the Opensteer desktop app on this Mac.",
      kind: "unavailable",
    };
  }
  if (report.state === "permission-required") {
    const permissions = report.permissions;
    // Seeing comes before operating, on the page and in System Settings.
    const missing: ComputerUseGrant[] = [];
    if (permissions?.screenRecording !== "granted") missing.push("screen-recording");
    if (permissions?.accessibility !== "granted") missing.push("accessibility");
    return { kind: "permission-required", missing, permissions };
  }
  return { kind: "ready" };
}

/** `Notes`, `Notes and Calendar`, `Notes, Calendar and 2 more`. */
export function computerUseAppsPhrase(apps: readonly { readonly displayName: string }[]): string {
  const names = apps.map((app) => app.displayName);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * `Using Notes`, `Using Notes and Calendar`: one live session, by what it
 * holds. A phone's session holds its whole screen rather than apps.
 */
export function computerUseSessionTitle(session: ComputerUseSessionSummary): string {
  return session.display
    ? "Using the whole screen"
    : `Using ${computerUseAppsPhrase(session.apps)}`;
}

/**
 * The Host's reason a Mac cannot do computer use, for this viewer.
 *
 * The Host and the Runner say it from the Mac's side (`… on this Mac.`), which
 * is true on that Mac and wrong everywhere else, so elsewhere the Mac is named
 * and the rest of the sentence is kept: it is the only thing that says why.
 */
export function computerUseUnavailableDetail(detail: string, viewer: ComputerUseViewer): string {
  return viewer.here ? detail : detail.replaceAll("this Mac", viewer.machineName);
}

/** The status line under the block's title, for this viewer. */
export function computerUseStatusLine(view: ComputerUseView, viewer: ComputerUseViewer): string {
  switch (view.state.kind) {
    case "offline":
      return `${viewer.machineName} is offline.`;
    case "unavailable":
      return computerUseUnavailableDetail(view.state.detail, viewer);
    case "permission-required":
      return view.state.missing.length === 2
        ? `Needs ${macosScreenRecordingLabel} and ${macosAccessibilityLabel}.`
        : `Needs ${computerUseGrantLabel[view.state.missing[0] ?? "accessibility"]}.`;
    case "ready": {
      if (view.sessions.length > 0) {
        const held = new Map(
          view.sessions
            .flatMap((session) => session.apps)
            .map((app) => [computerAppIdentityKey(app), app] as const),
        );
        return `Using ${computerUseAppsPhrase([...held.values()])} now.`;
      }
      if (view.approvalKeyId === null) return "Needs app approval setup.";
      const approved = view.apps.filter((row) => !row.blocked).length;
      return approved === 0
        ? "Ready. No apps approved yet."
        : `${approved} ${approved === 1 ? "app" : "apps"} approved.`;
    }
  }
}

/**
 * The block's state as one of four tones: the agent at work (ember, the
 * agent's own colour), ready, waiting on the person, or nothing to do here.
 */
export type ComputerUseTone = "live" | "ready" | "attention" | "idle";

export function computerUseTone(view: ComputerUseView): ComputerUseTone {
  switch (view.state.kind) {
    case "ready":
      return view.sessions.length > 0
        ? "live"
        : view.approvalKeyId === null
          ? "attention"
          : "ready";
    case "permission-required":
      return "attention";
    case "offline":
    case "unavailable":
      return "idle";
  }
}

/**
 * A Mac that has just been set up has nothing in it yet, so the policy is
 * asked as the question it answers rather than shown as a setting.
 */
export function computerUseFirstRun(view: ComputerUseView): boolean {
  return (
    view.state.kind === "ready" &&
    view.approvalKeyId !== null &&
    view.appApproval === "ask" &&
    view.apps.length === 0 &&
    view.pending.length === 0 &&
    view.sessions.length === 0
  );
}

/**
 * Taking an app back, in the words of the Mac's policy: under Ask for each app
 * the approval is removed and a task can ask again; under automatic a removed
 * app would come straight back, so it is blocked. Either acts on the first tap.
 */
export function computerUseTakeBack(input: {
  readonly appApproval: ComputerUseAppApproval;
  readonly appName: string;
  readonly machineName: string;
}): { readonly busyLabel: string; readonly consequence: string; readonly label: string } {
  return input.appApproval === "automatic"
    ? {
        busyLabel: "Blocking…",
        consequence: `Agents can no longer use ${input.appName} on ${input.machineName}, and automatic approval will not bring it back.`,
        label: "Block",
      }
    : {
        busyLabel: "Removing…",
        consequence: `Agents can no longer use ${input.appName} on ${input.machineName}. A task can ask for it again.`,
        label: "Remove",
      };
}

/**
 * A pending approval's one control. A task's request is the agent asking, so
 * the owner declines it, as on the thread's card; one the owner started is
 * cancelled.
 */
export function computerUsePendingAction(pending: Pick<ComputerUsePendingApp, "request">): {
  readonly busyLabel: string;
  readonly label: string;
} {
  return pending.request.threadId
    ? { busyLabel: "Declining…", label: "Decline" }
    : { busyLabel: "Cancelling…", label: "Cancel" };
}

/** The line under App approvals while automatic is on. */
export function computerUseAutomaticFootnote(view: ComputerUseView): string {
  return view.apps.some((row) => !row.blocked)
    ? `${computerUseAutomaticNote} Block one to keep agents out of it.`
    : computerUseAutomaticNote;
}

/**
 * One Mac's computer use in a list of Macs, before its page is open: the state
 * when something is in the way, what is live, and otherwise the policy, which
 * is the one thing that can be changed from away.
 */
export function computerUseMachineLine(machine: MachineSummary, hostConnected: boolean): string {
  if (!hostConnected) return "Status unavailable";
  if (isAndroidPhone(machine)) return phoneUseMachineLine(machine);
  const state = computerUseState(machine);
  switch (state.kind) {
    case "offline":
      return "Offline";
    case "unavailable":
      return "Not set up";
    case "permission-required":
      return "Needs macOS permissions";
    case "ready": {
      const sessions = machine.computerUse?.sessions ?? [];
      if (sessions.length === 0) {
        return computerUseAppApprovalLabel[machine.computerUse?.appApproval ?? "ask"];
      }
      const held = new Map(
        sessions
          .flatMap((session) => session.apps)
          .map((app) => [computerAppIdentityKey(app), app] as const),
      );
      return `Using ${computerUseAppsPhrase([...held.values()])} now`;
    }
  }
}

/* ------------------------------------------------------------------------- *
 * An Android phone
 * ------------------------------------------------------------------------- */

/**
 * The phone's computer app: the `display` one, which names no app because a
 * session holds the phone's entire screen.
 */
export function phoneUseDefinition(
  definitions: readonly IntegrationDefinitionSummaryView[],
): IntegrationDefinitionSummaryView | null {
  return (
    definitions.find(
      (definition) =>
        definition.computerApp?.kind === "display" &&
        definition.computerApp.platforms.includes("android"),
    ) ?? null
  );
}

/**
 * Agents use a phone through its accessibility service, so the one setting a
 * phone can ask for is that one, said in the words Android's Settings use.
 */
export const androidAccessibilityStep =
  "Turn on Opensteer Agent Phone in the phone’s Accessibility settings.";

/**
 * Where a phone stands. A phone has no helper to install and no grants to
 * give from afar: it is there or not, paused or not, and on Android only its
 * own accessibility setting can be missing.
 */
export type PhoneUseState =
  | { readonly kind: "needs-update"; readonly detail?: string }
  | { readonly kind: "offline" }
  | { readonly detail: string; readonly kind: "unavailable" }
  | { readonly detail: string; readonly kind: "permission-required" }
  | { readonly kind: "ready" };

export interface PhoneUseView {
  /** What agents may do on the phone; null when its owner turned access off. */
  readonly access: IntegrationAccess | null;
  readonly connectionId: string | null;
  readonly definition: IntegrationDefinitionSummaryView;
  /** The one task holding the phone's screen now. */
  readonly session: ComputerUseSessionSummary | null;
  readonly state: PhoneUseState;
}

/**
 * One Android phone as its page draws it, or `null` for a machine that is
 * not a phone or a catalog with no phone definition.
 */
export function phoneUseView(input: {
  /** False when this client cannot confirm activity with its Host. */
  readonly hostConnected: boolean;
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly machine: MachineSummary;
}): PhoneUseView | null {
  const { machine } = input;
  if (!isAndroidPhone(machine)) return null;
  const definition = phoneUseDefinition(input.definitions);
  if (!definition) return null;
  // A blocked connection grants nothing.
  const connection =
    input.connections.find(
      ({ computer, definitionId, status }) =>
        status !== "revoked" &&
        definitionId === definition.id &&
        computer?.runnerId === machine.id &&
        computer.blockedAt === null,
    ) ?? null;
  const report = machine.computerUse ?? null;
  // A disconnected phone cannot have a confirmed live session.
  const session =
    input.hostConnected && machine.status === "online"
      ? (report?.sessions.find(({ display }) => display) ?? null)
      : null;
  return {
    access: connection?.computer?.access ?? null,
    connectionId: connection?.id ?? null,
    definition,
    session,
    state: phoneUseState(machine),
  };
}

export function phoneUseState(machine: MachineSummary): PhoneUseState {
  if (machine.status === "needs-update")
    return { kind: "needs-update", ...(machine.detail ? { detail: machine.detail } : {}) };
  if (machine.status === "updating" || machine.status === "update-pending")
    return {
      kind: "unavailable",
      detail:
        machine.detail ??
        (machine.status === "updating"
          ? `Updating Agent Phone on ${machine.name}…`
          : `Tap Update on ${machine.name}.`),
    };
  if (machine.status !== "online") return { kind: "offline" };
  const report = machine.computerUse;
  // Online with nothing reported is the moment between the phone connecting
  // and its first status, which follows at once.
  if (!report) return { detail: "Waiting for the phone to report.", kind: "unavailable" };
  switch (report.state) {
    case "ready":
      return { kind: "ready" };
    case "permission-required":
      return { detail: report.detail ?? androidAccessibilityStep, kind: "permission-required" };
    case "unavailable":
      return { detail: report.detail ?? "The phone can’t be used right now.", kind: "unavailable" };
  }
}

/** The phone's status line, under its block's title. */
export function phoneUseStatusLine(view: PhoneUseView, phoneName: string): string {
  switch (view.state.kind) {
    case "needs-update":
      return view.state.detail ?? `Update Agent Phone on ${phoneName}.`;
    case "offline":
      return `${phoneName} is offline.`;
    case "unavailable":
    case "permission-required":
      return view.state.detail;
    case "ready":
      if (view.session !== null) return "In use now.";
      if (view.access === null) return "Access is off.";
      return view.access === "read-write" ? "Agents can see and control it." : "Agents can see it.";
  }
}

export function phoneUseTone(view: PhoneUseView): ComputerUseTone {
  switch (view.state.kind) {
    case "needs-update":
      return "attention";
    case "ready":
      if (view.session !== null) return "live";
      return view.access === null ? "idle" : "ready";
    case "permission-required":
      return "attention";
    case "offline":
    case "unavailable":
      return "idle";
  }
}

/**
 * How a phone joins, said wherever a phone is the computer still missing: it
 * is set up over USB from a computer, never from itself.
 */
export function addPhoneSteps(phone: string): string {
  return `Plug ${phone} into a computer, open Opensteer there and choose Add a phone in Settings → Computers.`;
}

/** No phone in this deployment can be used by agents yet. */
export const phoneUseNoPhone = {
  action: "Go to Computers",
  detail: addPhoneSteps("a spare phone with Android 11 or later"),
  title: "No phone is set up yet.",
} as const;

/** The phone in one sentence, for its page. */
export const phoneUseIntroduction =
  "Agents see and operate this phone’s whole screen, one task at a time. You control their access here.";

/** One phone's line in a list of computers. */
function phoneUseMachineLine(machine: MachineSummary): string {
  const state = phoneUseState(machine);
  switch (state.kind) {
    case "needs-update":
      return state.detail ?? `Update Agent Phone on ${machine.name}.`;
    case "offline":
      return "Offline";
    case "unavailable":
      return state.detail;
    case "permission-required":
      return "Needs Accessibility";
    case "ready":
      return machine.computerUse?.sessions.some(({ display }) => display) ? "In use now" : "Ready";
  }
}

/**
 * Where a `computer.app.access` Request is answered. Mac approval happens on
 * that Mac; phone access is an owner command available from any client.
 */
export function computerAppAccessApproval(input: {
  readonly definitionId: "android-phone" | "macos-app";
  readonly machines: readonly Pick<MachineSummary, "id" | "name">[];
  readonly onThatMac: boolean;
  readonly runnerId: string;
}): { readonly approveOn: string; readonly detail: string } {
  const name = input.machines.find(({ id }) => id === input.runnerId)?.name;
  if (input.definitionId === androidPhoneDefinitionId) {
    const where = name ?? "that phone";
    return {
      approveOn: "Allow on this device",
      detail: `You can give agents access to ${where} here.`,
    };
  }
  const where = input.onThatMac ? "this Mac" : (name ?? "that Mac");
  return {
    approveOn: computerUseApproveOn(where),
    detail: `Opensteer shows the approval on ${where} by itself.`,
  };
}

/** What a Mac's computer use block reads beyond the machine the snapshot carries. */
export interface ComputerUseData {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly setupRequests: readonly ComputerAppSetupRequest[];
}

export async function loadComputerUseData(
  hostClient: Pick<HostClient, "rpc">,
): Promise<ComputerUseData> {
  const [dashboard, platform, setup] = await Promise.all([
    hostClient.rpc["integrations.get"]({}).then(unwrapRpcResult),
    hostClient.rpc["integration.platform.get"]({}).then(unwrapRpcResult),
    hostClient.rpc["integration.computer.setup.list"]({}).then(unwrapRpcResult),
  ]);
  return {
    connections: dashboard.connections,
    definitions: platform.catalog.map(({ definition }) => definition),
    setupRequests: setup.requests,
  };
}

/**
 * Turning automatic approval off only narrows what agents may do, so the owner
 * can do it from anywhere and nothing asks the Mac. The policy is part of the
 * Mac's summary, so the snapshot is refreshed to show it.
 */
export async function askForEachComputerUseApp(
  hostClient: Pick<HostClient, "dispatch" | "refresh">,
  runnerId: string,
): Promise<void> {
  const result = await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`computer-use:policy:${runnerId}`),
    input: { appApproval: "ask", runnerId },
    type: "integration.computer.policy.set",
  });
  if (result.type !== "integration.computer.policy.set") {
    throw new Error("App approvals did not change.");
  }
  await hostClient.refresh();
}

/** Remove under Ask for each app, Block under automatic; see `computerUseTakeBack`. */
export async function takeBackComputerUseApp(
  hostClient: Pick<HostClient, "dispatch">,
  input: { readonly appApproval: ComputerUseAppApproval; readonly connectionId: string },
): Promise<void> {
  const { connectionId } = input;
  const result =
    input.appApproval === "automatic"
      ? await hostClient.dispatch({
          connectionId,
          idempotencyKey: mutationIdempotencyKey(`computer-use:block:${connectionId}`),
          type: "integration.computer.app.block",
        })
      : await hostClient.dispatch({
          connectionId,
          idempotencyKey: mutationIdempotencyKey(`computer-use:remove:${connectionId}`),
          type: "integration.disconnect",
        });
  if (
    result.type !== "integration.computer.app.block" &&
    result.type !== "integration.disconnect"
  ) {
    throw new Error("The app was not changed.");
  }
}

/** Declines a task's pending app, or cancels one the owner started. */
export async function cancelComputerUseSetup(
  hostClient: Pick<HostClient, "dispatch">,
  requestId: string,
): Promise<void> {
  await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`computer-use:cancel:${requestId}`),
    requestId,
    type: "integration.computer.setup.cancel",
  });
}

export async function stopComputerUseSession(
  hostClient: Pick<HostClient, "rpc">,
  sessionId: ComputerUseSessionSummary["sessionId"],
  signal?: AbortSignal,
): Promise<void> {
  await hostClient.rpc["integration.computer.session.stop"](
    { sessionId },
    signal ? { signal } : undefined,
  ).then(unwrapRpcResult);
}

/** One owner-visible computer session that can show a live picture. */
export interface WatchableComputerSession {
  readonly machine: MachineSummary;
  readonly session: ComputerUseSessionSummary;
}

/**
 * Whether a computer can show a live picture of its sessions now. Only its
 * owner is shown its sessions, so this asks nothing about who is reading.
 * Macs capture an app window; phones capture their whole display.
 */
export function canWatchComputer(machine: MachineSummary): boolean {
  return machine.status === "online" && machine.computerUse?.displayStreamSupported === true;
}

/**
 * Whether web and desktop can show a phone's display live. They watch phones
 * only this way; a phone whose app predates the stream is asked to update.
 * Every client uses this transport for phones.
 */
export function canStreamComputerDisplay(machine: MachineSummary): boolean {
  return canWatchComputer(machine) && machine.computerUse?.displayStreamSupported === true;
}

/**
 * A Thread's computer use that can be watched now, newest first. The Host ends
 * a Run's sessions when the Run ends, so a session naming this Thread is its
 * work in progress, whichever of its Runs holds it.
 */
export function threadComputerSessions(input: {
  readonly hostConnected: boolean;
  readonly machines: readonly MachineSummary[];
  readonly threadId: string | null;
}): WatchableComputerSession[] {
  if (!input.hostConnected || input.threadId === null) return [];
  return input.machines
    .filter(canWatchComputer)
    .flatMap((machine) =>
      (machine.computerUse?.sessions ?? [])
        .filter((session) => session.threadId === input.threadId)
        .map((session) => ({ machine, session })),
    )
    .sort((left, right) => right.session.openedAt.localeCompare(left.session.openedAt));
}

/**
 * A live turn at work on one of the reader's computers, and the session its Stop
 * ends. The turn's status line says it — what the agent is doing, then where —
 * in place of "Working", so it is read where the reply is being written and
 * never beside the composer, whose Stop ends the whole reply.
 *
 * It needs the session as well as the step. The Host shows a Mac's sessions
 * to its owner alone, who is the one the agent acts for there and the only
 * one who can stop it; everyone else reads the turn's ordinary status. And a
 * session that has ended — stopped, swept, its Mac gone — takes the line with
 * it at once, while the step that last happened there still stands in the
 * transcript.
 */
interface ComputerUseNowBase {
  /** What the agent is doing there now: `Typing in Notes`, `Using Notes`. */
  readonly action: string;
  /** Where, and what else it holds there: `On Mac mini · also using Calendar`. */
  readonly place: string;
  readonly machine: MachineSummary;
  readonly session: ComputerUseSessionSummary;
}

export type ComputerUseNow = ComputerUseNowBase &
  ({ readonly kind: "app"; readonly app: string } | { readonly kind: "phone" });

export function computerUseNow(
  turn: Turn,
  machines: readonly MachineSummary[],
): ComputerUseNow | null {
  const at = turnComputer(turn);
  if (at === null) return null;
  const machine = machines.find(({ id }) => id === at.runnerId);
  // An offline computer's last report is not a session anybody can see or stop.
  const session =
    machine?.status === "online"
      ? machine.computerUse?.sessions.find(({ runId }) => runId === turn.runId)
      : undefined;
  if (!machine || !session) return null;
  if (at.kind === "phone") {
    return {
      action: at.action,
      kind: "phone",
      machine,
      place: `On ${machine.name}`,
      session,
    };
  }
  const current = computerAppIdentityKey({
    bundleId: at.bundleId,
    displayName: at.app,
    teamId: null,
  });
  const others = session.apps.filter((app) => computerAppIdentityKey(app) !== current);
  return {
    action: at.action,
    app: at.app,
    kind: "app",
    machine,
    place: `On ${machine.name}${others.length > 0 ? ` · also using ${computerUseAppsPhrase(others)}` : ""}`,
    session,
  };
}

/**
 * The same, for a Thread's transcript as a whole: its latest turn is the only
 * one that can be live. The jump button asks it while the reader is scrolled
 * away from the line, because that is where the Stop is.
 */
export function threadComputerUseNow(
  groups: readonly TranscriptGroup[],
  machines: readonly MachineSummary[],
): ComputerUseNow | null {
  const latest = groups.findLast((group) => group.kind === "turn");
  return latest?.kind === "turn" ? computerUseNow(latest.turn, machines) : null;
}

/**
 * `Using Notes on Mac mini`: the jump button's words while the line is out of
 * view — the app, not each step, so a floating button holds its size.
 */
export function computerUseNowSummary(now: ComputerUseNow): string {
  return now.kind === "phone"
    ? `Using ${now.machine.name}`
    : `Using ${now.app} on ${now.machine.name}`;
}

/**
 * The line's one control. It ends this Run's use of that Mac and nothing
 * else: the reply carries on without it, which is what sets it apart from
 * the composer's Stop.
 */
export const computerUseStop = { busyLabel: "Stopping…", label: "Stop using Mac" } as const;

/**
 * The Stop's spoken name: its visible words, then which Mac, so a person
 * saying what they see can press it and a listener hears where it acts.
 */
export function computerUseStopLabel(machineName: string): string {
  return `${computerUseStop.label}, ${machineName}`;
}
