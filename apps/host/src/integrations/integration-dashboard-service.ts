import {
  IntegrationDashboardSchema,
  IntegrationPlatformDashboardSchema,
  type IntegrationDefinitionSummary,
  type IntegrationDefinition,
  type IntegrationAuthorizationSurface,
  type IntegrationDashboard,
  type IntegrationPlatformDashboard,
} from "@opensteer/integration-core";
import {
  type IntegrationDashboardProviderSource,
  type IntegrationDashboardRepository,
} from "@opensteer/integration-core/ports";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import type { UserId } from "@opensteer/core";

export class IntegrationDashboardService {
  readonly #catalog: readonly IntegrationPlatformDashboard["catalog"][number][];
  readonly #providers: IntegrationDashboardProviderSource;
  readonly #repository: IntegrationDashboardRepository;

  constructor(options: {
    readonly definitions: readonly IntegrationDefinition[];
    readonly summarizeDefinition: (
      definition: IntegrationDefinition,
    ) => IntegrationDefinitionSummary;
    readonly providers: IntegrationDashboardProviderSource;
    readonly repository: IntegrationDashboardRepository;
  }) {
    this.#catalog = options.definitions.map((definition) => ({
      definition: options.summarizeDefinition(definition),
      digest: integrationDefinitionDigest(definition),
      installationId: null,
    }));
    this.#providers = options.providers;
    this.#repository = options.repository;
  }

  async providerDashboard(
    ownerUserId: UserId,
    isAdministrator: boolean,
    authorizationSurface: IntegrationAuthorizationSurface,
  ): Promise<IntegrationDashboard> {
    return IntegrationDashboardSchema.parse(
      await this.#providers.dashboard(ownerUserId, isAdministrator, authorizationSurface),
    );
  }

  async platformDashboard(
    ownerUserId: UserId,
    authorizationSurface: IntegrationAuthorizationSurface,
  ): Promise<IntegrationPlatformDashboard> {
    const installations = await this.#repository.listInstallations();
    const entries = await Promise.all(
      installations.map(async (installation) => ({
        installation,
        servers: (await this.#repository.listServers(installation.id)).map(
          ({ transport, ...server }) => ({ ...server, transportType: transport.type }),
        ),
        skills: await this.#repository.listSkills(installation.id),
        tools: await this.#repository.listTools(installation.id, ownerUserId),
      })),
    );
    return IntegrationPlatformDashboardSchema.parse({
      authorizationSurface,
      catalog: this.#catalog.map((entry) => ({
        ...entry,
        installationId:
          installations.find(
            (installation) => installation.provenance.definitionId === entry.definition.id,
          )?.id ?? null,
      })),
      connections: await this.#repository.listMcpOAuthConnections(ownerUserId),
      installations: entries,
    });
  }
}
