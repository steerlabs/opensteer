import {
  AgentGrantResourceSchema,
  agentGrantPluginTargetKey,
  type AgentGrantPluginTarget,
  type AgentGrantResource,
} from "@opensteer/core";
import type {
  AgentConnectionConsent,
  ApprovedComputerApp,
  MachineSummary,
  PluginsInstalledView,
} from "@opensteer/protocol";
import { hostsDeployment } from "../computers/computers.js";
import { agentWords } from "./connected-agents-copy.js";
import type { AgentGrantDraft } from "./connected-agent-view.js";
import type { HostClient, HostSnapshot } from "./client.js";
import { machineSelfRunnerId } from "./device-projection.js";
import { unwrapRpcResult } from "./host-session-client.js";

/** One existing browser profile an agent could be given, with the Device it lives on. */
export interface ProfileOption {
  readonly id: string;
  readonly name: string;
  readonly resource: Extract<AgentGrantResource, { kind: "browser-profile" }>;
  /** Its Device and whether it is reachable now; null for a profile not opened anywhere yet. */
  readonly device: { readonly name: string; readonly online: boolean } | null;
  readonly detail: string;
}

export type ChromeTabGrantCatalog = Pick<
  AgentConnectionConsent,
  "chromeTabs" | "chromeTabsNeedPairing" | "chromeTabsRepairNames"
>;

export function chromeTabGrantOptions(catalog?: ChromeTabGrantCatalog) {
  const options = (catalog?.chromeTabs ?? []).flatMap(({ sourceId, computerName, paired }) =>
    paired
      ? [
          {
            resource: { kind: "chrome-tabs" as const, sourceId },
            name: agentWords("consent.chromeTabs.label", { device: computerName }),
          },
        ]
      : [],
  );
  const names = [
    ...new Set([
      ...(catalog?.chromeTabsRepairNames ?? []),
      ...(catalog?.chromeTabs ?? []).flatMap(({ computerName, paired }) =>
        paired ? [] : [computerName],
      ),
    ]),
  ];
  const repair =
    names.length > 1
      ? agentWords("consent.chromeTabs.repairOnMultiple", {
          devices: `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`,
        })
      : names[0]
        ? agentWords("consent.chromeTabs.repairOn", { device: names[0] })
        : catalog?.chromeTabsNeedPairing
          ? agentWords("consent.chromeTabs.repair")
          : null;
  return { options, repair };
}

/**
 * The person's choices carried onto a consent read again: all of them, except sharing tabs
 * from a Chrome the new read no longer offers.
 */
export function draftForCatalog(
  draft: AgentGrantDraft,
  catalog?: ChromeTabGrantCatalog,
): AgentGrantDraft {
  const offered = new Set(chromeTabGrantOptions(catalog).options.map((o) => o.resource.sourceId));
  const resources = draft.resources.filter(
    (resource) => resource.kind !== "chrome-tabs" || offered.has(resource.sourceId),
  );
  return resources.length === draft.resources.length ? draft : { ...draft, resources };
}

export async function readChromeTabGrantCatalog(
  client: Pick<HostClient, "rpc">,
  signal?: AbortSignal,
): Promise<ChromeTabGrantCatalog> {
  return unwrapRpcResult(
    await client.rpc["browser.sources.get"]({}, signal ? { signal } : undefined),
  );
}

/** A Device a new dedicated profile can be kept on. */
export interface AgentProfileHomeOption {
  readonly runnerId: string;
  readonly name: string;
  readonly online: boolean;
  readonly home: boolean;
}

export interface BrowserOptions {
  readonly profiles: readonly ProfileOption[];
  /**
   * Where a new profile can live. `null` means this Home doesn't say, and places a new
   * profile itself; an empty list means no Device can hold one.
   */
  readonly homes: readonly AgentProfileHomeOption[] | null;
  /** The Device a new dedicated profile defaults to, or null when the Home decides. */
  readonly defaultHome: string | null;
}

function deviceOf(
  runnerId: string | null,
  machines: readonly MachineSummary[],
): MachineSummary | null {
  if (runnerId === null) return null;
  return machines.find((machine) => machineSelfRunnerId(machine) === runnerId) ?? null;
}

/** Profiles and the Devices a new one may live on, from what the snapshot already holds. */
export function agentBrowserOptions(
  snapshot: Pick<HostSnapshot, "browserProfiles" | "browserProfileHomes" | "machines">,
): BrowserOptions {
  const profiles = snapshot.browserProfiles.flatMap((profile): ProfileOption[] => {
    // Where an AI engine signs in is the person's own; no agent's grant may name it.
    if (profile.purpose === "engine-sign-in") return [];
    const resource = AgentGrantResourceSchema.safeParse({
      kind: "browser-profile",
      profileId: profile.id,
    });
    if (!resource.success || resource.data.kind !== "browser-profile") return [];
    const machine = deviceOf(profile.homeRunnerId, snapshot.machines);
    const device = machine ? { name: machine.name, online: machine.status === "online" } : null;
    return [
      {
        id: profile.id,
        name: profile.name,
        resource: resource.data,
        device,
        detail: device
          ? agentWords(
              device.online ? "consent.browser.device.online" : "consent.browser.device.offline",
              {
                device: device.name,
              },
            )
          : agentWords("consent.browser.device.unknown"),
      },
    ];
  });
  const listed = snapshot.browserProfileHomes;
  if (listed === undefined) return { profiles, homes: null, defaultHome: null };
  const homes = snapshot.machines.flatMap((machine): AgentProfileHomeOption[] => {
    const runnerId = machineSelfRunnerId(machine);
    return runnerId && listed.includes(runnerId)
      ? [
          {
            runnerId,
            name: machine.name,
            online: machine.status === "online",
            home: hostsDeployment(machine),
          },
        ]
      : [];
  });
  homes.sort((a, b) => Number(b.home) - Number(a.home) || Number(b.online) - Number(a.online));
  return { profiles, homes, defaultHome: homes[0]?.runnerId ?? null };
}

/** An app or phone screen already approved on a Device. */
export interface AppOption {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  readonly phone: boolean;
  readonly resource: Extract<AgentGrantResource, { kind: "computer-app" }>;
}

/**
 * Approved apps as grant resources. A phone screen's definition comes from its Device;
 * an approval whose identity can't be stated exactly is left out rather than guessed.
 */
export function agentAppOptions(
  approved: readonly ApprovedComputerApp[],
  machines: readonly MachineSummary[],
): readonly AppOption[] {
  return approved.flatMap((app): AppOption[] => {
    const machine = machines.find(({ id }) => id === app.machineId);
    const identity =
      app.target.kind === "app"
        ? {
            kind: "mac-app" as const,
            bundleId: app.target.app.bundleId,
            teamId: app.target.app.teamId,
          }
        : machine?.phoneDisplay
          ? { kind: "phone-screen" as const, definitionId: machine.phoneDisplay.definitionId }
          : null;
    if (!identity) return [];
    const parsed = AgentGrantResourceSchema.safeParse({
      kind: "computer-app",
      approvalId: app.connectionId,
      deviceId: app.machineId,
      app: identity,
    });
    if (!parsed.success || parsed.data.kind !== "computer-app") return [];
    const through =
      machine?.phoneDisplay?.setup.location === "driver-mac"
        ? machine.phoneDisplay.setup.driverRunnerName
        : null;
    return [
      {
        key: app.connectionId,
        name: app.name,
        phone: identity.kind === "phone-screen",
        detail: through
          ? agentWords("consent.apps.phoneThrough", { device: through })
          : machine && machine.name !== app.name
            ? machine.name
            : "",
        resource: parsed.data,
      },
    ];
  });
}

/** A plugin, local server or device data account, with the access its owner setting allows. */
export interface PluginOption {
  readonly key: string;
  readonly name: string;
  readonly detail: string | null;
  readonly target: AgentGrantPluginTarget;
  readonly writable: boolean;
}

export interface PluginOptions {
  readonly options: readonly PluginOption[];
  /** More installed plugins exist past the first page this list shows. */
  readonly more: boolean;
}

/** What agents may use from Plugins: anything its owner switched off is not offered. */
export function agentPluginOptions(view: PluginsInstalledView): PluginOptions {
  const plugins = (view.plugins ?? []).flatMap((plugin): PluginOption[] =>
    plugin.access === "off"
      ? []
      : [
          {
            key: `installed:${plugin.id}`,
            name: plugin.name,
            detail: null,
            target: { kind: "installed", pluginId: plugin.id },
            writable: plugin.access === "all",
          },
        ],
  );
  const local = view.local.flatMap((tool): PluginOption[] => {
    if (tool.access === "off") return [];
    const source = tool.id.startsWith("app_device_")
      ? { kind: "device-app" as const, connectionId: tool.id.slice("app_device_".length) }
      : tool.id.startsWith("app_server_")
        ? { kind: "local-server" as const, serverId: tool.id.slice("app_server_".length) }
        : null;
    const target = AgentGrantResourceSchema.safeParse({
      kind: "plugin",
      access: "read",
      target:
        source?.kind === "device-app"
          ? { kind: "device-account", integrationConnectionId: source.connectionId }
          : source?.kind === "local-server"
            ? { kind: "local-server", serverId: source.serverId }
            : null,
    });
    if (!target.success || target.data.kind !== "plugin") return [];
    return [
      {
        key: tool.id,
        name: tool.title,
        detail: tool.computer?.name ?? null,
        target: target.data.target,
        writable: tool.access === "all" && tool.readOnlyToolCount < tool.toolCount,
      },
    ];
  });
  return { options: [...plugins, ...local], more: view.cursor !== null };
}

/** Approved apps, read only when the person opens that list. */
export async function readAgentAppOptions(
  client: Pick<HostClient, "rpc" | "getSnapshot">,
  signal?: AbortSignal,
): Promise<readonly AppOption[]> {
  const { apps } = unwrapRpcResult(
    await client.rpc["integration.computer.apps.approved"]({}, signal ? { signal } : undefined),
  );
  return agentAppOptions(apps, client.getSnapshot().machines);
}

/** Installed plugins and local tools, read only when the person opens that list. */
export async function readAgentPluginOptions(
  client: Pick<HostClient, "rpc">,
  signal?: AbortSignal,
): Promise<PluginOptions> {
  const view = unwrapRpcResult(
    await client.rpc["plugins.installed.list"]({}, signal ? { signal } : undefined),
  );
  return agentPluginOptions(view);
}

/** The Home's own name, as Tasks words where delegated work runs. */
export function agentHomeName(snapshot: Pick<HostSnapshot, "machines" | "identityConfig">): string {
  return (
    snapshot.machines.find((machine) => hostsDeployment(machine))?.name ??
    snapshot.identityConfig?.deployment.name ??
    "your Home"
  );
}

/** The Device a new dedicated profile will live on, when the Home says. */
export function draftNewProfileHome(draft: AgentGrantDraft, browser: BrowserOptions) {
  const id = draft.newProfile?.homeRunnerId ?? browser.defaultHome;
  return browser.homes?.find(({ runnerId }) => runnerId === id) ?? null;
}

/** The Browser row's line: the new profile and the profiles chosen. */
export function draftBrowserSummary(draft: AgentGrantDraft, browser: BrowserOptions): string {
  const parts: string[] = [];
  if (draft.newProfile) {
    const where = draftNewProfileHome(draft, browser)?.name;
    parts.push(
      `${agentWords("consent.browser.newProfile")} · ${
        where
          ? agentWords("consent.browser.newProfile.summary", { device: where })
          : agentWords("consent.browser.newProfile.summaryAnywhere")
      }`,
    );
  }
  for (const resource of draft.resources)
    if (resource.kind === "browser-profile")
      parts.push(
        browser.profiles.find(({ id }) => id === resource.profileId)?.name ??
          agentWords("agents.row.someProfile"),
      );
  return parts.length ? parts.join(", ") : agentWords("consent.browser.none");
}

/** Apps chosen, by name once the list is read, else counted. */
export function draftAppsSummary(
  draft: AgentGrantDraft,
  options: readonly AppOption[] | null,
): string {
  const chosen = draft.resources.filter((resource) => resource.kind === "computer-app");
  if (!chosen.length) return agentWords("consent.apps.none");
  if (!options)
    return chosen.length === 1
      ? agentWords("agents.row.app")
      : agentWords("agents.row.apps", { count: chosen.length });
  return chosen
    .map(
      (resource) =>
        options.find((option) => option.resource.approvalId === resource.approvalId)?.name ??
        agentWords("agents.row.app"),
    )
    .join(", ");
}

/** Plugins chosen with their access, by name once the list is read, else counted. */
export function draftPluginsSummary(
  draft: AgentGrantDraft,
  options: readonly PluginOption[] | null,
): string {
  const chosen = draft.resources.filter((resource) => resource.kind === "plugin");
  if (!chosen.length) return agentWords("consent.plugins.none");
  if (!options)
    return chosen.length === 1
      ? agentWords("agents.row.plugin")
      : agentWords("agents.row.plugins", { count: chosen.length });
  return chosen
    .map((resource) => {
      const key = agentGrantPluginTargetKey(resource.target);
      const name =
        options.find((option) => agentGrantPluginTargetKey(option.target) === key)?.name ??
        agentWords("agents.row.plugin");
      return agentWords(
        resource.access === "read-write"
          ? "consent.plugins.summaryReadWrite"
          : "consent.plugins.summaryRead",
        { plugin: name },
      );
    })
    .join(", ");
}
