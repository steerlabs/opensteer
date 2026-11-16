import { z } from "zod";

const timestamp = z
  .union([z.string(), z.date()])
  .transform((value) => new Date(value).toISOString());
const PluginRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  scope: z.enum(["deployment", "folder"]),
  enabled: z.boolean(),
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
      }),
    )
    .catch([]),
  servers: z.array(z.unknown()).optional().catch(undefined),
});

export interface PluginSummary {
  readonly id: string;
  readonly name: string;

  readonly scope: "deployment" | "folder";
  readonly enabled: boolean;

  /** The Host folder it was installed from, which Update reads again. */
  readonly directory: string | null;
  /** The package's own version, when its manifest names one. */
  readonly version: string | null;
  /** The installed snapshot, for a package that names no version. */
  readonly digest: string | null;
  readonly description: string | null;
  readonly skills: number;
  readonly servers: number;

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
        enabled: plugin.enabled,
        directory: plugin.source?.directory ?? null,
        version: current?.manifest?.version ?? null,
        digest: current?.digest ?? null,
        description: current?.manifest?.description?.trim() || null,
        skills: current?.manifest?.skills?.length ?? 0,
        servers: plugin.servers?.length ?? 0,
        updatedAt: plugin.updatedAt ?? null,
      },
    ];
  });
}

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
