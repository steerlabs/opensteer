import { createId, RunnerIdSchema, type WorkspaceId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core/ids";
import {
  DevicesOverviewViewSchema,
  PluginDetailViewSchema,
  PluginsOverviewViewSchema,
  type PluginDetailView,
  type PluginTarget,
  type HostApiCommand,
  type HostApiCommandOutput,
} from "@opensteer/protocol";
import { HostClientRequestError } from "../host/client.js";

/** Mutable permission state for UI work before the real Host projection lands. */
export class MockSettingsFixtures {
  readonly listeners = new Set<(message: { type: "host.plugins-changed" }) => void>();
  private details: PluginDetailView[] | null = null;
  readonly devices = DevicesOverviewViewSchema.parse({
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
  private readonly workspaces: () => {
    workspaceId: WorkspaceId;
    name: string;
    kind: "main" | "project";
  }[];
  constructor(changed: () => void, workspaces: MockSettingsFixtures["workspaces"]) {
    this.changed = changed;
    this.workspaces = workspaces;
  }
  private inventory(workspaceId: WorkspaceId): PluginDetailView[] {
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
        target: { kind: "skill", workspaceId, fullName: "writing-style" },
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
                ? "workspace"
                : entry.target.kind === "plugin" || entry.target.kind === "specialist"
                  ? "plugin"
                  : "built-in",
            version: null,
          },
          tags: [entry.tag],
          placement: {
            enabled: entry.enabled ?? true,
            mainIncluded: true,
            projectCount: 0,
            personalEverywhere: false,
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
            canPlace: entry.target.kind !== "skill",
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
        places: this.workspaces().map((place) => ({
          ...place,
          selected: place.kind === "main",
          canSelect: true,
          accounts: [],
        })),
        personalEverywhere: null,
        devices:
          entry.tag === "devices"
            ? this.devices.devices
                .filter(({ name }) =>
                  entry.title === "Calendar" ? name === "iPhone" : name === "Office Mac",
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
  overview(workspaceId: WorkspaceId) {
    return PluginsOverviewViewSchema.parse({
      rows: this.inventory(workspaceId).map(({ row }) => row),
    });
  }
  detail(workspaceId: WorkspaceId, target: PluginTarget) {
    const detail = this.inventory(workspaceId).find(
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
    workspaceId: WorkspaceId,
    command: Extract<
      HostApiCommand,
      { type: "settings.plugin.enabled.set" | "settings.plugin.placement.set" }
    >,
  ): HostApiCommandOutput {
    const detail = this.inventory(workspaceId).find(
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
    if (command.type === "settings.plugin.enabled.set")
      detail.row.placement.enabled = command.enabled;
    else {
      if (command.personalEverywhere !== null && !command.mainIncluded)
        throw new HostClientRequestError({
          code: "bad_request",
          status: 400,
          message: "Everywhere includes Main.",
        });
      if (!detail.row.permissions.canPlace)
        throw new HostClientRequestError({
          code: "forbidden",
          status: 403,
          message: "A loose skill stays in its source Workspace.",
        });
      const accountIds = [
        ...command.projects.flatMap(({ accounts }) => accounts),
        ...(command.personalEverywhere?.accounts ?? []),
      ];
      if (
        command.projects.some(
          ({ workspaceId }) =>
            !detail.places.some(
              (place) => place.kind === "project" && place.workspaceId === workspaceId,
            ),
        ) ||
        accountIds.some(
          ({ connectionId }) =>
            !detail.accounts.some((account) => account.connectionId === connectionId),
        )
      )
        throw new HostClientRequestError({
          code: "bad_request",
          status: 400,
          message: "Unknown Project or account.",
        });
      detail.row.placement.mainIncluded = command.mainIncluded;
      for (const place of detail.places) {
        const selection = command.projects.find(
          ({ workspaceId }) => workspaceId === place.workspaceId,
        );
        place.selected =
          place.kind === "main"
            ? command.mainIncluded
            : command.personalEverywhere !== null || selection !== undefined;
        place.accounts = selection?.accounts ?? command.personalEverywhere?.accounts ?? [];
      }
      detail.row.placement.projectCount = detail.places.filter(
        (place) => place.kind === "project" && place.selected,
      ).length;
      detail.personalEverywhere = command.personalEverywhere;
      detail.row.placement.personalEverywhere = command.personalEverywhere !== null;
    }
    detail.row.placement.revision++;
    for (const listener of this.listeners) listener({ type: "host.plugins-changed" });
    this.changed();
    return { type: command.type, placement: structuredClone(detail.row.placement) };
  }
}
