import { z } from "zod";
import {
  harnessDriverLabel,
  type SpecialistAccessRequirement,
  type SpecialistRegistration,
} from "@opensteer/core";

/**
 * `plugin.list` returns stored rows for administrators and a safe projection for
 * Workspace members. This reads only what a person is shown, so rows with optional
 * fields than this client knows still lists.
 */
const timestamp = z
  .union([z.string(), z.date()])
  .transform((value) => new Date(value).toISOString());
const PluginRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["deployment", "workspace"]).catch("deployment"),
  workspaceId: z.string().nullable().catch(null),
  source: z.object({ directory: z.string().optional() }).catch({}).optional(),
  currentVersionId: z.string().nullable().catch(null),
  updatedAt: timestamp.optional().catch(undefined),
  versions: z
    .array(
      z.object({
        id: z.string(),
        digest: z.string(),
        manifest: z
          .object({
            description: z.string().optional().catch(undefined),
            version: z.string().optional().catch(undefined),
            skills: z.array(z.unknown()).optional().catch(undefined),
          })
          .nullable()
          .optional()
          .catch(null),
        specialistManifest: z.unknown().optional(),
      }),
    )
    .catch([]),
  activations: z.array(z.object({ workspaceId: z.string() })).catch([]),
  servers: z.array(z.unknown()).optional().catch(undefined),
});

/** One installed plugin, as Settings and a Project's settings show it. */
export interface PluginSummary {
  readonly id: string;
  readonly name: string;
  /** Installed for the whole Deployment, or by an agent inside one Workspace. */
  readonly scope: "deployment" | "workspace";
  /** The Workspace a Workspace-scoped plugin belongs to. */
  readonly workspaceId: string | null;
  /** The Host folder it was installed from, which Update reads again. */
  readonly directory: string | null;
  /** The package's own version, when its manifest names one. */
  readonly version: string | null;
  /** The installed snapshot, for a package that names no version. */
  readonly digest: string | null;
  readonly description: string | null;
  /** Whether its current version carries a specialist. */
  readonly specialist: boolean;
  readonly skills: number;
  readonly servers: number;
  /** The Workspaces it is turned on in. */
  readonly activeIn: readonly string[];
  readonly updatedAt: string | null;
}

export function pluginSummaries(rows: readonly unknown[]): PluginSummary[] {
  return rows.flatMap((row) => {
    const parsed = PluginRowSchema.safeParse(row);
    if (!parsed.success) return [];
    const plugin = parsed.data;
    const current =
      plugin.versions.find(({ id }) => id === plugin.currentVersionId) ?? plugin.versions.at(-1);
    return [
      {
        id: plugin.id,
        name: plugin.name,
        scope: plugin.scope,
        workspaceId: plugin.workspaceId,
        directory: plugin.source?.directory ?? null,
        version: current?.manifest?.version ?? null,
        digest: current?.digest ?? null,
        description: current?.manifest?.description?.trim() || null,
        specialist: current?.specialistManifest != null,
        skills: current?.manifest?.skills?.length ?? 0,
        servers: plugin.servers?.length ?? 0,
        activeIn: plugin.activations.map(({ workspaceId }) => workspaceId),
        updatedAt: plugin.updatedAt ?? null,
      },
    ];
  });
}

/** A plugin may be turned on in a Workspace it was installed for: any, or its own. */
export function pluginAvailableIn(
  plugin: Pick<PluginSummary, "scope" | "workspaceId">,
  workspaceId: string,
): boolean {
  return plugin.scope === "deployment" || plugin.workspaceId === workspaceId;
}

/** "Version 1.2.0", or the start of the installed snapshot for an unversioned package. */
export function pluginVersionLabel(plugin: Pick<PluginSummary, "digest" | "version">): string {
  if (plugin.version) return `Version ${plugin.version.replace(/^v/u, "")}`;
  return plugin.digest ? `Build ${plugin.digest.slice(0, 8)}` : "Unversioned";
}

/** What a plugin brings, in a few words: "3 skills · 1 server". */
export function pluginContents(plugin: Pick<PluginSummary, "servers" | "skills">): string | null {
  const parts = [
    plugin.skills > 0 ? `${plugin.skills} ${plugin.skills === 1 ? "skill" : "skills"}` : null,
    plugin.servers > 0 ? `${plugin.servers} ${plugin.servers === 1 ? "server" : "servers"}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/* ---- Specialists ---- */

export type SpecialistAccessItem = SpecialistRegistration["access"][number];

/** What a specialist asks to use, named for a person: "GitHub", "A browser profile". */
export function specialistAccessName(requirement: SpecialistAccessRequirement): string {
  switch (requirement.type) {
    case "integration":
      return serviceName(requirement.service);
    case "browser-profile":
      return "A browser profile";
    case "computer-app":
      return appName(requirement.app);
    case "phone":
      return "An Agent Phone";
  }
}

/** How much of it the specialist uses. */
export function specialistAccessLevel(requirement: SpecialistAccessRequirement): string {
  return requirement.level === "read" ? "Read only" : "Read and make changes";
}

/** The models a specialist runs on, in its order of preference: "Claude Code · opus". */
export function specialistModels(registration: Pick<SpecialistRegistration, "models">): string[] {
  return registration.models.map((entry) =>
    "unknown" in entry
      ? "Unknown model entry"
      : "role" in entry
        ? `${entry.role === "light" ? "Quick model" : "Strong model"} · per your settings`
        : `${harnessDriverLabel(entry.engine)} · ${entry.model}`,
  );
}

/** One line on what still stands between a pending specialist and its first task. */
export function specialistPendingSummary(
  registration: Pick<SpecialistRegistration, "access" | "status">,
): string | null {
  if (registration.status === "ready") return null;
  if (registration.status === "removing") return "Removing";
  if (registration.status === "removal-failed") return "Removal failed; retry removal";
  const choose = registration.access.filter(
    ({ state }) => state === "choose" || state === "rebind",
  ).length;
  const missing = registration.access.filter(({ state }) => state === "needs-access").length;
  const parts = [
    choose > 0 ? `${choose} ${choose === 1 ? "choice" : "choices"} to make` : null,
    missing > 0 ? `${missing} ${missing === 1 ? "needs" : "need"} access` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "Setting up";
}

function serviceName(service: string): string {
  const known: Readonly<Record<string, string>> = {
    github: "GitHub",
    gitlab: "GitLab",
    gmail: "Gmail",
    google: "Google",
    "google-calendar": "Google Calendar",
    "google-drive": "Google Drive",
    linear: "Linear",
    notion: "Notion",
    slack: "Slack",
  };
  const id = service.toLowerCase();
  return (
    known[id] ??
    service
      .split(/[-_\s]+/u)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function appName(bundleId: string): string {
  const last = bundleId.split(".").at(-1) ?? bundleId;
  const words = last.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/[-_]+/gu, " ");
  return `${words[0]?.toUpperCase() ?? ""}${words.slice(1)} on a Mac`;
}
