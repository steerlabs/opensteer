import type { PluginChange } from "@opensteer/protocol";
import { createId, type DeploymentId } from "@opensteer/core";
import {
  DevicesOverviewViewSchema,
  PluginsOverviewViewSchema,
  type DevicesOverviewView,
  type HostApiCommand,
  type HostApiCommandOutput,
} from "@opensteer/protocol";
import { HostClientRequestError } from "../host/client.js";

export class MockSettingsFixtures {
  readonly listeners = new Set<
    (message: { type: "host.plugins-changed" } & PluginChange) => void
  >();
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
  private readonly skills = PluginsOverviewViewSchema.parse({
    rows: [
      {
        target: { kind: "skill", fullName: "writing-style" },
        title: "Writing style",
        description: null,
        source: { kind: "folder", version: null },
        tags: ["skills"],
        placement: { enabled: true, revision: 0 },
        accountCount: 0,
        issues: [],
        contents: { skills: 1, tools: 0 },
        permissions: { canEnable: true, canPlace: false, canRemove: false, canUpdate: false },
      },
    ],
  });
  private readonly changed: () => void;
  private readonly readDevices: (() => DevicesOverviewView) | undefined;
  constructor(changed: () => void, readDevices?: () => DevicesOverviewView) {
    this.changed = changed;
    this.readDevices = readDevices;
  }
  get devices(): DevicesOverviewView {
    return this.readDevices?.() ?? this.fallbackDevices;
  }
  overview(_deploymentId: DeploymentId) {
    return structuredClone(this.skills);
  }
  mutate(
    _deploymentId: DeploymentId,
    command: Extract<HostApiCommand, { type: "settings.plugin.enabled.set" }>,
  ): HostApiCommandOutput {
    const row = this.skills.rows.find(
      ({ target }) =>
        target.kind === "skill" &&
        command.target.kind === "skill" &&
        target.fullName === command.target.fullName,
    );
    if (!row)
      throw new HostClientRequestError({
        code: "not_found",
        status: 404,
        message: "Skill not found.",
      });
    if (row.placement.revision !== command.expectedRevision)
      throw new HostClientRequestError({
        code: "conflict",
        status: 409,
        message: "Skill changed. Reload before editing.",
      });
    row.placement = { enabled: command.enabled, revision: row.placement.revision + 1 };
    for (const listener of this.listeners) listener({ type: "host.plugins-changed" });
    this.changed();
    return { type: command.type, placement: structuredClone(row.placement) };
  }
}
