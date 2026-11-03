import type { SpecialistAccessItem } from "@opensteer/client/host";
import {
  installationDefinition,
  integrationAccountTitle,
  type IntegrationDashboard,
  type IntegrationPlatformDashboardView,
} from "@opensteer/client/integrations";

/** One of the person's own connected accounts that would satisfy a specialist's need. */
export interface AllowOption {
  readonly connectionId: string;
  readonly installationId: string;
  readonly title: string;
}

/**
 * The connected accounts a person could allow a Project to use for one
 * integration a specialist needs, matched the way the Host matches its
 * candidates: by provider or integration id, connected, and not a computer's.
 * Empty means there is nothing to allow yet, so the next step is connecting one.
 */
export function integrationAllowOptions(
  item: Pick<SpecialistAccessItem, "type"> & { readonly service?: string },
  dashboard: Pick<IntegrationDashboard, "connections">,
  platform: Pick<IntegrationPlatformDashboardView, "installations">,
): AllowOption[] {
  if (item.type !== "integration" || item.service === undefined) return [];
  const service = item.service;
  const installations = new Map<string, string>();
  for (const { installation } of platform.installations) {
    if (installation.status !== "active") continue;
    const definition = installationDefinition(installation.manifest);
    if (definition !== null && !installations.has(definition.id)) {
      installations.set(definition.id, installation.id);
    }
  }
  return dashboard.connections.flatMap((connection) => {
    if (connection.status !== "connected" || connection.computer !== null) return [];
    if (connection.provider !== service && connection.definitionId !== service) return [];
    const installationId = installations.get(connection.definitionId);
    return installationId === undefined
      ? []
      : [
          {
            connectionId: connection.id,
            installationId,
            title: integrationAccountTitle(connection),
          },
        ];
  });
}

/** "AB" for "Ada Byron": the face a member row shows in place of a photo. */
export function memberInitials(name: string): string {
  return (
    name
      .split(/\s+/u)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
