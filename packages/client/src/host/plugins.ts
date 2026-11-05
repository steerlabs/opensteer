import { z } from "zod";
import { harnessDriverLabel, type SpecialistRegistration } from "@opensteer/core";

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
