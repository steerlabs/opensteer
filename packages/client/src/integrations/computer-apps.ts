import type {
  ComputerAppPlatformView,
  ComputerAppPresentationView,
  ComputerAppSetupRequest,
  IntegrationAccess,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core";
import { computerAppUsesSessions } from "@opensteer/integration-core";
import type {
  ComputerAppRemedy,
  MachineAppStatus,
  MachineDevice,
  MachineSummary,
} from "@opensteer/protocol";
import { androidAccessibilityStep, isAndroidPhone } from "./computer-use.js";

/**
 * Apps on a computer, as every client surface reasons about them.
 *
 * This module is deliberately presentation-framework free. It joins the two
 * facts the Host publishes — a person's connections and each computer's live
 * report — so web and native clients cannot disagree about which computer an
 * app belongs to or whether it is available.
 */

export type ComputerAppLiveState =
  | { readonly kind: "checking" }
  | { readonly kind: "offline" }
  | { readonly detail?: string; readonly kind: "ready" }
  | {
      readonly detail: string;
      readonly kind: "permission-required";
      readonly remedy: ComputerAppRemedy | null;
    }
  | { readonly detail: string; readonly kind: "unavailable" };

export type ComputerAppRowState = { readonly kind: "off" } | ComputerAppLiveState;

export interface ComputerAppRow {
  readonly access: IntegrationAccess | null;
  readonly connectionId: string | null;
  readonly definition: IntegrationDefinitionSummaryView;
  readonly presentation: ComputerAppPresentationView;
  readonly state: ComputerAppRowState;
  readonly readState: ComputerAppLiveState;
  readonly writeState: ComputerAppLiveState;
  readonly summary: string;
}

/** Definitions that are apps on a computer, in stable display order. */
export function computerAppDefinitions(
  definitions: readonly IntegrationDefinitionSummaryView[],
): readonly IntegrationDefinitionSummaryView[] {
  // Computer apps operated in sessions — a Mac's apps, one connection per
  // approved app, and a phone's whole screen — are not on/off rows, so each
  // has its own projection in `computer-use.ts`.
  return definitions
    .filter(
      (definition) =>
        definition.computerApp !== undefined && !computerAppUsesSessions(definition.computerApp),
    )
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The live app connections one person owns on one computer. */
export function computerConnectionsOn(
  connections: readonly IntegrationConnectionSummary[],
  machineId: string,
): readonly IntegrationConnectionSummary[] {
  return connections.filter(
    (connection) => connection.status !== "revoked" && connection.computer?.runnerId === machineId,
  );
}

/**
 * One row per app this computer has on or is offering.
 *
 * A connected app remains a row while its computer is away. An app that is off
 * is offered only while the computer is online and reports that exact
 * definition. Unknown reported definitions are ignored.
 */
export function computerAppRows(input: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definitions: readonly IntegrationDefinitionSummaryView[];
  readonly machine: MachineSummary;
  readonly setupRequests?: readonly ComputerAppSetupRequest[];
}): readonly ComputerAppRow[] {
  const { machine } = input;
  const online = machine.status === "online";
  const connected = computerConnectionsOn(input.connections, machine.id);
  return computerAppDefinitions(input.definitions).flatMap((definition) => {
    const presentation = definition.computerApp;
    if (!presentation) return [];
    const connection = connected.find(({ definitionId }) => definitionId === definition.id) ?? null;
    const entry = machine.apps?.find(({ definitionId }) => definitionId === definition.id) ?? null;
    const pending = input.setupRequests?.some(
      (request) => request.runnerId === machine.id && request.definitionId === definition.id,
    );
    if (!connection && !(online && entry) && !pending) return [];
    const access = connection?.computer?.access ?? null;
    const phone = isAndroidPhone(machine);
    return [
      {
        access,
        connectionId: connection?.id ?? null,
        definition,
        presentation,
        state:
          access === null
            ? ({ kind: "off" } as const)
            : computerAppLiveState({
                access,
                presentation,
                apps: machine.apps,
                entry,
                integrationsAdvertised: machine.modules.integrations !== undefined,
                name: definition.name,
                online,
                phone,
              }),
        readState: computerAppLiveState({
          access: "read",
          presentation,
          apps: machine.apps,
          entry,
          integrationsAdvertised: machine.modules.integrations !== undefined,
          name: definition.name,
          online,
          phone,
        }),
        writeState: computerAppLiveState({
          access: "write",
          presentation,
          apps: machine.apps,
          entry,
          integrationsAdvertised: machine.modules.integrations !== undefined,
          name: definition.name,
          online,
          phone,
        }),
        summary:
          access === "read-write"
            ? presentation.accessSummaries.readWrite
            : presentation.accessSummaries.read,
      },
    ];
  });
}

function computerAppLiveState(input: {
  readonly access: IntegrationAccess | "write";
  readonly presentation: ComputerAppPresentationView;
  readonly apps: MachineSummary["apps"];
  readonly entry: MachineAppStatus | null;
  readonly integrationsAdvertised: boolean;
  readonly name: string;
  readonly online: boolean;
  /** An Android phone, whose remedies are never the macOS grants they share names with. */
  readonly phone: boolean;
}): ComputerAppLiveState {
  if (!input.online) return { kind: "offline" };
  if (!input.entry) {
    return input.integrationsAdvertised && (input.apps === null || input.apps.length === 0)
      ? { kind: "checking" }
      : { detail: `${input.name} is not available.`, kind: "unavailable" };
  }
  const expected = input.presentation.operations.filter(
    (operation) => input.access === "read-write" || operation.effect === input.access,
  );
  const observations = expected.map((operation) =>
    input.entry?.operations.find((status) => status.operation === operation.name),
  );
  if (observations.length === 0 || observations.some((status) => !status)) {
    return { detail: `${input.name} has not reported its availability.`, kind: "unavailable" };
  }
  // The first blocked operation defines the next setup step. Ready reads remain
  // independently visible while sending still needs the person's approval.
  const status = observations.find((status) => status?.state !== "ready") ?? observations[0];
  if (!status) return { detail: `${input.name} is not available.`, kind: "unavailable" };
  const { detail, remedy, state } = status;
  if (state === "ready") return detail === null ? { kind: "ready" } : { detail, kind: "ready" };
  if (state === "permission-required") {
    // A phone has one setting of its own to ask for, its accessibility
    // service. Keeping its remedy would send the person to macOS directions
    // for a Mac they are not holding, so the phone's sentence stands alone.
    if (input.phone) {
      return {
        detail: detail ?? androidAccessibilityStep,
        kind: "permission-required",
        remedy: null,
      };
    }
    return {
      detail: detail ?? computerAppRemedyDetail(remedy, input.name),
      kind: "permission-required",
      remedy,
    };
  }
  return { detail: detail ?? `${input.name} is not available.`, kind: "unavailable" };
}

/**
 * The sentence for a remedy the computer named but did not describe. Each
 * names the macOS grant in the words macOS itself shows, because that is the
 * row a person has to find.
 */
function computerAppRemedyDetail(remedy: ComputerAppRemedy | null, name: string): string {
  switch (remedy) {
    case "full-disk-access":
      return `Protected data access for ${name} needs permission.`;
    case "automation":
      return `${name} needs permission.`;
    case "accessibility":
      return `Operating ${name} needs macOS Accessibility.`;
    case "screen-recording":
      return `Seeing ${name} needs macOS Screen Recording.`;
    case "contacts":
      return `Reading ${name} needs macOS access to Contacts.`;
    case "calendars":
      return `${name} needs macOS full access to calendars.`;
    case "reminders":
      return `${name} needs macOS full access to reminders.`;
    case null:
      return `${name} needs permission.`;
  }
}

export function computerAppAccessLabel(
  presentation: ComputerAppPresentationView,
  access: IntegrationAccess,
): string {
  return access === "read-write"
    ? presentation.accessLabels.readWrite
    : presentation.accessLabels.read;
}

export function computerOfflineLabel(machineName: string): string {
  return `${machineName} is offline`;
}

export const computerAppTurnOffConsequence =
  "Turning this off removes agents' access in every Workspace.";

/**
 * The durable human identity of a computer-app connection.
 *
 * The Runner id selects the current computer name. The stored display name is
 * the last known name when that computer no longer appears in the machine
 * list, rather than a claim about whichever device is displaying the row.
 */
export function computerAppConnectionLabel(input: {
  readonly connection: Pick<IntegrationConnectionSummary, "computer" | "displayName">;
  readonly definition: Pick<IntegrationDefinitionSummaryView, "computerApp" | "name">;
  readonly machines: readonly MachineSummary[];
}): string {
  const runnerId = input.connection.computer?.runnerId;
  const machine = input.machines.find((candidate) => candidate.id === runnerId);
  // Computer use has one connection per approved app, so the app names it, and
  // its stored display name already reads "<App> on <computer>".
  const app = input.connection.computer?.app;
  if (app) return machine ? `${app.displayName} on ${machine.name}` : input.connection.displayName;
  // A phone's connection is the whole phone, so the phone's name is all of it.
  if (input.definition.computerApp?.kind === "display") {
    return machine?.name ?? input.connection.displayName;
  }
  return `${input.definition.name} on ${machine?.name ?? input.connection.displayName}`;
}

export interface ComputerAppTarget {
  readonly connection: IntegrationConnectionSummary | null;
  readonly machine: MachineSummary;
  readonly state: ComputerAppLiveState;
}

/** Online computers reporting this exact app, including ones already connected. */
export function computerAppTargets(input: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly definition: IntegrationDefinitionSummaryView;
  readonly machines: readonly MachineSummary[];
}): readonly ComputerAppTarget[] {
  return input.machines.flatMap((machine) => {
    const entry =
      machine.apps?.find(({ definitionId }) => definitionId === input.definition.id) ?? null;
    if (machine.status !== "online" || !entry) return [];
    const connection =
      computerConnectionsOn(input.connections, machine.id).find(
        ({ definitionId }) => definitionId === input.definition.id,
      ) ?? null;
    return [
      {
        connection,
        machine,
        state: computerAppLiveState({
          access: connection?.computer?.access ?? "read",
          presentation: input.definition.computerApp!,
          apps: machine.apps,
          entry,
          integrationsAdvertised: machine.modules.integrations !== undefined,
          name: input.definition.name,
          online: true,
          phone: isAndroidPhone(machine),
        }),
      },
    ];
  });
}

/** Live state of an existing computer-app connection. */
export function computerConnectionState(input: {
  readonly connection: IntegrationConnectionSummary;
  readonly definition: IntegrationDefinitionSummaryView;
  readonly machines: readonly MachineSummary[];
}): ComputerAppLiveState {
  const machine =
    input.machines.find((candidate) => candidate.id === input.connection.computer?.runnerId) ??
    null;
  if (!machine) return { kind: "offline" };
  const presentation = input.definition.computerApp;
  if (!presentation) return { kind: "unavailable", detail: "Computer app is unavailable." };
  return computerAppLiveState({
    access: input.connection.computer?.access ?? "read",
    presentation,
    apps: machine.apps,
    entry: machine.apps?.find(({ definitionId }) => definitionId === input.definition.id) ?? null,
    integrationsAdvertised: machine.modules.integrations !== undefined,
    name: input.definition.name,
    online: machine.status === "online",
    phone: isAndroidPhone(machine),
  });
}

export function computerAppStateLabel(
  state: ComputerAppLiveState,
  /** The computer's platform: an iPhone has no macOS grant to name. */
  platform?: NonNullable<MachineDevice>["platform"],
): string {
  switch (state.kind) {
    case "checking":
      return "Checking…";
    case "offline":
      return "Offline";
    case "ready":
      return state.detail ?? "Ready";
    case "permission-required":
      if (platform === "ios") return state.detail;
      switch (state.remedy) {
        case "full-disk-access":
        case "accessibility":
        case "screen-recording":
        case "contacts":
        case "calendars":
        case "reminders":
          return "Needs macOS permission";
        case "automation":
        case null:
          return state.detail;
      }
    case "unavailable":
      return state.detail;
  }
}

export interface ComputerAppPermissionNotice {
  readonly detail: string;
  readonly title: string;
}

/**
 * Where a computer app's macOS permission is given, for a reader who is not
 * at that Mac. The notice names the grant: each app's is its own, given to
 * Opensteer Computer Use, never the Full Disk Access of whatever runs
 * Opensteer.
 */
export function computerAppSetupElsewhere(machineName: string): string {
  return `Complete setup on ${machineName}.`;
}

/**
 * Context for the system grants clients can name. The remedy is the authority:
 * app names and provider detail are never used to infer a system permission,
 * and a remedy with no context here shows the provider's own sentence alone
 * rather than directions to the wrong Settings pane.
 */
export function computerAppPermissionNotice(input: {
  readonly appName: string;
  readonly machineName: string;
  /** The computer's platform, which decides whose Settings hold the grant. */
  readonly platform?: NonNullable<MachineDevice>["platform"] | undefined;
  readonly state: ComputerAppLiveState;
}): ComputerAppPermissionNotice | null {
  if (input.state.kind !== "permission-required") return null;
  if (input.platform === "ios") {
    return iphonePermissionNotice({
      appName: input.appName,
      machineName: input.machineName,
      state: input.state,
    });
  }
  switch (input.state.remedy) {
    case "full-disk-access":
      return {
        detail: `${input.state.detail} Switching on Opensteer Computer Use in Full Disk Access lets it read ${input.appName} on ${input.machineName} for the agents you approve. It does not change the agent access selected for this app.`,
        title: `Reading ${input.appName} needs macOS Full Disk Access`,
      };
    case "screen-recording":
      return {
        detail: `${input.state.detail} macOS Screen Recording lets Opensteer Computer Use see ${input.appName} on ${input.machineName}. It does not change the agent access selected for this app.`,
        title: `Seeing ${input.appName} needs macOS Screen Recording`,
      };
    case "accessibility":
      return {
        detail: `${input.state.detail} macOS Accessibility lets Opensteer Computer Use operate ${input.appName} on ${input.machineName}. It does not change the agent access selected for this app.`,
        title: `Operating ${input.appName} needs macOS Accessibility`,
      };
    case "contacts":
      return {
        detail: `${input.state.detail} Allowing Opensteer Computer Use in Contacts lets it read contacts on ${input.machineName} for the agents you approve. It does not change the agent access selected for this app.`,
        title: `Reading ${input.appName} needs macOS Contacts access`,
      };
    case "calendars":
      return {
        detail: `${input.state.detail} Full access for Opensteer Computer Use in Calendars lets it read and change calendars on ${input.machineName} for the agents you approve. It does not change the agent access selected for this app.`,
        title: `${input.appName} needs macOS Calendars access`,
      };
    case "reminders":
      return {
        detail: `${input.state.detail} Full access for Opensteer Computer Use in Reminders lets it read and change reminders on ${input.machineName} for the agents you approve. It does not change the agent access selected for this app.`,
        title: `${input.appName} needs macOS Reminders access`,
      };
    case "automation":
      return {
        detail: `${input.state.detail} Allowing Opensteer Computer Use to control ${input.appName} lets it send on ${input.machineName} for the agents you approve. It does not change the agent access selected for this app.`,
        title: `Sending in ${input.appName} needs macOS Automation permission`,
      };
    case null:
      return null;
  }
}

/**
 * An iPhone asks for its data apps in iPhone Settings, and has none of the
 * Mac's other grants, so those keep the provider's own sentence.
 */
function iphonePermissionNotice(input: {
  readonly appName: string;
  readonly machineName: string;
  readonly state: Extract<ComputerAppLiveState, { readonly kind: "permission-required" }>;
}): ComputerAppPermissionNotice | null {
  switch (input.state.remedy) {
    case "contacts":
    case "calendars":
    case "reminders":
      return {
        detail: `${input.state.detail} Allow it in iPhone Settings on ${input.machineName}. It does not change the agent access selected for this app.`,
        title: `${input.appName} needs access on ${input.machineName}`,
      };
    case "accessibility":
    case "automation":
    case "full-disk-access":
    case "screen-recording":
    case null:
      return null;
  }
}

/**
 * An iPhone's app that is off, read from another device: only the iPhone can
 * turn it on, because new access is approved on the device that holds the data.
 */
export function iphoneAppOffElsewhere(iphoneName: string): string {
  return `Off · Turn it on in Opensteer on ${iphoneName}`;
}

/** A request for an iPhone's app, which only that iPhone answers. */
export function iphoneAppWaitingOn(iphoneName: string): string {
  return `Waiting for approval on ${iphoneName}`;
}

export interface IphoneAppStatus {
  readonly text: string;
  /** `on` only when agents can use the app now; never for an away iPhone. */
  readonly tone: "attention" | "idle" | "on";
}

/**
 * An iPhone's app, read from another device: whether agents can use it now
 * first, then the access it has. A request for more never hides the access it
 * already has, and an iPhone that is away reads as paused, not on.
 */
export function iphoneAppStatus(input: {
  readonly machineName: string;
  readonly request: Pick<ComputerAppSetupRequest, "access"> | null;
  readonly row: Pick<ComputerAppRow, "access" | "presentation" | "state">;
}): IphoneAppStatus {
  const { access } = input.row;
  if (access === null || input.row.state.kind === "off") {
    return {
      text:
        input.request === null
          ? iphoneAppOffElsewhere(input.machineName)
          : `Off · ${iphoneAppWaitingOn(input.machineName)}`,
      tone: "idle",
    };
  }
  const label = computerAppAccessLabel(input.row.presentation, access);
  const waiting =
    input.request === null
      ? ""
      : input.request.access === "read-write" && access === "read"
        ? " · More access waiting for approval"
        : " · Approval waiting";
  switch (input.row.state.kind) {
    case "ready":
      return { text: `On · ${label}${waiting}`, tone: "on" };
    case "offline":
      return {
        text: `Paused · ${label} · ${input.machineName} is offline${waiting}`,
        tone: "idle",
      };
    case "checking":
      return { text: `Checking · ${label}${waiting}`, tone: "idle" };
    case "permission-required":
      return {
        text: `Blocked · ${label} · ${input.row.state.remedy === null ? input.row.state.detail : "Not allowed in iPhone Settings"}${waiting}`,
        tone: "attention",
      };
    case "unavailable":
      return { text: `Unavailable · ${label}${waiting}`, tone: "attention" };
  }
}

/** Web's visual class; native clients use the state discriminant directly. */
export function computerAppStateDotClass(state: ComputerAppRowState): string {
  switch (state.kind) {
    case "ready":
      return "status-dot--running";
    case "permission-required":
      return "status-dot--pending";
    case "checking":
    case "off":
    case "offline":
    case "unavailable":
      return "status-dot--idle";
  }
}

/**
 * Whether the Apps block has an owned fact to show.
 *
 * The immutable module grant is deliberately irrelevant: every enrollment may
 * hold that grant even when its platform ships no computer-app provider. A live
 * report or an existing connection is positive evidence. Existing connections
 * keep the block visible while their computer is offline.
 */
export function ownsComputerApps(input: {
  readonly connections: readonly IntegrationConnectionSummary[];
  readonly hostsDeployment: boolean;
  readonly machine: MachineSummary;
}): boolean {
  const effectiveOwner = input.machine.ownership === "mine" || input.hostsDeployment;
  return (
    effectiveOwner &&
    ((input.machine.apps?.length ?? 0) > 0 ||
      computerConnectionsOn(input.connections, input.machine.id).length > 0)
  );
}

/** The product word for one target computer platform. */
export function computerAppPlatformName(platform: ComputerAppPlatformView): string {
  switch (platform) {
    case "android":
      return "Android phone";
    case "darwin":
      return "Mac";
    case "ios":
      return "iPhone";
    case "linux":
      return "Linux computer";
    case "win32":
      return "PC";
  }
}

/** One target with its article: "a Mac", "an Android phone", "an iPhone". */
function computerAppPlatformTarget(platform: ComputerAppPlatformView): string {
  const article = platform === "android" || platform === "ios" ? "an" : "a";
  return `${article} ${computerAppPlatformName(platform)}`;
}

/** A grammatical target such as "a Mac" or "a Mac or an Android phone". */
export function computerAppPlatformTargetLabel(
  platforms: readonly ComputerAppPlatformView[],
): string {
  const targets = platforms.map(computerAppPlatformTarget);
  if (targets.length === 0) return "a supported computer";
  if (targets.length === 1) return targets[0]!;
  if (targets.length === 2) return `${targets[0]} or ${targets[1]}`;
  return `${targets.slice(0, -1).join(", ")}, or ${targets.at(-1)}`;
}

/** Catalog-ready copy derived from the definition rather than the viewing device. */
export function computerAppPlatformRequirementLabel(
  definition: Pick<IntegrationDefinitionSummaryView, "computerApp">,
): string | null {
  const platforms = definition.computerApp?.platforms;
  return platforms ? `Requires ${computerAppPlatformTargetLabel(platforms)}` : null;
}
