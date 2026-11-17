import { integrationBlocked } from "../../integrations/integration-blocked.js";
import {
  AppAccessRequestInputSchema,
  RequestUnionSchema,
} from "@opensteer/agent-tools/integrations";

import {
  integrationAccountLabel,
  integrationDefinitionSummary,
  integrationSearchTerms,
  isComputerAppDefinition,
  searchIntegrationInventory,
  type IntegrationDefinition,
  type IntegrationInstallation,
  type IntegrationAccess,
  type IntegrationConnectionId,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import { integrationToolSignature } from "@opensteer/integration-core/tool-signature";
import type { IntegrationRequester, CallableIntegrationTool } from "@opensteer/database";
import { androidPhoneDefinitionId, computerUseToolRequiredSentence } from "@opensteer/protocol";
import { computerUseDefinitionId } from "../../computer-use/computer-use-service.js";
import {
  RunnerIdSchema,
  formatReferenceLink,
  UserIdSchema,
  OpensteerError,
  ToolBlockedError,
  refused,
  type AgentEvent,
  type Request,
  type RunId,
  type TriggerOccurrenceId,
  type ThreadId,
  type UserId,
} from "@opensteer/core";

import {
  describedOperation,
  operationAddress,
  resolveOperation,
  type OperationResolution,
} from "../../integrations/integration-operation.js";
import { renderIntegrationDescribe } from "../../integrations/integration-describe.js";

import { z } from "zod";
import type { RunCapabilityClaims } from "../../agents/run-capability.js";
import type { TriggerCapabilityClaims } from "../../triggers/trigger-control-service.js";
import type { WatchCapabilityClaims } from "../../triggers/watch-capability.js";
import {
  type IntegrationPlatformService,
  type IntegrationProposalRefusal,
  type IntegrationProposalSelectedAuth,
} from "../../integrations/integration-platform-service.js";

import {
  computerAppRequestShape,
  noComputerUseMac,
  noPhone,
  phoneRequestShape,
  unknownComputerUseMac,
  unknownPhone,
} from "../../integrations/computer-use-discovery.js";

import { DescribeInputSchema, ProposeInputSchema } from "@opensteer/agent-tools/integrations";
import type { ToolCall } from "./types.js";
import { type AgentCaller } from "../agent-caller.js";
import { requireRun, operationId } from "../operations.js";

export type IntegrationToolsRunScope = RunCapabilityClaims<string>;
export type IntegrationToolsTriggerScope =
  TriggerCapabilityClaims<"opensteer-trigger-integration-tools">;
type IntegrationToolsScope = IntegrationToolsRunScope | IntegrationToolsTriggerScope;
type IntegrationToolsWatchScope = WatchCapabilityClaims<"opensteer-watch-integration-tools"> & {
  readonly requestedBy: UserId;
  readonly threadId: ThreadId;
  readonly watchActivationId: string;
};
type AnyIntegrationToolsScope = IntegrationToolsScope | IntegrationToolsWatchScope;

type IntegrationReadScope =
  | AnyIntegrationToolsScope
  | {
      readonly requestedBy: UserId;
      readonly connectionId: string;
      readonly threadId?: never;
    };
function discoveryRequester(scope: IntegrationReadScope): IntegrationRequester {
  const common = { ownerUserId: scope.requestedBy };
  return "connectionId" in scope
    ? { ...common, connectionId: scope.connectionId }
    : { ...common, threadId: scope.threadId };
}
type DiscoveryInventoryEntry = Awaited<
  ReturnType<IntegrationPlatformService["listDiscoveryInventory"]>
>[number];
export class IntegrationToolHandlers {
  readonly #definitions: readonly IntegrationDefinition[];
  readonly #onEvent: (event: AgentEvent) => void;
  readonly #platform: IntegrationPlatformService;
  constructor(options: {
    readonly definitions: readonly IntegrationDefinition[];
    readonly onEvent: (event: AgentEvent) => void;
    readonly platform: IntegrationPlatformService;
  }) {
    this.#definitions = options.definitions;
    this.#onEvent = options.onEvent;
    this.#platform = options.platform;
  }

  async #readScope(caller: AgentCaller): Promise<IntegrationReadScope> {
    return caller.kind === "connection"
      ? this.#platform.store.connectionDiscoveryScope(caller.userId, caller.connectionId)
      : integrationScope(caller);
  }
  async authorizeCall(call: ToolCall<"integration_call">): Promise<void> {
    await this.#resolveCallableTool(integrationScope(call.caller), call.input, true);
  }
  async integration_search(call: ToolCall<"integration_search">) {
    const input = call.input;
    return structured(
      await this.#search(
        await this.#readScope(call.caller),
        input.query,
        input.limit,
        input.cursor ?? 0,
        input.provider,
        input.computerId,
      ),
    );
  }
  async integration_describe(call: ToolCall<"integration_describe">) {
    const result = await this.#describe(await this.#readScope(call.caller), call.input);
    return result.content.map((c) => c.text).join("\n");
  }
  async integration_call(call: ToolCall<"integration_call">) {
    return this.#call(
      integrationScope(call.caller),
      call.input,
      call.input.arguments,
      call.signal ?? AbortSignal.timeout(100_000),
    );
  }
  async integration_request(call: ToolCall<"integration_request">) {
    const { operationKey: _operationKey, ...input } = call.input;
    return structured(
      await this.#request(
        integrationScope(call.caller),
        RequestUnionSchema.parse(input),
        operationId(call.caller, call.operationKey, "integration_request"),
      ),
    );
  }
  async app_access_request(call: ToolCall<"app_access_request">) {
    const { operationKey: _operationKey, ...input } = call.input;
    const scope = integrationScope(call.caller);
    const callId = operationId(call.caller, call.operationKey, "app_access_request");
    return structured(
      (await this.#replay(scope, callId)) ?? (await this.#requestComputerApp(scope, input, callId)),
    );
  }
  async custom_integration_request(call: ToolCall<"custom_integration_request">) {
    return structured(
      await this.#propose(
        integrationScope(call.caller),
        call.input,
        operationId(call.caller, call.operationKey, "custom_integration_request"),
      ),
    );
  }
  async computer_use(call: ToolCall<"computer_use">) {
    const run = requireRun(call.caller).claims;
    if (!(await this.#platform.computerToolEnabled(run)))
      throw refused(
        "conflict",
        "computer_use is not available on this computer yet. Update Opensteer on it to use it.",
      );
    return this.#platform.runComputerCode(
      { run, threadId: run.threadId },
      call.input.code,
      call.signal ?? AbortSignal.timeout(100_000),
    );
  }
  async #describe(scope: IntegrationReadScope, input: z.infer<typeof DescribeInputSchema>) {
    const reachable = await this.#platform.listCallableTools({ ...discoveryRequester(scope) });
    const resolution = resolveOperation(reachable, input.operation, input.account);
    const callable =
      describedOperation(resolution) ?? (await this.#refuseOperation(scope, input, resolution));
    const stored = await this.#platform.store.getToolSchemas(callable.tool.id);
    if (
      !stored ||
      stored.status !== "active" ||
      stored.schemaDigest !== callable.tool.schemaDigest
    ) {
      throw refused("conflict", "Integration operation changed; search again");
    }
    const account = callable.grant.connectionId
      ? await this.#platform.store.getConnectionAccount({
          connectionId: callable.grant.connectionId,
          ownerUserId: UserIdSchema.parse(callable.grant.ownerUserId),
        })
      : null;
    const text = renderIntegrationDescribe({
      cursor: input.cursor,
      described: {
        account: {
          alias: account ? integrationAccountLabel(account) : callable.grant.alias,
          connectionId: callable.grant.connectionId,
          isDefault: callable.grant.isDefault,
        },
        integration: {
          description: callable.installation.description,
          name: callable.installation.name,
          title: callable.installation.title,
          trust: callable.installation.trust,
        },
        operation: {
          annotations: callable.tool.annotations,
          description: callable.tool.description,
          name: callable.tool.name,
          title: callable.tool.title,
        },
      },
      path: input.path,
      schemas: stored,
    });
    return { content: [{ text, type: "text" as const }] };
  }

  async #call(
    scope: AnyIntegrationToolsScope,
    address: OperationAddress,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ) {
    const callable = await this.#resolveCallableTool(scope, address, true);
    return this.#platform.callTool(
      callable,
      args,
      {
        // A Trigger occurrence and a watch program produce no Run, and the one
        // transport that needs one refuses rather than inventing it.
        run: "runId" in scope ? scope : null,
        threadId: scope.threadId,
      },
      signal,
    );
  }

  async #resolveCallableTool(
    scope: IntegrationReadScope,
    address: OperationAddress,
    computerCall = false,
  ): Promise<CallableIntegrationTool> {
    const callable = await this.#platform.listCallableTools({
      ...discoveryRequester(scope),
    });
    const resolution = resolveOperation(callable, address.operation, address.account);
    if (resolution.kind !== "found") {
      return this.#refuseOperation(scope, address, resolution, computerCall);
    }
    const selected = resolution.callable;
    if (
      computerCall &&
      selected.server.transport.type === "computer" &&
      [computerUseDefinitionId, androidPhoneDefinitionId].includes(
        selected.server.transport.definitionId,
      )
    )
      throw refused("bad_request", computerUseToolRequiredSentence);
    return selected;
  }

  /** Says why an address reached nothing, and what the agent can do about it. */
  async #refuseOperation(
    scope: IntegrationReadScope,
    { account, operation }: OperationAddress,
    resolution: OperationResolution,
    computerCall = false,
  ): Promise<never> {
    if (resolution.kind === "account-required") {
      const accounts = resolution.candidates.map(
        ({ grant }) => `${grant.connectionId} (${grant.alias})`,
      );
      throw refused(
        "bad_request",
        `Choose the account for ${operation}: pass account as one of ${accounts.join(", ")}.`,
      );
    }
    if (resolution.kind === "ambiguous") {
      throw refused(
        "bad_request",
        `${operation} names more than one operation; use one of ${resolution.operations.join(", ")}.`,
      );
    }
    if (resolution.kind === "changed") {
      throw refused("conflict", "Integration operation changed; search again");
    }
    const [inventory, grants] = await Promise.all([
      this.#platform.listDiscoveryInventory({
        ...discoveryRequester(scope),
      }),
      this.#platform.store.listGrants({
        ownerUserId: scope.requestedBy,
      }),
    ]);
    const plainName = operation.split("@", 1)[0];
    const named = (name: string) => name === plainName;
    const located = inventory.flatMap((entry) => {
      const definitionId = installationDefinitionId(entry.installation);
      const definition = this.#definitions.find(({ id }) => id === definitionId);
      // A connection narrowed to reading loses its write tools, so only the
      // definition still knows that this name is a write.
      const computerWrite =
        definition && isComputerAppDefinition(definition)
          ? definition.config.operations.find(
              ({ effect, name }) => effect === "write" && named(name),
            )
          : undefined;
      const tool = entry.tools.find(
        ({ connectionId, name }) =>
          named(name) &&
          (connectionId === null || account === undefined || connectionId === account),
      );
      if (!tool && !computerWrite) return [];
      const grant = grants.find(
        ({ connectionId, installationId }) =>
          installationId === entry.installation.id &&
          (account === undefined || connectionId === account),
      );
      return [{ computerWrite, definitionId, entry, grant, tool }];
    });
    const match = located.find(({ grant }) => grant !== undefined) ?? located[0];
    // A retired Computer use tool has no row left, but its account still says what it was.
    const accountEntry = inventory.find(({ installation }) =>
      grants.some(
        ({ connectionId, installationId }) =>
          connectionId === account && installationId === installation.id,
      ),
    );
    const definitionId =
      match?.definitionId ?? (accountEntry && installationDefinitionId(accountEntry.installation));
    if (
      computerCall &&
      [computerUseDefinitionId, androidPhoneDefinitionId].includes(definitionId ?? "")
    )
      throw refused("bad_request", computerUseToolRequiredSentence);
    if (match?.tool) {
      const readiness = match.entry.readiness.tools.find(
        ({ toolId }) => toolId === match.tool?.id,
      )?.readiness;
      const blocked = integrationBlocked(readiness, match.entry.installation.name);
      if (blocked) throw new ToolBlockedError(blocked);
    }
    if (match?.grant) {
      const { computerWrite, definitionId, entry, grant } = match;
      if (computerWrite && grant.connectionId) {
        const connection = await this.#platform.store.getComputerConnectionForCall({
          connectionId: grant.connectionId,
          ownerUserId: scope.requestedBy,
        });
        if (connection?.access === "read") {
          throw refused(
            "forbidden",
            definitionId === androidPhoneDefinitionId
              ? `${connection.runnerName} allows seeing only. Ask for read-write to act: call ${phoneRequestShape} with access "read-write"; do not retry this call until it is fulfilled.`
              : `${connection.runnerName} allows reading only. Ask for read-write to send: call integration_request with integration "${entry.installation.name}" and access "read-write"; do not retry this call until it is fulfilled.`,
          );
        }
      }
    }
    throw refused("not_found", "Integration operation is no longer available; search again");
  }

  async #search(
    scope: IntegrationReadScope,
    query: string,
    limit: number,
    offset: number,
    provider?: string,
    runnerId?: z.infer<typeof RunnerIdSchema>,
  ) {
    const nextCursor = (more: boolean) => (more ? String(offset + limit) : null);
    const access = await this.#platform.computerAccess(
      discoveryRequester(scope),
      "runId" in scope ? scope : undefined,
    );
    if (runnerId) {
      const inventory = access;
      const machine = inventory.machines.find((machine) => machine.runnerId === runnerId);
      const phone = inventory.phones.find((phone) => phone.runnerId === runnerId);
      if (phone) {
        const installed = await this.#platform.computerAppApprovals.installedComputerApps(
          {
            actorUserId: scope.requestedBy,
            runnerId,
            query,
            limit,
            offset,
            definitionId: androidPhoneDefinitionId,
          },
          inventory.phones,
        );
        const output = {
          apps: installed.apps,
          total: installed.total,
          nextCursor: nextCursor(offset + installed.apps.length < installed.total),
        };
        return {
          content: [{ text: JSON.stringify(output), type: "text" as const }],
          structuredContent: output,
        };
      }
      if (!machine) throw refused("not_found", unknownComputerUseMac(runnerId));
      const installed = await this.#platform.computerAppApprovals.installedComputerApps(
        {
          actorUserId: scope.requestedBy,
          runnerId,
          query,
          limit,
          offset,
          icons: false,
        },
        inventory.machines,
      );
      const apps = installed.apps.map(({ identity }) => ({
        name: identity.displayName,
        bundleId: identity.bundleId,
        ...access.app(machine, identity),
      }));
      const output = {
        computer: {
          computerId: runnerId,
          name: machine.name,
          ...access.machine(machine),
          apps,
        },
        total: installed.total,
        nextCursor: nextCursor(offset + apps.length < installed.total),
      };
      return {
        content: [{ text: JSON.stringify(output), type: "text" as const }],
        structuredContent: output,
      };
    }
    const [inventory, callable] = await Promise.all([
      this.#platform.listDiscoveryInventory({
        ...discoveryRequester(scope),
      }),
      Promise.resolve(access.tools),
    ]);
    const definitionById = new Map(
      this.#definitions.map((definition) => [definition.id, definition]),
    );
    const filtered = provider
      ? inventory.filter(({ installation, servers }) => {
          const definitionId = installationDefinitionId(installation);
          return (
            definitionById.get(definitionId ?? "")?.provider === provider ||
            servers.some(
              ({ connectionRequirement }) =>
                connectionRequirement.kind === "provider" &&
                connectionRequirement.provider === provider,
            )
          );
        })
      : inventory;
    const matchingOperations = searchCallableTools(
      callable.filter(
        (operation) =>
          !(
            operation.server.transport.type === "computer" &&
            [computerUseDefinitionId, androidPhoneDefinitionId].includes(
              operation.server.transport.definitionId,
            )
          ) && callableToolMatchesProvider(operation, provider, definitionById),
      ),
      query,
    );
    const operationRows = groupedOperations(matchingOperations);
    const operations = await Promise.all(
      operationRows.slice(offset, offset + limit).map(async (row) => {
        const [operation] = row as readonly [CallableIntegrationTool];
        const stored = await this.#platform.store.getToolSchemas(operation.tool.id);
        const accounts = row.flatMap(({ grant }) => grant.connectionId ?? []);
        const shownAccounts =
          inventory.find(({ installation }) => installation.id === operation.installation.id)
            ?.accounts.length ?? 0;
        return {
          // Only when `results` shows an account this operation does not work on.
          ...(accounts.length > 0 && accounts.length < shownAccounts ? { accounts } : {}),
          description: toolSummary(operation.tool),
          effect: integrationToolEffect(operation.tool.annotations),
          ...(stored ? { input: integrationToolSignature(stored) } : {}),
          // Titles can repeat; this is the `name` of its entry in `results`.
          installation: operation.installation.name,
          name: operationAddress(operation),
        };
      }),
    );
    const searched = (
      query.length > 0 ? searchIntegrationInventory(filtered, query, 20) : filtered
    ).filter(
      (entry) =>
        ![computerUseDefinitionId, androidPhoneDefinitionId].includes(
          installationDefinitionId(entry.installation) ?? "",
        ),
    );
    const matches = searched.slice(offset, offset + limit);
    const terms = integrationSearchTerms(query);
    // An operation row names its accounts here, so its integration is always shown.
    const shownInstallations = new Set(matches.map(({ installation }) => installation.id));
    const installationsWithRows = new Set(
      operationRows.slice(offset, offset + limit).map((row) => row[0]!.installation.id),
    );
    const results = [
      ...matches,
      ...filtered.filter(
        ({ installation }) =>
          installationsWithRows.has(installation.id) && !shownInstallations.has(installation.id),
      ),
    ].map(({ accounts, installation, readiness, servers, tools }) => {
      // Callable operations are already rows above; these are the ones an agent
      // can only reach by asking for access or fixing a connection.
      const blocked = tools.flatMap((tool) => {
        const toolReadiness = readiness.tools.find(({ toolId }) => toolId === tool.id)?.readiness;
        if (!toolReadiness || toolReadiness.code === "READY") return [];
        const relevance = terms.filter(
          (term) => operationTermQuality(tool.name, term) + operationTermQuality(tool.title, term),
        ).length;
        return [{ relevance, tool, toolReadiness }];
      });
      return {
        accounts,
        integration: installation.title,
        name: installation.name,
        installationId: installation.id,
        servers: servers.map((server) => ({
          ...blockedFields(
            readiness.servers.find(({ serverId }) => serverId === server.id),
            installation.name,
          ),
          server: server.name,
          serverId: server.id,
          ...(readiness.servers.find(({ serverId }) => serverId === server.id)?.connectionId
            ? {
                connectionId: readiness.servers.find(({ serverId }) => serverId === server.id)!
                  .connectionId,
              }
            : {}),
        })),
        ...(blocked.length > 0
          ? {
              tools: blocked
                .sort((left, right) => right.relevance - left.relevance)
                .slice(0, maximumBlockedTools)
                .map(({ tool, toolReadiness }) => ({
                  effect: integrationToolEffect(tool.annotations),
                  name: tool.name,
                  ...blockedFields(toolReadiness, installation.name),
                  serverId: toolReadiness.serverId,
                  ...(toolReadiness.connectionId
                    ? { connectionId: toolReadiness.connectionId }
                    : {}),
                  ...(tool.title !== tool.name ? { title: tool.title } : {}),
                })),
            }
          : {}),
      };
    });
    const installedByDefinitionId = new Map(
      inventory.flatMap((entry) => {
        const definitionId = installationDefinitionId(entry.installation);
        return definitionId ? ([[definitionId, entry]] as const) : [];
      }),
    );
    const { machines: computers, phones } = access;
    // Every definition stays listed, so nothing is withheld because the wording
    // missed it; only what the search concerns carries its details.
    const concerns = (definition: IntegrationDefinition) => {
      const installed = installedByDefinitionId.get(definition.id);
      return (
        (provider !== undefined && definition.provider === provider) ||
        (installed !== undefined && installed.installation.status !== "active") ||
        terms.some((term) =>
          [definition.id, definition.name, definition.description].some(
            (value) => operationTermQuality(value, term) > 0,
          ),
        )
      );
    };
    const catalog = orderedCatalog(this.#definitions, provider).map((definition) =>
      !concerns(definition)
        ? { definitionId: definition.id }
        : {
            ...catalogEntry(definition, installedByDefinitionId.get(definition.id)),
            ...(definition.id === "macos-app"
              ? {
                  computers: computers.map((machine) => ({
                    computerId: machine.runnerId,
                    name: machine.name,
                    ...access.machine(machine),
                    apps: access.appEntries(machine).map(({ name, bundleId, access, blocked }) => ({
                      name,
                      bundleId,
                      ...(blocked ? { blocked } : { access }),
                    })),
                  })),
                }
              : definition.id === androidPhoneDefinitionId
                ? {
                    phones: phones.map((phone) => ({
                      computerId: phone.runnerId,
                      name: phone.name,
                      ...access.phone(phone),
                    })),
                  }
                : {}),
          },
    );
    const concerned = (id: string) =>
      this.#definitions.some((definition) => definition.id === id && concerns(definition));
    const guidance = {
      ...(operations.length === 0 ? { catalog: catalogSearchGuidance } : {}),
      ...(concerned(computerUseDefinitionId) && !computers.length
        ? { computers: noComputerUseMac }
        : {}),
      ...(concerned(androidPhoneDefinitionId) && !phones.length ? { phones: noPhone } : {}),
    };
    const output = {
      ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
      catalog,
      nextCursor: nextCursor(
        offset + matches.length < searched.length ||
          offset + operations.length < operationRows.length,
      ),
      operationTotal: operationRows.length,
      operations,
      results,
      total: searched.length,
    };
    return {
      content: [{ text: JSON.stringify(output), type: "text" as const }],
      structuredContent: output,
    };
  }

  async #propose(
    scope: AnyIntegrationToolsScope,
    input: z.infer<typeof ProposeInputSchema>,
    callId: string,
  ) {
    const { access, check, credential, description, kind, name, reason, source } = input;
    const origin = requestOrigin(scope);
    const replay = await this.#platform.store.requests.findByCallIdentity({ ...origin, callId });
    if (replay) {
      if (replay.kind !== "integration.install" && replay.kind !== "integration.access") {
        throw new Error("MCP call identity belongs to another Request kind");
      }
      return integrationRequestResult(replay, true, scope);
    }
    const outcome = await this.#platform.propose({
      ...(kind ? { kind } : {}),
      source,
      ...(credential ? { credential } : {}),
      ...(check ? { check } : {}),
      ...(name === undefined ? {} : { name }),
      description,
    });
    if (outcome.status === "unsupported") return proposalRefusalResult(outcome);
    const manifest = { kind: "proposal" as const, proposal: outcome.manifest };
    const requestInput = {
      ...origin,
      callId,
      manifest,
      originatingThreadId: scope.threadId,
      reason,
      requestedBy: scope.requestedBy,
    };
    const created = access
      ? await this.#platform.store.requests.createIntegrationAccessRequest({
          ...requestInput,
          access,
          installationId: null,
          requestedConnectionId: null,
          requestedServerId: null,
        })
      : await this.#platform.store.requests.createIntegrationInstallRequest(requestInput);
    for (const event of created.events) this.#onEvent(event);
    return integrationRequestResult(created.request, created.replayed, scope, {
      ...(outcome.authNote === undefined ? {} : { authNote: outcome.authNote }),
      selectedAuth: outcome.selectedAuth,
    });
  }

  /** A retried ask answers with the Request it already opened. */
  async #replay(scope: AnyIntegrationToolsScope, callId: string) {
    const replay = await this.#platform.store.requests.findByCallIdentity({
      ...requestOrigin(scope),
      callId,
    });
    if (!replay) return null;
    if (
      replay.kind !== "integration.access" &&
      replay.kind !== "integration.install" &&
      replay.kind !== "computer.app.access"
    ) {
      throw new Error("MCP call identity belongs to another Request kind");
    }
    return integrationRequestResult(replay, true, scope);
  }

  async #request(
    scope: AnyIntegrationToolsScope,
    input: z.infer<typeof RequestUnionSchema>,
    callId: string,
  ) {
    const origin = requestOrigin(scope);
    const replay = await this.#replay(scope, callId);
    if (replay) return replay;
    if ("catalog" in input) {
      if (input.catalog === computerUseDefinitionId)
        throw refused("bad_request", computerUseRequestRefusal);
      if (input.catalog === androidPhoneDefinitionId)
        throw refused("bad_request", phoneRequestRefusal);
      const definition = this.#definitions.find((candidate) => candidate.id === input.catalog);
      if (!definition) {
        throw refused(
          "not_found",
          `No catalog definition with id "${input.catalog}" exists on this Deployment.`,
        );
      }
      const requestInput = {
        ...origin,
        callId,
        manifest: {
          definition: integrationDefinitionSummary(definition),
          digest: integrationDefinitionDigest(definition),
          kind: "catalog" as const,
        },
        originatingThreadId: scope.threadId,
        reason: input.reason,
        requestedBy: scope.requestedBy,
      };
      const inventory = input.access
        ? await this.#platform.listDiscoveryInventory({
            ownerUserId: scope.requestedBy,
            threadId: scope.threadId,
          })
        : [];
      const installed = inventory.find(
        ({ installation }) =>
          installation.status === "active" &&
          installation.provenance.definitionId === definition.id &&
          installation.provenance.definitionDigest === requestInput.manifest.digest,
      );
      const created = input.access
        ? await this.#platform.store.requests.createIntegrationAccessRequest({
            ...requestInput,
            access: input.access,
            manifest: installed ? null : requestInput.manifest,
            installationId: installed?.installation.id ?? null,
            requestedConnectionId: null,
            requestedServerId: installed?.servers.length === 1 ? installed.servers[0]!.id : null,
          })
        : await this.#platform.store.requests.createIntegrationInstallRequest(requestInput);
      for (const event of created.events) this.#onEvent(event);
      return integrationRequestResult(created.request, created.replayed, scope);
    }
    const inventory = await this.#platform.listDiscoveryInventory({
      ownerUserId: scope.requestedBy,
      threadId: scope.threadId,
    });
    const selected = inventory.find(
      ({ installation }) =>
        installation.id === input.integration || installation.name === input.integration,
    );
    if (!selected) throw refused("not_found", `Unknown integration "${input.integration}".`);
    // Each app is its own account, so an ask that names no account names no
    // app: it could neither add one nor say which one to grant.
    if (
      installationDefinitionId(selected.installation) === computerUseDefinitionId &&
      input.account === undefined
    ) {
      throw refused("bad_request", computerUseRequestRefusal);
    }
    // Each phone is its own account too, so an ask that names none names no phone.
    if (
      installationDefinitionId(selected.installation) === androidPhoneDefinitionId &&
      input.account === undefined
    ) {
      throw refused("bad_request", phoneRequestRefusal);
    }
    if (selected.installation.status !== "active") {
      throw refused("conflict", `Integration "${input.integration}" is inactive.`);
    }
    const access = input.access;
    const accountServers = input.account
      ? [
          ...new Set(
            selected.readiness.servers
              .filter(({ connectionId }) => connectionId === input.account)
              .map(({ serverId }) => serverId),
          ),
        ]
      : [];
    const accountServer = accountServers.length === 1 ? accountServers[0] : undefined;
    if (
      input.account &&
      !selected.accounts.some(({ connectionId }) => connectionId === input.account)
    ) {
      throw refused(
        "not_found",
        "The requested account is not available for this integration. Search again for its current account identity.",
      );
    }
    if (input.server && !selected.servers.some(({ id }) => id === input.server)) {
      throw refused("bad_request", "The requested server does not belong to this integration.");
    }
    if (input.server && accountServers.length > 0 && !accountServers.includes(input.server)) {
      throw refused(
        "bad_request",
        "The requested account belongs to a different integration server.",
      );
    }
    const requestedServerId =
      input.server ??
      accountServer ??
      (selected.servers.length === 1 ? selected.servers[0]!.id : null);
    const grants = await this.#platform.store.listGrants({
      ownerUserId: scope.requestedBy,
    });
    // A grant only answers the ask while its account still works: a broken
    // account must reach the reconnect path this same tool offers.
    const existing = await findAsync(
      grants,
      async (grant) =>
        grant.installationId === selected.installation.id &&
        (input.account === undefined || grant.connectionId === input.account) &&
        (access === "read" || grant.access === "read-write") &&
        selected.readiness.servers.some(
          (server) =>
            server.code === "READY" &&
            server.connectionId === grant.connectionId &&
            (requestedServerId === null || server.serverId === requestedServerId),
        ) &&
        (access === "read" ||
          grant.connectionId === null ||
          (
            await this.#platform.store.getComputerConnectionForCall({
              connectionId: grant.connectionId,
              ownerUserId: scope.requestedBy,
            })
          )?.access !== "read"),
    );
    if (existing) {
      return integrationAlreadyGrantedResult(
        existing.access,
        selected.installation.title,
        selected.accounts.find(({ connectionId }) => connectionId === existing.connectionId)
          ?.account ?? existing.alias,
      );
    }
    const created = await this.#platform.store.requests.createIntegrationAccessRequest({
      ...origin,
      access,
      callId,
      installationId: selected.installation.id,
      requestedConnectionId: input.account ?? null,
      originatingThreadId: scope.threadId,
      reason: input.reason,
      requestedServerId,
      requestedBy: scope.requestedBy,
    });
    for (const event of created.events) this.#onEvent(event);
    return integrationRequestResult(created.request, created.replayed, scope);
  }

  /**
   * Asks for one app on one Mac, or for a whole phone.
   *
   * Which Mac is decided here rather than by the model: the id it named when
   * it named one, otherwise the Mac this task is already running on, and
   * otherwise nothing — a Deployment with several Macs is a choice a person
   * makes, so the refusal names the eligible ones instead of picking. A phone
   * is always named by its id, because nothing a task runs on is a phone.
   */
  async #requestComputerApp(
    scope: AnyIntegrationToolsScope,
    input: Omit<z.infer<typeof AppAccessRequestInputSchema>, "operationKey">,
    callId: string,
  ) {
    if (!("runId" in scope)) {
      throw refused(
        "forbidden",
        "A session on a computer belongs to a running task, so only a task can ask for one.",
      );
    }
    if (input.app === undefined) return this.#requestPhone(scope, input, callId);
    const app = input.app;
    const { machines: macs, phones } =
      await this.#platform.computerAppApprovals.computerUseInventory(scope.requestedBy);
    const named = input.computerId
      ? macs.find(({ runnerId }) => runnerId === input.computerId)
      : (macs.find(({ runnerId }) => runnerId === scope.runnerId) ??
        (macs.length === 1 ? macs[0] : undefined));
    if (!named) {
      const phone = input.computerId
        ? phones.find(({ runnerId }) => runnerId === input.computerId)
        : undefined;
      if (phone) {
        throw refused(
          "bad_request",
          `${phone.name} is an Android phone, which is asked for whole: call ${phoneRequestShape} without app.`,
        );
      }
      const eligible = macs;
      if (eligible.length === 0) {
        throw refused("conflict", noComputerUseMac);
      }
      throw refused(
        "bad_request",
        input.computerId
          ? `That computer is not one of yours set up for computer use. These are: ${eligible.map(({ name }) => name).join(", ")}.`
          : `This task is not running on a Mac set up for computer use, so name one with computerId. These are set up: ${eligible
              .map(({ name, runnerId }) => `${name} (${runnerId})`)
              .join(", ")}.`,
      );
    }
    const created = await this.#platform.computerAppApprovals.requestComputerAppAccess({
      access: input.access,
      app,
      reason: input.reason,
      callId,
      originatingRunId: scope.runId,
      ownerUserId: scope.requestedBy,
      runnerId: named.runnerId,
      threadId: scope.threadId,
    });
    return computerAccessResult(created, scope);
  }

  /**
   * Asks for a whole phone, which only ever means one of this person's
   * phones on this Deployment, named by its id: nothing here picks a phone,
   * and a phone of somebody else's is the same unknown id as a typo.
   */
  async #requestPhone(
    scope: IntegrationToolsRunScope,
    input: Omit<z.infer<typeof AppAccessRequestInputSchema>, "operationKey">,
    callId: string,
  ) {
    const { machines, phones } = await this.#platform.computerAppApprovals.computerUseInventory(
      scope.requestedBy,
    );
    const phone = phones.find(({ runnerId }) => runnerId === input.computerId);
    if (!phone) {
      const mac = machines.find(({ runnerId }) => runnerId === input.computerId);
      throw refused(
        "bad_request",
        mac
          ? `${mac.name} is a Mac, whose apps are asked for one at a time: call ${computerAppRequestShape}.`
          : phones.length === 0
            ? noPhone
            : unknownPhone(input.computerId ?? ""),
      );
    }
    const created = await this.#platform.computerAppApprovals.requestComputerAppAccess({
      access: input.access,
      app: null,
      reason: input.reason,
      callId,
      originatingRunId: scope.runId,
      ownerUserId: scope.requestedBy,
      runnerId: phone.runnerId,
      threadId: scope.threadId,
    });
    return computerAccessResult(created, scope);
  }
}
const computerUseRequestRefusal = `Computer use is requested one app at a time: call ${computerAppRequestShape}.`;

const phoneRequestRefusal = `An Android phone is requested one phone at a time: call ${phoneRequestShape}.`;

/** What a task's ask for an app or a phone answers, pending or ready for computer. */
function computerAccessResult(
  created: Awaited<
    ReturnType<IntegrationPlatformService["computerAppApprovals"]["requestComputerAppAccess"]>
  >,
  scope: AnyIntegrationToolsScope,
) {
  if (created.status === "pending") {
    return integrationRequestResult(created.request, created.replayed, scope);
  }
  const output = {
    kind: "computer.app.access",
    requestId: null,
    status: "fulfilled",
    computerId: created.computerId,
    computer: created.computer,
    app: created.app,
    next: created.app
      ? `${created.app.displayName} on ${created.computer} is ready. Use app(${JSON.stringify(created.app.displayName)}, {computer:${JSON.stringify(created.computer)}}) in computer_use.`
      : `${created.computer} is ready. Use phone(${JSON.stringify(created.computerId)}) in computer_use.`,
  };
  return {
    content: [{ text: JSON.stringify(output), type: "text" as const }],
    structuredContent: output,
  };
}

/**
 * A refused proposal is a normal tool result, not a protocol error: the agent has to read the
 * reason and search the complete catalog to choose its next move, and no Request row exists.
 */
function proposalRefusalResult(refusal: IntegrationProposalRefusal) {
  const result = {
    requestId: null,
    kind: "integration.install",
    next: "No installation was requested. Call integration_search to inspect the complete catalog; if no built-in fits, find a supported API-credential source or tell the person the reported limitation.",
    catalogAlternatives: refusal.catalogAlternatives,
    detectedAuth: refusal.detectedAuth,
    reason: refusal.reason,
    status: "fulfilled",
  };
  return {
    content: [{ text: JSON.stringify(result), type: "text" as const }],
    structuredContent: result,
  };
}

/**
 * Requests are keyed by the execution that opened them. A Trigger Occurrence
 * produces no Run, so it is the origin — and the call-identity subject — in its
 * own right.
 */
function requestOrigin(
  scope: AnyIntegrationToolsScope,
):
  { readonly originatingRunId: RunId } | { readonly originatingOccurrenceId: TriggerOccurrenceId } {
  if ("watchActivationId" in scope) {
    throw new OpensteerError({
      code: "forbidden",
      message: "Watch programs cannot create integration access Requests",
    });
  }
  return "runId" in scope
    ? { originatingRunId: scope.runId }
    : { originatingOccurrenceId: scope.occurrenceId };
}

function integrationRequestResult(
  request: Pick<Request, "id" | "kind" | "status">,
  replayed: boolean,
  scope: AnyIntegrationToolsScope,
  proposal?: {
    readonly authNote?: string;
    readonly selectedAuth: IntegrationProposalSelectedAuth;
  },
) {
  if (
    request.kind !== "integration.access" &&
    request.kind !== "integration.install" &&
    request.kind !== "computer.app.access"
  ) {
    throw new Error("Integration Request result requires an integration Request");
  }
  const result = {
    ...(proposal === undefined
      ? {}
      : {
          ...(proposal.authNote === undefined ? {} : { authNote: proposal.authNote }),
          selectedAuth: proposal.selectedAuth,
        }),
    kind: request.kind,
    replayed,
    requestId: request.id,
    link: formatReferenceLink(request.id, "Request"),
    status: request.status,
    next: integrationRequestGuidance(request, { replayed, runOriginated: "runId" in scope }),
  };
  return {
    content: [
      {
        text: JSON.stringify(result),
        type: "text" as const,
      },
    ],
    structuredContent: result,
  };
}

function integrationAlreadyGrantedResult(
  access: IntegrationAccess,
  integration: string,
  account: string,
) {
  const result = {
    kind: "integration.access" as const,
    requestId: null,
    replayed: false,
    status: "fulfilled" as const,
    next: `${integration} as ${account} has a personal ${access} grant. This task’s access mode still limits execution. Call integration_search for operations this task can use.`,
  };
  return {
    content: [
      {
        text: JSON.stringify(result),
        type: "text" as const,
      },
    ],
    structuredContent: result,
  };
}

function integrationRequestGuidance(
  request: Pick<Request, "kind" | "status">,
  origin: { readonly replayed: boolean; readonly runOriginated: boolean },
): string {
  switch (request.status) {
    case "pending": {
      const asked =
        request.kind === "integration.access"
          ? "The user has been asked in Opensteer."
          : request.kind === "computer.app.access"
            ? "The user has been asked to approve this from any Opensteer app."
            : "The user has been asked in Opensteer to approve this integration installation.";
      // A Trigger occurrence ends before any user answers, and nothing resumes
      // it, so promising a reply on this thread would be a lie.
      if (origin.runOriginated) {
        // A deduplicated ask belongs to the thread that opened it, so its
        // outcome is delivered there, not here.
        return origin.replayed
          ? `An equivalent Request is already pending, so no second one was opened; its outcome is delivered to the task that opened it. ${asked} Nothing is granted until they answer; you will be told in the originating task when they answer.`
          : `${asked} This Request is durable and still open. Nothing is granted until they answer; you will be told in the originating task when they answer.`;
      }
      // An occurrence that files the same ask again is handed the Request that
      // is already waiting, so it has to be told it asked for something that
      // exists rather than that it opened something new.
      const opened = origin.replayed
        ? `An equivalent Request is already pending, so no second one was opened. ${asked}`
        : asked;
      return `${opened} Nothing is granted until they answer. This request outlives this automation occurrence; no answer comes back to it, and a later occurrence can inspect readiness.`;
    }
    case "fulfilled":
      return "This request was fulfilled. Use integration_search now for current access and available operations.";
    case "declined":
      return "The user declined this request. Continue without it.";
    case "withdrawn":
      return "This request was withdrawn. Continue without it.";
    case "cancelled":
      return "This request was cancelled. Search again if the task still needs integration access or setup.";
  }
}

function searchCallableTools(
  callable: readonly CallableIntegrationTool[],
  query: string,
): readonly CallableIntegrationTool[] {
  const terms = integrationSearchTerms(query);
  if (terms.length === 0) return callable;
  const scored = callable.map((operation) => {
    const weightedFields = [
      { value: operation.tool.name, weight: 8 },
      { value: operation.tool.title, weight: 8 },
      { value: operation.installation.name, weight: 6 },
      { value: operation.installation.title, weight: 6 },
      { value: operation.server.name, weight: 4 },
      { value: operation.grant.alias, weight: 3 },
      { value: operation.tool.description, weight: 1 },
      { value: operation.installation.description, weight: 1 },
    ] as const;
    let matchedTerms = 0;
    let score = 0;
    for (const term of terms) {
      const best = Math.max(
        ...weightedFields.map(({ value, weight }) => operationTermQuality(value, term) * weight),
      );
      if (best > 0) matchedTerms += 1;
      score += best;
    }
    return { matchedTerms, operation, score };
  });
  return scored
    .filter(({ matchedTerms }) => matchedTerms > 0)
    .sort(
      (left, right) =>
        right.matchedTerms - left.matchedTerms ||
        right.score - left.score ||
        left.operation.installation.title.localeCompare(right.operation.installation.title) ||
        left.operation.tool.title.localeCompare(right.operation.tool.title) ||
        left.operation.grant.alias.localeCompare(right.operation.grant.alias),
    )
    .map(({ operation }) => operation);
}

/** One row per operation: the accounts that share its name and schema. */
function groupedOperations(
  operations: readonly CallableIntegrationTool[],
): readonly (readonly CallableIntegrationTool[])[] {
  const rows = new Map<string, CallableIntegrationTool[]>();
  for (const operation of operations) {
    const key = operationAddress(operation);
    const row = rows.get(key);
    if (row) row.push(operation);
    else rows.set(key, [operation]);
  }
  return [...rows.values()];
}

/** The sentence a model needs to choose an operation; describe holds the rest. */
function toolSummary(tool: { readonly description: string; readonly title: string }): string {
  const line = tool.description.trim().split("\n", 1)[0] ?? "";
  const sentence = /^.*?[.!?](?=\s|$)/u.exec(line)?.[0] ?? line;
  if (sentence.length === 0) return tool.title;
  return sentence.length <= maximumToolSummaryLength
    ? sentence
    : `${sentence.slice(0, maximumToolSummaryLength - 1)}…`;
}

function operationTermQuality(value: string, term: string): number {
  const tokens = value
    .replaceAll(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (tokens.includes(term)) return 1;
  if (
    term.length >= 4 &&
    tokens.some((token) => token.length >= 4 && (token.startsWith(term) || term.startsWith(token)))
  ) {
    return 0.5;
  }
  return 0;
}

function callableToolMatchesProvider(
  callable: CallableIntegrationTool,
  provider: string | undefined,
  definitionById: ReadonlyMap<string, IntegrationDefinition>,
): boolean {
  if (!provider) return true;
  const definitionId = installationDefinitionId(callable.installation);
  if (definitionById.get(definitionId ?? "")?.provider === provider) return true;
  const requirement = callable.server.connectionRequirement;
  return requirement.kind === "provider" && requirement.provider === provider;
}

function installationDefinitionId(installation: IntegrationInstallation): string | null {
  const provenanceId = installation.provenance.definitionId;
  if (typeof provenanceId === "string") return provenanceId;
  const definition = installation.manifest.definition;
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return null;
  const id = (definition as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

/**
 * The provider argument orders the complete catalog so the asked-for service reads first; it never
 * removes an entry, because a hidden definition is indistinguishable from a nonexistent one.
 */
function orderedCatalog(
  definitions: readonly IntegrationDefinition[],
  provider: string | undefined,
): readonly IntegrationDefinition[] {
  if (!provider) return definitions;
  return [
    ...definitions.filter((definition) => definition.provider === provider),
    ...definitions.filter((definition) => definition.provider !== provider),
  ];
}

function catalogEntry(
  definition: IntegrationDefinition,
  installed: DiscoveryInventoryEntry | undefined,
) {
  const entry = {
    definitionId: definition.id,
    description: definition.description,
    integration: definition.name,
  };
  if (!installed) return { ...entry, installed: false as const };
  const { installation } = installed;
  return {
    ...entry,
    installed: true as const,
    installationId: installation.id,
    installationStatus: installation.status,
    ...(installation.status !== "active" ? { statusDetail: installedStatusDetail(installed) } : {}),
  };
}

function installedStatusDetail(entry: DiscoveryInventoryEntry): string | null {
  return (
    entry.servers.map(({ statusDetail }) => statusDetail).find((detail) => detail !== null) ??
    entry.readiness.servers.map(({ detail }) => detail).find((detail) => detail !== null) ??
    null
  );
}

function blockedFields(status: Parameters<typeof integrationBlocked>[0], integration: string) {
  const blocked = integrationBlocked(status, integration);
  return blocked ? { blocked } : {};
}

interface OperationAddress {
  readonly account?: IntegrationConnectionId | undefined;
  readonly operation: string;
}

const maximumBlockedTools = 20;
const maximumToolSummaryLength = 160;

const catalogSearchGuidance =
  'catalog is complete regardless of query/provider; definitionId is the catalog argument for integration_request. For installed:false, request catalog with reason and access "read" or "read-write"; one request covers installation, connection and access. Omit access only for explicit install-only requests. For installed:true with installationStatus other than active, relay statusDetail and request catalog to reinstall. Active installations are reused; use results for accounts and servers. An empty results page does not mean built-in support is absent.';

function integrationScope(caller: AgentCaller): AnyIntegrationToolsScope {
  if (caller.kind === "run") return caller.claims;
  if (caller.kind === "connection")
    throw new OpensteerError({
      code: "forbidden",
      message: "This integration requires a task",
    });
  const p = caller.program;
  if (p.kind === "trigger") return { ...p, aud: "opensteer-trigger-integration-tools" };
  return {
    ...p,
    aud: "opensteer-watch-integration-tools",
    requestedBy: caller.userId,
    threadId: caller.anchor.id,
    watchActivationId: p.activationId,
  };
}
function structured(result: {
  readonly structuredContent?: Record<string, unknown>;
  readonly content: readonly { readonly text?: string }[];
}) {
  const text = result.content.map((c) => c.text ?? "").join("\n");
  if (!result.structuredContent) return { description: text };
  return result.structuredContent;
}

async function findAsync<Value>(
  values: readonly Value[],
  predicate: (value: Value) => Promise<boolean>,
): Promise<Value | undefined> {
  for (const value of values) {
    if (await predicate(value)) return value;
  }
  return undefined;
}
