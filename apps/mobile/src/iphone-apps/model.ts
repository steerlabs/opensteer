import {
  computerAppAccessLabel,
  type IntegrationAccess,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/client/integrations";
import type {
  IphoneAppId,
  IphoneAppsApproval,
  IphoneAppsConnection,
  IphoneAppsSnapshot,
  IphonePermission,
} from "../platform/iphone-apps.js";
import {
  iphonePermissionAllows,
  type IphoneAddFailure,
  type IphoneAllowOutcome,
  type IphoneAnswerOutcome,
  type IphoneAppChange,
} from "./controller.js";

/*
 * This iPhone's apps in the words the person reads.
 *
 * Two things are always named apart: the access Opensteer gives agents
 * ("Can read", "Can read and change") and what iPhone Settings lets Opensteer
 * do. Neither is ever called a "permission", and no word here names how the
 * iPhone is wired to its Deployment.
 */

/** The apps an iPhone can share, in the order they are listed. */
export const iphoneAppIds: readonly IphoneAppId[] = [
  "apple-calendar",
  "apple-contacts",
  "apple-reminders",
  "iphone-location",
  "iphone-photos",
];

/** What one app lets agents do at one access. */
interface IphoneAppActions {
  /** Completes "Agents working in {Opensteer} can …". */
  readonly phrase: string;
  /** The access level's second line and screen reader hint. */
  readonly summary: string;
}

/** Everything that differs between an iPhone's apps, in one place. */
interface IphoneAppTraits {
  readonly name: string;
  readonly read: IphoneAppActions;
  /** Null when agents can only read it, so it never offers more. */
  readonly readWrite: IphoneAppActions | null;
  /** What only the wider access adds, said when it is taken away. */
  readonly writes: string | null;
  /** The verb a request uses: "Let agents {verb} {name}?" */
  readonly verb: { readonly read: string; readonly readWrite: string };
  /** iPhone Settings' word for enough access. */
  readonly granted: string;
  /** Limited access when it is enough, and the picker that widens it; null when it isn't enough. */
  readonly limited: {
    readonly choose: { readonly label: string; readonly picker: "contacts" | "photos" };
    readonly detail: string;
    readonly label: string;
    readonly summary: string;
  } | null;
  /** Said when iOS reads as never asked although agents have access. */
  readonly notAsked: string | null;
  /** The option to allow for Opensteer in iPhone Settings. */
  readonly settings: string;
  /** Said with every review of turning it on, because it limits what agents get. */
  readonly caveat: string | null;
}

const iphoneAppTraits: Readonly<Record<IphoneAppId, IphoneAppTraits>> = {
  "apple-calendar": {
    caveat: null,
    granted: "Full Access",
    limited: null,
    name: "Calendar",
    notAsked: null,
    read: { phrase: "see your calendars and events", summary: "See calendars and events" },
    readWrite: {
      phrase: "see your calendars and events, and add, change or delete events",
      summary: "See events, and add, change or delete them",
    },
    settings: "Full Access",
    verb: { read: "see", readWrite: "see and change" },
    writes: "add, change or delete events",
  },
  "apple-contacts": {
    caveat: null,
    granted: "Full access",
    limited: {
      choose: { label: "Choose contacts", picker: "contacts" },
      detail: "Agents can find only the contacts you chose.",
      label: "Only contacts you chose",
      summary: "Agents can find only the contacts you chose in Contacts.",
    },
    name: "Contacts",
    notAsked: null,
    read: {
      phrase:
        "search your contacts' names, organizations, email addresses, phone numbers and birthdays",
      summary: "Find people. Agents can't change contacts.",
    },
    readWrite: null,
    settings: "access",
    verb: { read: "find people in", readWrite: "find people in" },
    writes: null,
  },
  "apple-reminders": {
    caveat: null,
    granted: "Full Access",
    limited: null,
    name: "Reminders",
    notAsked: null,
    read: {
      phrase: "see your reminder lists and reminders",
      summary: "See reminder lists and reminders",
    },
    readWrite: {
      phrase: "see your reminder lists and reminders, and add, change, complete or delete them",
      summary: "See reminders, and add, change, complete or delete them",
    },
    settings: "Full Access",
    verb: { read: "see", readWrite: "see and change" },
    writes: "add, change, complete or delete reminders",
  },
  "iphone-location": {
    // iOS reports Allow Once and While Using the same way, so both are said.
    caveat:
      "If you allow it only once, that ends a while after you leave Opensteer, and agents can't get your location until you allow it here again. With Precise Location off, agents get an approximate area.",
    granted: "Allowed",
    // Location has no limited access; iOS's limited state is never enough.
    limited: null,
    name: "Location",
    notAsked: "If you allowed it only once, that has ended.",
    read: {
      phrase: "get your current location, one reading at a time with its accuracy,",
      summary: "Get the current location. No history or tracking.",
    },
    readWrite: null,
    settings: "While Using the App",
    verb: { read: "use", readWrite: "use" },
    writes: null,
  },
  "iphone-photos": {
    caveat:
      "iPhone asks about your whole photo library. Agents get only read-only details, never the photos themselves or where they were taken. To send a photo, attach it in a chat.",
    granted: "Full Access",
    limited: {
      choose: { label: "Choose photos", picker: "photos" },
      detail: "Agents see details only of the photos you chose, and none until you choose some.",
      label: "Only photos you chose",
      summary: "Agents can see details only of the photos you chose.",
    },
    name: "Photos",
    notAsked: null,
    read: {
      phrase:
        "see the dates, sizes, types and favorites of your photos and videos, and your album names,",
      summary: "See photo details, never the photos",
    },
    readWrite: null,
    settings: "Full Access or Limited Access",
    verb: { read: "see details in", readWrite: "see details in" },
    writes: null,
  },
};

export function isIphoneAppId(definitionId: string): definitionId is IphoneAppId {
  return iphoneAppIds.some((id) => id === definitionId);
}

/** The catalog's name for an app, which is the name the person knows it by. */
export function iphoneAppName(
  app: IphoneAppId,
  definitions: readonly Pick<IntegrationDefinitionSummaryView, "id" | "name">[] = [],
): string {
  return definitions.find(({ id }) => id === app)?.name ?? iphoneAppTraits[app].name;
}

/** `{Opensteer}`: the Deployment by the name its row has, as Agent Phone says it. */
export function opensteerOn(deploymentName: string): string {
  return `Opensteer on ${deploymentName}`;
}

/* ------------------------------------------------------------------------- *
 * Adding
 * ------------------------------------------------------------------------- */

export function addIphoneIntro(opensteer: string): string {
  return `Agents in ${opensteer} can use the apps you turn on, while Opensteer is open on this iPhone.`;
}

export const addIphoneNameHint = "This is how it's listed on Computers.";

/**
 * Said under the apps Add will turn on, because the tap on Add is the one
 * review they get: where what agents see goes, who can use it, and that
 * nothing else on the iPhone is reachable.
 */
export function addIphoneFootnote(opensteer: string): string {
  return `What agents see goes to ${opensteer} and the AI service the task uses. Tasks in Main can use these apps; a specialist needs your approval first. Nothing else on this iPhone is shared: not other apps, files, messages or the screen.`;
}

/** Add's label says how many apps it turns on, since switching them is only a draft until then. */
export function addIphoneButton(name: string, apps: number): string {
  const iphone = name === "" ? "this iPhone" : name;
  if (apps === 0) return `Add ${iphone}`;
  return `Add & share ${apps} ${apps === 1 ? "app" : "apps"}`;
}

/** The apps Add turns on unless the person switches them off: all but Photos, at their widest. */
export function addIphoneDraft(app: IphoneAppId): IntegrationAccess | null {
  return app === "iphone-photos" ? null : iphoneDefaultAccess(app, null);
}

export function addIphoneNeedsUpdate(opensteer: string): string {
  return `Update ${opensteer} to add this iPhone.`;
}

export function addIphoneFailureText(failure: IphoneAddFailure, opensteer: string): string {
  switch (failure.kind) {
    case "remote-access-off":
      return `Turn on remote access on ${opensteer} first, then try again.`;
    case "host-unreachable":
      return `This iPhone can't reach ${opensteer}. Check your connection and try again.`;
    case "host-mismatch":
      return "That address now belongs to a different Opensteer, so this iPhone didn't connect. Try again later.";
    case "too-long":
      return "Adding this iPhone took too long. Try again.";
    case "needs-update":
      return "Update Opensteer on this iPhone, then try again.";
    case "profile-mismatch":
      return "This iPhone couldn't be added. Remove it from Computers on another device, then add it again.";
    case "host-update":
      return addIphoneNeedsUpdate(opensteer);
    case "enrolled-elsewhere":
      return "This iPhone is already added to another Opensteer. Remove it there first.";
    case "host-said":
      return failure.message;
    case "failed":
      return "This iPhone wasn't added. Try again.";
  }
}

/* ------------------------------------------------------------------------- *
 * This iPhone's Computer page
 * ------------------------------------------------------------------------- */

export type IphoneTone = "amber" | "green" | "muted";

export interface IphoneStatusLine {
  readonly text: string;
  readonly tone: IphoneTone;
}

export function iphoneStatusLine(
  snapshot: IphoneAppsSnapshot,
  opensteer: string,
): IphoneStatusLine {
  switch (snapshot.issue) {
    case "remote-access-off":
      return { text: `${opensteer} has remote access turned off`, tone: "amber" };
    case "needs-update":
      return { text: "Update Opensteer on this iPhone", tone: "amber" };
    case "protocol-error":
      return { text: `Update Opensteer here and on ${opensteer}, then reopen it`, tone: "amber" };
    case "host-unreachable":
      return { text: `Can't reach ${opensteer} · Trying again`, tone: "amber" };
    case "host-mismatch":
      return {
        text: "That address now belongs to a different Opensteer, so this iPhone didn't connect.",
        tone: "amber",
      };
    case "profile-mismatch":
      return {
        text: "This iPhone couldn't be added. Remove it from Computers on another device, then add it again.",
        tone: "amber",
      };
    case "enrollment-expired":
    case "enrollment-refused":
    case "failed":
    case "removed":
    case null:
      break;
  }
  if (snapshot.issueMessage !== null) return { text: snapshot.issueMessage, tone: "amber" };
  switch (snapshot.connection) {
    case "online":
      return { text: "Online · Agents can use its apps while Opensteer is open", tone: "green" };
    case "connecting":
      return { text: `Connecting to ${opensteer}…`, tone: "amber" };
    case "retrying":
      return { text: `Can't reach ${opensteer} · Trying again`, tone: "amber" };
    case "background":
    case "none":
    case "stopped":
      return { text: `Not connected to ${opensteer}`, tone: "muted" };
  }
}

export const iphoneAppsFooter =
  "Agents can use these apps only while Opensteer is open on this iPhone. They can't use anything else on it.";

/** What iPhone Settings needs changed for one app, under its row. */
export type IphoneRemedy =
  | { readonly kind: "settings"; readonly detail: string; readonly title: string }
  | { readonly kind: "ask"; readonly detail: string; readonly title: string }
  | {
      readonly kind: "limited";
      readonly choose: { readonly label: string; readonly picker: "contacts" | "photos" };
      readonly detail: string;
    }
  | { readonly kind: "restricted"; readonly detail: string };

/**
 * Whether agents can use an app right now, which is never one fact alone: the
 * access Opensteer gives agents, what iPhone Settings lets Opensteer do, and
 * whether this iPhone is connected all have to allow it.
 */
export type IphoneEffect = "blocked" | "off" | "on" | "paused" | "unavailable";

/**
 * The control at the end of an app's row. A switch is on while agents have the
 * app or it is being turned on; it can't change while a change is under way.
 * An app iPhone Settings refuses offers Settings instead, since switching it
 * on could only fail.
 */
export type IphoneRowControl =
  | { readonly kind: "switch"; readonly on: boolean; readonly changeable: boolean }
  | { readonly kind: "settings" };

export interface IphoneAppRowView {
  readonly app: IphoneAppId;
  readonly name: string;
  /** The access agents have now, as Opensteer holds it, or null while the app is off. */
  readonly access: IntegrationAccess | null;
  /** Access being added from here, beside the current access, and its label. */
  readonly change: IphoneAppChange | null;
  readonly changeLabel: string | null;
  readonly control: IphoneRowControl;
  readonly effect: IphoneEffect;
  /** Whether more access can be asked for here, which needs both the Host and this build. */
  readonly offered: boolean;
  /** The row's second line: what limits it when something does, else what agents can do. */
  readonly line: string;
  readonly remedy: IphoneRemedy | null;
  readonly tone: IphoneTone;
}

/**
 * One app on this iPhone. It can be turned on only when both the Host lists
 * its definition and this build of Opensteer reports its permission; either
 * missing is said, and nothing asks iOS for it.
 */
export function iphoneAppRow(input: {
  readonly access: IntegrationAccess | null;
  readonly app: IphoneAppId;
  readonly change: IphoneAppChange | null;
  readonly connection: IphoneAppsConnection;
  /** The Host's definition, or null when the Host doesn't list it. */
  readonly definition: IntegrationDefinitionSummaryView | null;
  readonly locationAccuracy: "approximate" | "precise" | null;
  readonly opensteer: string;
  /** What iOS lets Opensteer do, or null when this build doesn't offer the app. */
  readonly permission: IphonePermission | null;
  /** Waiting its turn behind another app being turned on from Add. */
  readonly queued: boolean;
}): IphoneAppRowView {
  const traits = iphoneAppTraits[input.app];
  const name = input.definition?.name ?? traits.name;
  const accessLabel =
    input.access === null ? "Off" : iphoneLevelLabel(input.definition, input.access);
  const offered = input.definition !== null && input.permission !== null;
  const settling = input.change !== null && input.change.phase !== "unknown";
  // Less access needs only the Host, so an app that is on can always be
  // turned off; more needs this iPhone, so nothing is turned on mid-change.
  const control: IphoneRowControl = {
    changeable:
      input.access !== null ? !settling : offered && input.change === null && !input.queued,
    kind: "switch",
    on: input.access !== null || settling || input.queued,
  };
  const base = {
    access: input.access,
    app: input.app,
    change: input.change,
    changeLabel:
      input.change === null ? null : iphoneLevelLabel(input.definition, input.change.access),
    control,
    name,
    offered,
  };
  if (!offered) {
    // The iPhone's build is said first: it is the one fixed on this phone.
    const why =
      input.permission === null
        ? "Update Opensteer on this iPhone"
        : `${input.opensteer} doesn't offer it yet`;
    return {
      ...base,
      effect: "unavailable",
      line: input.access === null ? why : `${accessLabel} · ${why}`,
      remedy: null,
      tone: input.access === null ? "muted" : "amber",
    };
  }
  const permission = input.permission;
  const progress =
    input.change === null
      ? input.queued
        ? "Up next"
        : null
      : input.change.phase === "unknown"
        ? "Change not verified"
        : input.change.phase === "asking-iphone"
          ? "Waiting for iPhone…"
          : input.access === null
            ? "Turning on…"
            : `Adding ${lowerFirst(iphoneLevelLabel(input.definition, input.change.access))}…`;
  const withProgress = (line: string) => (progress === null ? line : `${line} · ${progress}`);
  const readiness_ = readiness(input.app, permission);
  if (input.access === null) {
    if (progress !== null) {
      return { ...base, effect: "off", line: progress, remedy: null, tone: "muted" };
    }
    // Switching on could only fail here, so the row says why and offers the fix.
    if (readiness_ === "restricted") {
      return {
        ...base,
        control: { changeable: false, kind: "switch", on: false },
        effect: "off",
        line: "Blocked by Screen Time",
        remedy: null,
        tone: "muted",
      };
    }
    if (readiness_ === "off" && !(input.app === "apple-calendar" && permission === "write-only")) {
      return {
        ...base,
        control: { kind: "settings" },
        effect: "off",
        line: "Off in iPhone Settings",
        remedy: null,
        tone: "amber",
      };
    }
    return {
      ...base,
      effect: "off",
      line: actionsFor(input.app, iphoneDefaultAccess(input.app, input.definition)).summary,
      remedy: null,
      tone: "muted",
    };
  }
  const restricted = `Screen Time or a device policy keeps Opensteer from using ${name} on this iPhone.`;
  // iPhone Settings is said first when it blocks, because only it can be fixed here.
  if (readiness_ !== "ready" && readiness_ !== "limited") {
    const why =
      readiness_ === "restricted"
        ? "Blocked by Screen Time"
        : readiness_ === "not-asked"
          ? "iPhone hasn't asked yet"
          : "Not allowed in iPhone Settings";
    return {
      ...base,
      effect: "blocked",
      line: withProgress(`${accessLabel} · ${why}`),
      remedy:
        readiness_ === "restricted"
          ? { detail: restricted, kind: "restricted" }
          : readiness_ === "not-asked"
            ? {
                detail: [
                  `iPhone will ask you whether Opensteer can use ${name}.`,
                  ...(traits.notAsked === null ? [] : [traits.notAsked]),
                ].join(" "),
                kind: "ask",
                title: `Allow ${name} on this iPhone`,
              }
            : {
                detail: `iPhone Settings doesn't let Opensteer use ${name}, so agents can't use it now. In Settings, allow ${traits.settings} for Opensteer.`,
                kind: "settings",
                title: `Allow ${name} in iPhone Settings`,
              },
      tone: "amber",
    };
  }
  if (input.connection !== "online") {
    return {
      ...base,
      effect: "paused",
      line: withProgress(`Paused · ${accessLabel}`),
      remedy: null,
      tone: "muted",
    };
  }
  const limited = readiness_ === "limited" ? traits.limited : null;
  const approximate = input.app === "iphone-location" && input.locationAccuracy === "approximate";
  const limit = limited?.label ?? (approximate ? "Approximate" : null);
  return {
    ...base,
    effect: "on",
    line: withProgress(`${accessLabel}${limit === null ? "" : ` · ${limit}`}`),
    remedy:
      limited === null ? null : { choose: limited.choose, detail: limited.detail, kind: "limited" },
    tone: "green",
  };
}

/** What iPhone Settings lets Opensteer do with one app, as Settings words it. */
export function iphonePermissionLabel(
  app: IphoneAppId,
  permission: IphonePermission,
  locationAccuracy: "approximate" | "precise" | null = null,
): string {
  const traits = iphoneAppTraits[app];
  switch (permission) {
    case "granted":
      return app === "iphone-location" && locationAccuracy !== null
        ? `${traits.granted} · ${locationAccuracy === "precise" ? "Precise" : "Approximate"}`
        : traits.granted;
    case "limited":
      return traits.limited?.label ?? "Not enough to read";
    case "write-only":
      return "Add events only, which isn't enough to read";
    case "denied":
      return "Not allowed";
    case "restricted":
      return "Blocked by Screen Time or a device policy";
    case "not-determined":
      return "Not asked yet";
  }
}

/**
 * Whether iPhone Settings lets Opensteer give agents this access. Calendar's
 * add-only access is not enough for anything agents do, since every change
 * starts by reading; limited access is enough only for apps that have it.
 */
function readiness(
  app: IphoneAppId,
  permission: IphonePermission,
): "limited" | "not-asked" | "off" | "ready" | "restricted" {
  switch (permission) {
    case "granted":
      return "ready";
    case "limited":
      return iphonePermissionAllows(app, permission) ? "limited" : "off";
    case "restricted":
      return "restricted";
    case "not-determined":
      return "not-asked";
    case "denied":
    case "write-only":
      return "off";
  }
}

/** One access level in an app's menu, and what choosing it does from here. */
export interface IphoneLevel {
  readonly access: IntegrationAccess;
  readonly action: "allow" | "current" | "lower";
  readonly label: string;
}

/** The access levels an app offers, in order, honouring a read-only app whatever its definition says. */
function levelsOf(
  app: IphoneAppId,
  definition: IntegrationDefinitionSummaryView | null,
): readonly IntegrationAccess[] {
  const levels = (definition?.computerApp?.accessLevels ?? ["read", "read-write"]).filter(
    (access) => access === "read" || iphoneAppTraits[app].readWrite !== null,
  );
  return levels.length === 0 ? ["read"] : levels;
}

/** The access an app is turned on with: the widest it offers, chosen down from its menu. */
export function iphoneDefaultAccess(
  app: IphoneAppId,
  definition: IntegrationDefinitionSummaryView | null,
): IntegrationAccess {
  const levels = levelsOf(app, definition);
  return levels[levels.length - 1] ?? "read";
}

/**
 * The levels an app's menu offers, or none when there is nothing else to choose. On this
 * iPhone every level is offered; elsewhere only the current one and less,
 * since new or wider access is approved on the iPhone that holds the data.
 */
export function iphoneLevels(input: {
  readonly app: IphoneAppId;
  readonly current: IntegrationAccess;
  readonly definition: IntegrationDefinitionSummaryView | null;
  readonly here: boolean;
}): readonly IphoneLevel[] {
  const levels = levelsOf(input.app, input.definition).flatMap((access): IphoneLevel[] => {
    const action =
      access === input.current ? "current" : rank(access) < rank(input.current) ? "lower" : "allow";
    if (!input.here && action === "allow") return [];
    return [{ access, action, label: iphoneLevelLabel(input.definition, access) }];
  });
  // A menu holding only the current level offers nothing to choose.
  return levels.length < 2 ? [] : levels;
}

/** What one access lets agents do with one app. */
function actionsFor(app: IphoneAppId, access: IntegrationAccess): IphoneAppActions {
  const traits = iphoneAppTraits[app];
  return access === "read-write" ? (traits.readWrite ?? traits.read) : traits.read;
}

/** Access a connection holds: off, reading, or reading and changing. */
function rank(access: IntegrationAccess | null): number {
  return access === null ? 0 : access === "read" ? 1 : 2;
}

/** What an app shares at an access, for a row whose switch is off or a draft. */
export function iphoneAppSummary(app: IphoneAppId, access: IntegrationAccess): string {
  return actionsFor(app, access).summary;
}

/** The row's words after a change settled without the access it asked for. */
export function iphoneAllowFailure(
  outcome: IphoneAllowOutcome,
  name: string,
  opensteer: string,
): string | null {
  switch (outcome.kind) {
    case "allowed":
    case "busy":
    case "superseded":
    case "unknown":
      return null;
    case "blocked":
      return outcome.permission === "restricted"
        ? `Screen Time or a device policy keeps Opensteer from using ${name}, so it wasn't turned on.`
        : `iPhone Settings doesn't let Opensteer use ${name}, so it wasn't turned on.`;
    case "not-allowed":
      return outcome.message;
    case "not-offered":
      return outcome.by === "host"
        ? `${opensteer} doesn't offer ${name} yet, so nothing was asked. Update it, then try again.`
        : `This version of Opensteer on this iPhone doesn't offer ${name}, so nothing was asked. Update it, then try again.`;
    case "waiting":
      return "The request is waiting under Waiting for you. Approve it there once this iPhone is connected.";
  }
}

/** Why a task's request was not answered, when it is still waiting to be. */
export function iphoneAnswerFailure(outcome: IphoneAnswerOutcome, name: string): string | null {
  switch (outcome.kind) {
    case "allowed":
    case "declined":
      return null;
    case "refused":
    case "unavailable":
      return outcome.message;
    case "blocked":
      return outcome.permission === "restricted"
        ? `Screen Time or a device policy keeps Opensteer from using ${name}. The request is still waiting.`
        : `iPhone Settings doesn't let Opensteer use ${name}, so it wasn't allowed. Allow it in Settings, or don't allow the request.`;
    case "not-offered":
      return outcome.by === "host"
        ? `Opensteer on this Deployment no longer offers ${name}. Update it or decline this request.`
        : `This version of Opensteer on this iPhone doesn't offer ${name}. Update it to answer; the request is still waiting.`;
    case "unknown":
      return "Opensteer may or may not have this answer. This page shows it once Opensteer can be reached.";
  }
}

/** What allowing a task's request lasts for, in the Workspaces' own terms. */
export const iphoneTaskScope =
  "Allowing lasts until you change it, not only for this task. The Workspace that asked can use it; other specialists still need your approval.";

/** An unknown change, in its sheet and under its row. */
export function iphoneUnknownChange(name: string, label: string): string {
  return `Opensteer may or may not have ${label} for ${name}. Checking reads it again; nothing is asked twice.`;
}

export function iphoneDisclosure(opensteer: string): string {
  return `What agents see is sent to ${opensteer} and to the AI service the task uses.`;
}

/** A task's ask, as its card and the prompt title it. */
export function iphoneApprovalTitle(approval: IphoneAppsApproval, name: string): string {
  const { verb: verbs } = iphoneAppTraits[approval.definitionId];
  const verb = approval.access === "read-write" ? verbs.readWrite : verbs.read;
  const who = approval.threadTitle === null ? "agents" : `“${approval.threadTitle}”`;
  return `Let ${who} ${verb} ${name}?`;
}

/** The ask's context, then what limits what agents get, before Allow can make iOS ask. */
export function iphoneApprovalLines(approval: IphoneAppsApproval): readonly string[] {
  const { caveat } = iphoneAppTraits[approval.definitionId];
  return [
    ...(approval.workspaceName === null ? [] : [approval.workspaceName]),
    ...(approval.reason === null ? [] : [`Reason: ${approval.reason}`]),
    ...(caveat === null ? [] : [caveat]),
  ];
}

export function iphoneRemoveTitle(name: string, opensteer: string): string {
  return `Remove ${name} from ${opensteer}?`;
}

export const iphoneRemoveMessage = "Agents will stop using its apps. You can add it again later.";

export function iphoneNotTold(
  name: string,
  opensteer: string,
): {
  readonly detail: string;
  readonly title: string;
} {
  return {
    detail: `${name} stopped sharing, but ${opensteer} couldn't be told. Remove it from Computers on another device.`,
    title: `Finish removing ${name}`,
  };
}

export const iphoneApprovalKeyFailure = "This iPhone couldn't finish setting up approvals.";

/* ------------------------------------------------------------------------- */

/** An access level's name, as the Host's definition words it when there is one. */
export function iphoneLevelLabel(
  definition: IntegrationDefinitionSummaryView | null,
  access: IntegrationAccess,
): string {
  const presentation = definition?.computerApp;
  if (presentation !== undefined) return computerAppAccessLabel(presentation, access);
  return access === "read-write" ? "Can read and change" : "Can read";
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toLocaleLowerCase()}${value.slice(1)}`;
}
