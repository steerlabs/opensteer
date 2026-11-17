import {
  IntegrationConnectionIdSchema,
  IntegrationInstallManifestSchema,
  IntegrationServerIdSchema,
  integrationDefinitionSummary,
  isComputerAppDefinition,
  type IntegrationAccess,
  type IntegrationConnectionId,
  type IntegrationDefinition,
  type IntegrationGrant,
  type IntegrationInstallation,
  type IntegrationInstallManifest,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import type {
  IntegrationPlatformStore,
  PreparedIntegrationInstallFulfillment,
} from "@opensteer/database";
import {
  OpensteerError,
  refused,
  RequestResponseSchema,
  type AgentEvent,
  type Request,
  type RequestId,
  type RequestResponse,
  type RunId,
  type RunnerId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";
import { androidPhoneDefinitionId } from "@opensteer/protocol";
import { computerUseDefinitionId } from "../computer-use/computer-use-service.js";
import type { DeviceService } from "./device-service.js";

/** Who asks: always a Run, whose Request its continuation answers. */
export interface AccessAsker {
  readonly callId: string;
  readonly reason: string;
  readonly requestedBy: UserId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}

type AccessRequestDevices = Pick<
  DeviceService,
  | "listDiscoveryInventory"
  | "prepareDefinition"
  | "verifyConnectionForFulfillment"
  | "withConnectionAdmission"
>;

export type AccessRequestOutcome =
  | { readonly kind: "granted"; readonly access: IntegrationAccess; readonly name: string }
  | { readonly kind: "request"; readonly request: Request; readonly replayed: boolean };

type InventoryEntry = Awaited<ReturnType<IntegrationPlatformStore["listDiscoveryInventory"]>>[number];

/** What agents type for a device data app: its definition id without the vendor prefix. */
export function dataAppName(definition: Pick<IntegrationDefinition, "id">): string {
  return definition.id.replace(/^(?:apple|iphone)-/u, "");
}

/**
 * Asking for, and answering, access to a device data app on a Mac or iPhone or to a local
 * server: one `integration.access` Request, answered on the person's card by installing the
 * device app, choosing its computer or server, and granting access in the same transaction.
 */
export class AccessRequests {
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #devices: AccessRequestDevices;
  readonly #onDeploymentEvent: (event: AgentEvent) => void;
  readonly #store: IntegrationPlatformStore;

  constructor(options: {
    readonly definitions: readonly IntegrationDefinition[];
    readonly devices: AccessRequestDevices;
    readonly onDeploymentEvent: (event: AgentEvent) => void;
    readonly store: IntegrationPlatformStore;
  }) {
    this.#definitions = options.definitions;
    this.#devices = options.devices;
    this.#onDeploymentEvent = options.onDeploymentEvent;
    this.#store = options.store;
  }
  /** The device data apps an agent may name, as it names them. */
  dataApps(): readonly string[] {
    return this.#dataAppDefinitions().map(dataAppName);
  }

  async requestDataApp(
    asker: AccessAsker,
    input: {
      readonly dataApp: string;
      readonly computerId?: RunnerId | undefined;
      readonly access: IntegrationAccess;
    },
  ): Promise<AccessRequestOutcome> {
    const definition = this.#dataAppDefinitions().find(
      (candidate) => dataAppName(candidate) === input.dataApp.toLowerCase(),
    );
    if (!definition)
      throw refused(
        "not_found",
        `No device data app is named ${input.dataApp}. These are: ${this.dataApps().join(", ")}.`,
      );
    const manifest = {
      definition: integrationDefinitionSummary(definition, null),
      digest: integrationDefinitionDigest(definition),
      kind: "catalog" as const,
    };
    const inventory = await this.#inventory(asker);
    const installed = inventory.find(
      ({ installation }) =>
        installation.status === "active" &&
        installation.provenance.definitionId === definition.id &&
        installation.provenance.definitionDigest === manifest.digest,
    );
    if (!installed)
      return this.#create(asker, input.access, {
        installationId: null,
        manifest,
        requestedConnectionId: null,
        requestedServerId: null,
      });
    // A named computer that already runs this app is the account the person raises or grants;
    // otherwise the person chooses the computer on the card.
    let requestedConnectionId: IntegrationConnectionId | null = null;
    if (input.computerId)
      for (const { connectionId } of installed.accounts) {
        const connection = await this.#store.getComputerConnectionForCall({
          connectionId,
          ownerUserId: asker.requestedBy,
        });
        if (connection?.runnerId === input.computerId) requestedConnectionId = connectionId;
      }
    return this.#grantOrRequest(asker, input.access, installed, requestedConnectionId);
  }

  async requestLocalServer(
    asker: AccessAsker,
    input: { readonly server: string; readonly access: IntegrationAccess },
  ): Promise<AccessRequestOutcome> {
    const plugin = (await this.#store.plugins.list()).find(
      ({ name, installedBy }) => name === input.server && installedBy === asker.requestedBy,
    );
    const entry = plugin
      ? (await this.#inventory(asker)).find(
          ({ installation }) => installation.pluginId === plugin.id,
        )
      : undefined;
    if (!entry)
      throw refused(
        "not_found",
        `No local server is named ${input.server}. local_server_list lists the registered names.`,
      );
    return this.#grantOrRequest(asker, input.access, entry, null);
  }

  /** The person's answer on an `integration.access` card. */
  async resolve(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }): Promise<{
    readonly grant: IntegrationGrant | null;
    readonly installation: IntegrationInstallation | null;
    readonly request: Request;
  }> {
    const pending = await this.#store.requests.get(input.requestId);
    if (
      !pending ||
      pending.status !== "pending" ||
      pending.payload?.kind !== "integration.access"
    ) {
      throw new OpensteerError({
        code: "conflict",
        message: "This access Request is no longer pending",
      });
    }
    const request = pending.payload;
    const settlement = input.settlementSessionId
      ? { settlementSessionId: input.settlementSessionId }
      : {};
    const response = RequestResponseSchema.parse(input.response);
    if (response.kind === "choice" && response.optionId.startsWith("server:")) {
      const selected = await this.#store.integrationRequests.selectIntegrationAccessServer({
        requestId: input.requestId,
        resolvedBy: input.resolvedBy,
        ...settlement,
        requestedServerId: IntegrationServerIdSchema.parse(
          response.optionId.slice("server:".length),
        ),
      });
      this.#publish(selected.events);
      return { grant: null, installation: null, request: selected.request };
    }
    if (response.kind === "choice" && response.optionId === "installed") {
      let installed =
        await this.#store.integrationRequests.tryBindExistingIntegrationAccessInstallation(input);
      if (!installed) {
        const manifest =
          await this.#store.integrationRequests.loadIntegrationAccessInstallManifest(input);
        installed = await this.#store.integrationRequests.installForIntegrationAccessRequest({
          requestId: input.requestId,
          resolvedBy: input.resolvedBy,
          ...settlement,
          preparedFulfillment: await this.#prepareInstall(manifest),
        });
      }
      this.#publish(installed.requestEvents);
      return { grant: null, installation: installed.installation, request: installed.request };
    }
    const value = response.kind === "external" ? response.value : undefined;
    const connectionId =
      value?.decision === "fulfilled" && typeof value.connectionId === "string"
        ? IntegrationConnectionIdSchema.parse(value.connectionId)
        : null;
    const resolve = async () => {
      if (connectionId) {
        if (request.installationId === null)
          throw refused("conflict", "Install the app before choosing its computer");
        await this.#devices.verifyConnectionForFulfillment(connectionId, input.resolvedBy, {
          access: request.access,
          installationId: request.installationId as IntegrationInstallation["id"],
          requestedServerId:
            request.requestedServerId === null
              ? null
              : IntegrationServerIdSchema.parse(request.requestedServerId),
        });
      }
      return this.#store.integrationRequests.resolveIntegrationAccessRequest({
        requestId: input.requestId,
        resolvedBy: input.resolvedBy,
        ...settlement,
        response,
      });
    };
    if (
      connectionId &&
      (await this.#store.getConnectionKind({ connectionId, ownerUserId: input.resolvedBy })) !==
        "computer"
    )
      throw new OpensteerError({ code: "forbidden", message: "That computer is unavailable" });
    const resolved = connectionId
      ? await this.#devices.withConnectionAdmission(connectionId, input.resolvedBy, resolve)
      : await resolve();
    this.#publish(resolved.events);
    return { grant: resolved.grant, installation: null, request: resolved.request };
  }

  #dataAppDefinitions() {
    return this.#definitions.filter(
      (definition) =>
        isComputerAppDefinition(definition) &&
        definition.id !== computerUseDefinitionId &&
        definition.id !== androidPhoneDefinitionId,
    );
  }

  async #inventory(asker: AccessAsker) {
    return this.#devices.listDiscoveryInventory({
      ownerUserId: asker.requestedBy,
      threadId: asker.threadId,
    });
  }

  /** A grant that already covers the ask answers it; anything else asks the person. */
  async #grantOrRequest(
    asker: AccessAsker,
    access: IntegrationAccess,
    entry: InventoryEntry,
    requestedConnectionId: IntegrationConnectionId | null,
  ): Promise<AccessRequestOutcome> {
    const requestedServerId = entry.servers.length === 1 ? entry.servers[0]!.id : null;
    const grants = await this.#store.listGrants({ ownerUserId: asker.requestedBy });
    for (const grant of grants) {
      if (
        grant.installationId !== entry.installation.id ||
        grant.status !== "active" ||
        (requestedConnectionId !== null && grant.connectionId !== requestedConnectionId) ||
        (access === "read-write" && grant.access !== "read-write") ||
        !entry.readiness.servers.some(
          (server) =>
            server.code === "READY" &&
            server.connectionId === grant.connectionId &&
            (requestedServerId === null || server.serverId === requestedServerId),
        )
      )
        continue;
      // A computer that only lets agents read cannot answer an ask to change things.
      if (access === "read-write" && grant.connectionId !== null) {
        const connection = await this.#store.getComputerConnectionForCall({
          connectionId: grant.connectionId,
          ownerUserId: asker.requestedBy,
        });
        if (connection?.access === "read") continue;
      }
      return {
        kind: "granted",
        access: grant.access,
        name:
          entry.accounts.find(({ connectionId }) => connectionId === grant.connectionId)
            ?.account ?? entry.installation.title,
      };
    }
    return this.#create(asker, access, {
      installationId: entry.installation.id,
      manifest: null,
      requestedConnectionId,
      requestedServerId,
    });
  }

  async #create(
    asker: AccessAsker,
    access: IntegrationAccess,
    target: {
      readonly installationId: IntegrationInstallation["id"] | null;
      readonly manifest: IntegrationInstallManifest | null;
      readonly requestedConnectionId: IntegrationConnectionId | null;
      readonly requestedServerId: IntegrationInstallation["id"] | string | null;
    },
  ): Promise<AccessRequestOutcome> {
    const created = await this.#store.integrationRequests.createIntegrationAccessRequest({
      access,
      callId: asker.callId,
      installationId: target.installationId,
      manifest: target.manifest,
      originatingRunId: asker.runId,
      originatingThreadId: asker.threadId,
      reason: asker.reason,
      requestedBy: asker.requestedBy,
      requestedConnectionId: target.requestedConnectionId,
      requestedServerId:
        target.requestedServerId === null
          ? null
          : IntegrationServerIdSchema.parse(target.requestedServerId),
    });
    for (const event of created.events) this.#onDeploymentEvent(event);
    return { kind: "request", request: created.request, replayed: created.replayed };
  }

  /** Device apps install only from the definitions this Host ships, exactly as reviewed. */
  async #prepareInstall(manifest: unknown): Promise<PreparedIntegrationInstallFulfillment> {
    const approvalManifest = IntegrationInstallManifestSchema.parse(manifest);
    const definition = this.#dataAppDefinitions().find(
      ({ id }) => id === approvalManifest.definition.id,
    );
    if (!definition || !isComputerAppDefinition(definition))
      throw new OpensteerError({ code: "not_found", message: "That device app is not available" });
    if (integrationDefinitionDigest(definition) !== approvalManifest.digest)
      throw new OpensteerError({
        code: "conflict",
        message: "The device app changed; review the current definition before installing",
      });
    const current = (await this.#store.listInstallations()).find(
      (installation) =>
        installation.sourceKind === "built-in" &&
        installation.provenance.definitionId === definition.id,
    );
    return {
      approvalManifest,
      material: this.#devices.prepareDefinition({ ...(current ? { current } : {}), definition }),
    };
  }

  #publish(events: readonly AgentEvent[]) {
    for (const event of events) this.#onDeploymentEvent(event);
  }
}
