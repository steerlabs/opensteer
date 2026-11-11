import type {
  IntegrationPlatformDashboardView,
  IntegrationConnectionSummary,
} from "@opensteer/integration-core";
import { createId, RunnerIdSchema, type DeploymentId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import {
  DevicesOverviewViewSchema,
  PluginDetailViewSchema,
  PluginsOverviewViewSchema,
  type PluginDetailView,
  type DevicesOverviewView,
  type PluginTarget,
  type HostApiCommand,
  type HostApiCommandOutput,
} from "@opensteer/protocol";
import { pluginSummaries } from "../host/plugins.js";
import { HostClientRequestError } from "../host/client.js";

/** Mutable permission state for UI work before the real Host projection lands. */
export class MockSettingsFixtures {
  readonly listeners = new Set<(message: { type: "host.plugins-changed" }) => void>();
  private details: PluginDetailView[] | null = null;
  private readonly fallbackDevices = DevicesOverviewViewSchema.parse({
    devices: [
      {
        id: createId("runner"),
        name: "Main Mac",
        device: { platform: "macos", form: "laptop" },
        ownership: "deployment",
        ownerName: null,
        status: "online",
        allowedModules: ["agents", "integrations", "browser", "shell"],
        revocable: false,
      },
      {
        id: createId("runner"),
        name: "Office Mac",
        device: { platform: "macos", form: "desktop" },
        ownership: "mine",
        ownerName: null,
        status: "offline",
        allowedModules: ["agents", "integrations", "shell"],
        revocable: true,
      },
      {
        id: createId("runner"),
        name: "Agent Phone",
        device: { platform: "android", form: "phone" },
        ownership: "mine",
        ownerName: null,
        status: "online",
        allowedModules: ["integrations"],
        revocable: true,
      },
      {
        id: createId("runner"),
        name: "iPhone",
        device: { platform: "ios", form: "phone" },
        ownership: "mine",
        ownerName: null,
        status: "offline",
        allowedModules: ["integrations"],
        revocable: true,
      },
    ],
  });
  private readonly changed: () => void;
  private readonly serviceAccounts:
    ((definitionId: string) => readonly IntegrationConnectionSummary[]) | undefined;
  private readonly readDevices: (() => DevicesOverviewView) | undefined;
  constructor(
    changed: () => void,
    readDevices?: () => DevicesOverviewView,
    serviceAccounts?: (definitionId: string) => readonly IntegrationConnectionSummary[],
  ) {
    this.readDevices = readDevices;
    this.serviceAccounts = serviceAccounts;
    this.changed = changed;
  }
  get devices(): DevicesOverviewView {
    return this.readDevices?.() ?? this.fallbackDevices;
  }
  private inventory(_deploymentId: DeploymentId): PluginDetailView[] {
    if (this.details) return this.details;
    const entries: {
      target: PluginTarget;
      title: string;
      tag: "accounts" | "devices" | "skills" | "specialists";
      enabled?: boolean;
      issues?: PluginDetailView["row"]["issues"];
      accounts?: number;
    }[] = [
      {
        target: { kind: "service", definitionId: "google-gmail" },
        title: "Gmail",
        tag: "accounts",
        accounts: 2,
      },
      {
        target: { kind: "service", definitionId: "linear" },
        title: "Linear",
        tag: "accounts",
        accounts: 1,
        issues: ["needs-sign-in"],
      },
      {
        target: { kind: "service", definitionId: "notion" },
        title: "Notion",
        tag: "accounts",
        enabled: false,
      },
      {
        target: { kind: "device-app", definitionId: "apple-messages" },
        title: "iMessage",
        tag: "devices",
        issues: ["waiting-device"],
      },
      {
        target: { kind: "device-app", definitionId: "apple-calendar" },
        title: "Calendar",
        tag: "devices",
        issues: ["waiting-device"],
      },
      {
        target: { kind: "plugin", pluginId: "review-kit" },
        title: "Review kit",
        tag: "skills",
        issues: ["unknown-source-folder"],
      },
      {
        target: { kind: "skill", fullName: "writing-style" },
        title: "Writing style",
        tag: "skills",
      },
      {
        target: { kind: "specialist", pluginId: "review-kit", ownerUserId: createId("user") },
        title: "Code reviewer",
        tag: "specialists",
      },
    ];
    this.details = entries.map((entry) =>
      PluginDetailViewSchema.parse({
        installationIds: [],
        grants: [],
        registrations: [],
        row: {
          target: entry.target,
          title: entry.title,
          description: null,
          source: {
            kind:
              entry.target.kind === "skill"
                ? "folder"
                : entry.target.kind === "plugin" || entry.target.kind === "specialist"
                  ? "plugin"
                  : "built-in",
            version: null,
          },
          tags: [entry.tag],
          placement: {
            enabled: entry.enabled ?? true,

            revision: 0,
          },
          accountCount: entry.accounts ?? 0,
          issues: entry.issues ?? [],
          contents: {
            skills: entry.tag === "skills" ? 1 : 0,
            tools: entry.tag === "accounts" ? 4 : 0,
            specialists: entry.tag === "specialists" ? 1 : 0,
          },
          permissions: {
            canEnable: true,
            canPlace: false,

            canRemove: true,
            canUpdate: false,
          },
        },
        accounts: Array.from({ length: entry.accounts ?? 0 }, (_, index) => ({
          connectionId: createIntegrationId("connection"),
          displayName: index ? "tim@steerlabs.com" : "tim@example.com",
          status: entry.issues?.includes("needs-sign-in") ? "needs-attention" : "connected",
          statusReason: entry.issues?.includes("needs-sign-in") ? "credentials" : null,
          access: "read",
          runnerId: null,
        })),

        devices:
          entry.tag === "devices"
            ? this.devices.devices
                .filter(({ name }) =>
                  entry.title === "Calendar" ? name.includes("iPhone") : name.includes("MacBook"),
                )
                .map(({ id, name, status }) => ({
                  runnerId: RunnerIdSchema.parse(id),
                  name,
                  status,
                }))
            : [],
        permissions:
          entry.tag === "accounts"
            ? [
                {
                  label: "Account access",
                  layer: "account-scope",
                  state: entry.issues?.includes("needs-sign-in") ? "unknown" : "allowed",
                },
              ]
            : entry.tag === "devices"
              ? [{ label: "OS permission", layer: "os-permission", state: "unknown" }]
              : [],
        contents: entry.tag === "skills" ? [{ name: entry.title, kind: "skill" }] : [],
        sourceFolder: null,
      }),
    );
    return this.details;
  }
  private packageIds = new Set<string>();
  syncPackages(
    deploymentId: DeploymentId,
    stored: readonly unknown[],
    deviceOf: (pluginId: string) => {
      readonly device: NonNullable<PluginDetailView["row"]["device"]>;
      readonly setupThreadId: string | null;
    } | null = () => null,
  ) {
    const packages = pluginSummaries(stored);
    const current = this.inventory(deploymentId).filter(
      (detail) =>
        detail.row.target.kind !== "plugin" ||
        !this.packageIds.has(detail.row.target.pluginId) ||
        packages.some(
          (plugin) =>
            plugin.id === (detail.row.target.kind === "plugin" ? detail.row.target.pluginId : ""),
        ),
    );
    for (const plugin of packages) {
      // Agent-made plugins update when an agent installs their folder again.
      const sourceFolder = plugin.scope === "deployment" ? plugin.directory : null;
      if (
        current.some(
          (detail) =>
            detail.row.target.kind === "plugin" && detail.row.target.pluginId === plugin.id,
        )
      )
        continue;
      const declared = deviceOf(plugin.id);
      current.push(
        PluginDetailViewSchema.parse({
          row: {
            target: { kind: "plugin", pluginId: plugin.id },
            title: plugin.name,
            description: plugin.description,
            source: {
              kind: plugin.scope === "folder" ? "folder" : "plugin",
              version: plugin.version,
            },
            tags: ["skills"],
            ...(declared ? { device: declared.device } : {}),
            placement: {
              enabled: plugin.enabled,

              revision: 0,
            },
            accountCount: 0,
            issues: sourceFolder || plugin.scope === "folder" ? [] : ["unknown-source-folder"],
            contents: {
              skills: plugin.skills,
              tools: plugin.servers,
              specialists: plugin.specialist ? 1 : 0,
            },
            permissions: {
              canEnable: true,
              canPlace: false,

              canRemove: true,
              canUpdate: sourceFolder !== null,
            },
          },
          accounts: [],
          installationIds: [],
          grants: [],
          registrations: [],

          devices: [],
          permissions: [],
          contents: [],
          sourceFolder,
          ...(declared ? { setupThreadId: declared.setupThreadId } : {}),
        }),
      );
    }
    this.packageIds = new Set(packages.map((plugin) => plugin.id));
    this.details = current;
  }
  private readonly serviceIds = new Set<string>();
  syncServices(deploymentId: DeploymentId, platform: IntegrationPlatformDashboardView) {
    const current = this.inventory(deploymentId).filter(
      (detail) =>
        (detail.row.target.kind !== "service" && detail.row.target.kind !== "device-app") ||
        !this.serviceIds.has(detail.row.target.definitionId) ||
        platform.catalog.some(
          (item) =>
            item.definition.id ===
              (detail.row.target.kind === "service" || detail.row.target.kind === "device-app"
                ? detail.row.target.definitionId
                : "") && item.installationId !== null,
        ),
    );
    this.details = current;
    for (const item of platform.catalog)
      if (item.installationId) this.serviceIds.add(item.definition.id);
    const template = current[0];
    if (!template) return;
    for (const item of platform.catalog) {
      if (
        !item.installationId ||
        current.some(
          (detail) =>
            (detail.row.target.kind === "service" || detail.row.target.kind === "device-app") &&
            detail.row.target.definitionId === item.definition.id,
        )
      )
        continue;
      const installation = platform.installations.find(
        (entry) => entry.installation.id === item.installationId,
      );
      const detail = structuredClone(template);
      detail.row.target = {
        kind: item.definition.computerApp ? "device-app" : "service",
        definitionId: item.definition.id,
      };
      detail.row.title = item.definition.name;
      detail.row.description = item.definition.description;
      detail.row.tags = [item.definition.computerApp ? "devices" : "accounts"];
      detail.row.issues =
        installation?.installation.status === "active" ? [] : ["invalid-installation"];
      detail.row.placement = {
        enabled: true,

        revision: 0,
      };

      detail.row.accountCount = 0;
      detail.row.issues = item.definition.authMethods.length ? ["needs-sign-in"] : [];
      detail.accounts = [];
      detail.installationIds = [item.installationId];
      detail.permissions = [];
      detail.contents = (installation?.tools ?? []).map((tool) => ({
        kind: "tool",
        name: tool.title,
      }));
      detail.row.contents = { skills: 0, specialists: 0, tools: detail.contents.length };
      current.push(PluginDetailViewSchema.parse(detail));
    }
  }
  private syncAccounts(deploymentId: DeploymentId) {
    for (const detail of this.inventory(deploymentId)) {
      if (detail.row.target.kind !== "service" || !this.serviceAccounts) continue;
      detail.accounts = this.serviceAccounts(detail.row.target.definitionId).map((account) => ({
        connectionId: account.id,
        displayName: account.displayName,
        status: account.status,
        statusReason: account.statusReason,
        access: account.computer?.access ?? "read",
        runnerId: account.computer?.runnerId ?? null,
      }));
      detail.row.accountCount = detail.accounts.length;
    }
  }
  overview(deploymentId: DeploymentId) {
    this.syncAccounts(deploymentId);
    return PluginsOverviewViewSchema.parse({
      rows: this.inventory(deploymentId).map(({ row }) => row),
    });
  }
  detail(deploymentId: DeploymentId, target: PluginTarget) {
    this.syncAccounts(deploymentId);
    const detail = this.inventory(deploymentId).find(
      ({ row }) => JSON.stringify(row.target) === JSON.stringify(target),
    );
    if (!detail)
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "Plugin not found.",
      });
    return structuredClone(detail);
  }
  mutate(
    deploymentId: DeploymentId,
    command: Extract<HostApiCommand, { type: "settings.plugin.enabled.set" }>,
  ): HostApiCommandOutput {
    const detail = this.inventory(deploymentId).find(
      ({ row }) => JSON.stringify(row.target) === JSON.stringify(command.target),
    );
    if (!detail)
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "Plugin not found.",
      });
    if (detail.row.placement.revision !== command.expectedRevision)
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: "Plugin changed. Reload before editing.",
      });
    detail.row.placement = {
      enabled: command.enabled,
      revision: detail.row.placement.revision + 1,
    };
    for (const listener of this.listeners) listener({ type: "host.plugins-changed" });
    this.changed();
    return { type: command.type, placement: structuredClone(detail.row.placement) };
  }
}
