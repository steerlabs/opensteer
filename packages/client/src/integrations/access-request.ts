import {
  IntegrationDefinitionSummaryViewSchema,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core/adapter";
import type {
  IntegrationAccess,
  IntegrationConnectionRequirement,
  IntegrationDashboard,
  IntegrationPlatformDashboardView,
} from "@opensteer/integration-core";
import {
  IntegrationInstallManifestSummaryViewSchema,
  integrationProposalName,
  type IntegrationInstallManifestSummaryView,
} from "@opensteer/integration-core/models";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import { apiKeyFacts, connectableApiKeyMethod } from "./api-key.js";
import { requestAgentProposedDetail, type Request } from "@opensteer/core";
import { mutationIdempotencyKey, unwrapRpcResult } from "../host/host-session-client.js";
import type { HostClient, WorkspaceSummary } from "../host/index.js";

/**
 * What one integration access Request comes to, shared by the browser card and
 * the phone's sheet: which installation and server it names, which of this
 * person's accounts can answer it, and how many operations each access class
 * actually reaches. Both surfaces must read the same Request the same way — an
 * approval that means one thing on a laptop and another on a phone is a bug
 * with two homes.
 */
export interface LoadedAccessRequest {
  readonly dashboard: IntegrationDashboard;
  readonly platform: IntegrationPlatformDashboardView;
  readonly request: Extract<Request["payload"], { kind: "integration.access" }>;
}

/**
 * Whether one Request remains in the Host's durable pending set.
 *
 * A computer connection write may fulfill Main access in the same transaction.
 * Both native and web surfaces re-read that fact before offering a second
 * response. `thread.requests.list` is a pending-only endpoint in production;
 * pagination keeps absence authoritative even on a busy Thread.
 */
export async function integrationRequestStillPending(
  hostClient: Pick<HostClient, "rpc">,
  threadId: string,
  requestId: string,
): Promise<boolean> {
  let before: string | undefined;
  do {
    const page = unwrapRpcResult(
      await hostClient.rpc["thread.requests.list"]({
        ...(before === undefined ? {} : { before }),
        limit: 100,
        threadId,
      }),
    );
    if (page.requests.some((candidate) => candidate.id === requestId)) return true;
    if (!page.window.hasMore) return false;
    if (page.window.nextBefore === null) {
      throw new Error("Thread Request page is missing its continuation cursor.");
    }
    before = page.window.nextBefore;
  } while (before !== undefined);
  return false;
}

/** A reviewed install manifest, or null when it cannot be read. */
function installManifest(manifest: unknown): IntegrationInstallManifestSummaryView | null {
  const view = IntegrationInstallManifestSummaryViewSchema.safeParse(manifest);
  return view.success ? view.data : null;
}

/** The definition an installation was made from; absent for plugins and MCP servers. */
export function installationDefinition(
  manifest: Readonly<Record<string, unknown>>,
): IntegrationDefinitionSummaryView | null {
  const view = IntegrationDefinitionSummaryViewSchema.safeParse(manifest["definition"]);
  return view.success ? view.data : null;
}

/** Finds only the active installation produced by this exact reviewed manifest. */
export function matchingInstallationForManifest(
  platform: IntegrationPlatformDashboardView,
  manifest: unknown,
) {
  const parsed = installManifest(manifest);
  if (parsed === null) return null;
  return (
    platform.installations.find(({ installation }) => {
      if (installation.status !== "active") return false;
      return parsed.kind === "catalog"
        ? installation.provenance?.["definitionId"] === parsed.definition.id &&
            installation.provenance?.["definitionDigest"] === parsed.digest
        : installation.provenance?.["artifactDigest"] === parsed.proposal.digest;
    }) ?? null
  );
}

/**
 * What a person decides an installation on, read the same way by the browser
 * card and the phone's sheet: what it will be called and what it does, where it
 * came from when that is not Opensteer's own catalog, and where its key would
 * go. How much it can do is left to the access step, which counts what is
 * actually granted.
 */
export interface IntegrationInstallReview {
  readonly name: string;
  /** Said only of an agent's proposal; a catalog preset is Opensteer's own. */
  readonly provenance: string | null;
  /** One sentence each, in reading order. */
  readonly facts: readonly string[];
}

export function integrationInstallReview(manifest: unknown): IntegrationInstallReview | null {
  const parsed = installManifest(manifest);
  if (parsed === null) return null;
  if (parsed.kind === "catalog") {
    const { definition } = parsed;
    const key = definition.apiKey === null ? null : apiKeyFacts(definition.name, definition.apiKey);
    return {
      facts: [definition.description, ...(key === null ? [] : [key.custody, key.check])],
      name: definition.name,
      provenance: null,
    };
  }
  const { proposal } = parsed;
  const name = integrationProposalName(proposal);
  const key =
    proposal.apiKey !== undefined && proposal.authMethods.includes("api-key")
      ? apiKeyFacts(name, proposal.apiKey)
      : null;
  return {
    facts: [
      ...(proposal.description === undefined ? [] : [proposal.description]),
      proposal.source.type === "url"
        ? `Researched from ${new URL(proposal.source.origin).host}.`
        : "Researched from a document the agent supplied.",
      ...(key === null ? [] : [key.custody, key.check]),
    ],
    name,
    provenance: requestAgentProposedDetail,
  };
}

/**
 * The one note under an install review: what installing leads to, or who has
 * to do it. An access Request goes on, on the same card, to whatever setup the
 * integration needs and then its access; an install Request ends at the install.
 */
export function integrationInstallNextStep(input: {
  readonly canInstall: boolean;
  readonly continuesToAccess: boolean;
  /** The title of the installation this exact manifest already produced. */
  readonly installedTitle: string | null;
}): string {
  if (!input.continuesToAccess) {
    return "Installing adds it to this deployment. Connecting an account and allowing access are each asked for separately.";
  }
  if (input.installedTitle !== null) {
    return `${input.installedTitle} is already installed. Continue to finish setting it up and review its access.`;
  }
  return input.canInstall
    ? "After it’s installed, you’ll finish setting it up and review its access here."
    : "A Host administrator must install it first. Then you can finish setting it up and review its access here.";
}

/**
 * Said beside the connect action of a Request for Main, before anything is
 * connected: a person's own tasks in Main use every account they connect, so
 * the Host answers the Request as soon as a usable account is connected.
 */
export function mainConnectAllowsNote(workspaceName: string): string {
  return `Your tasks in ${workspaceName} can read and make changes with every account you connect, so connecting also allows this request.`;
}

export async function resolveIntegrationAccess(
  hostClient: Pick<HostClient, "dispatch">,
  input: {
    readonly access: IntegrationAccess;
    readonly accountsCount: number;
    readonly installationTitle: string;
    readonly requestId: string;
    readonly selectedAccount: {
      readonly accountIdentifier: string | null;
      readonly displayName: string;
      readonly id: string;
    } | null;
    readonly targetKind: WorkspaceSummary["kind"];
  },
): Promise<void> {
  const { requestId, selectedAccount, targetKind } = input;
  if (targetKind === "main") {
    await hostClient.dispatch({
      idempotencyKey: mutationIdempotencyKey(`request:${requestId}`),
      requestId,
      response: {
        kind: "external",
        value: { connectionId: selectedAccount?.id ?? null, decision: "fulfilled" },
      },
      type: "request.respond",
    });
    return;
  }
  await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`request:${requestId}`),
    requestId,
    response: {
      kind: "external",
      value: {
        alias: selectedAccount?.displayName ?? input.installationTitle,
        access: input.access,
        connectionId: selectedAccount?.id ?? null,
        decision: "fulfilled",
        isDefault: input.accountsCount <= 1,
      },
    },
    type: "request.respond",
  });
}

/**
 * Connecting an account is the user's move on any access Request whose
 * integration can take a new connection. Whether an existing account already
 * satisfies the Request is a separate question: a Request that asks for
 * another account, or a different one, is answered by connecting it, so the
 * connect action never hides behind the account the card happens to select.
 */
export function accountConnectable(
  plan: Pick<AccessPlan, "apiKeyMethod" | "definition" | "requirement">,
): boolean {
  switch (plan.requirement.kind) {
    case "none":
      return false;
    case "mcp-oauth":
      return true;
    // An app on a computer is connected by choosing the computer, which is a
    // picker rather than a sign-in; a surface that cannot show one offers no
    // connect action at all.
    case "computer":
      return true;
    case "provider":
      return (
        plan.apiKeyMethod !== null ||
        (plan.definition?.authMethods.some((method) => method.kind === "oauth") ?? false)
      );
  }
}

/**
 * The computer whose ceiling has to be raised before the effective access can
 * be fulfilled, or null when nothing stands in the way. Callers that do not
 * offer a broader choice use the Request's access by default.
 *
 * A connection's access decides which tool rows exist, so a read-only computer
 * simply has no send tool and no grant could reach one. Raising the ceiling is
 * therefore a separate, deliberate act on the computer — never a side effect of
 * approving a Workspace's access.
 */
export function computerAccessUpgrade(
  plan: Pick<AccessPlan, "definition" | "requestedAccess" | "requirement" | "selectedAccount">,
  effectiveAccess: IntegrationAccess = plan.requestedAccess,
): {
  readonly definitionId: string;
  readonly displayName: string;
  readonly runnerId: string;
} | null {
  if (plan.requirement.kind !== "computer" || effectiveAccess !== "read-write") return null;
  if (plan.definition?.computerApp?.accessLevels.length !== 2) return null;
  const computer = plan.selectedAccount?.computer;
  if (!computer || computer.access === "read-write") return null;
  return {
    definitionId: plan.definition.id,
    displayName: plan.selectedAccount?.displayName ?? plan.definition.name,
    runnerId: computer.runnerId,
  };
}

/**
 * One account a Request can be answered with. `computer` is the app-on-a-
 * computer placement and its ceiling; every other kind of account has none.
 */
export interface AccessRequestAccount {
  readonly accountIdentifier: string | null;
  readonly computer: {
    readonly access: IntegrationAccess;
    readonly runnerId: string;
  } | null;
  readonly createdAt: string;
  readonly displayName: string;
  readonly id: string;
}

/**
 * The accounts that can answer one connection requirement.
 *
 * Which list an integration draws from is a property of its requirement, not
 * of the surface asking: a provider integration's accounts are this person's
 * connections, an app's accounts are the computers it is on, and a remote MCP
 * server's are the platform connections made against that server. The Request
 * card and the Workspace-access editor both need exactly this, and a Workspace
 * that could be granted an account the Request card would not offer is a bug
 * with two homes — so there is one reading of it here, free of React and the
 * DOM, rather than a nested ternary in each.
 */
export function accountsForRequirement(input: {
  readonly dashboard: Pick<IntegrationDashboard, "connections"> | null;
  /** The installation whose MCP connections count, for `mcp-oauth`. */
  readonly installationId: string | null;
  readonly platform: Pick<IntegrationPlatformDashboardView, "connections"> | null;
  readonly requirement: IntegrationConnectionRequirement;
  /** Narrows `mcp-oauth` to one server; null accepts every server. */
  readonly serverId?: string | null;
}): readonly AccessRequestAccount[] {
  const { installationId, requirement, serverId = null } = input;
  switch (requirement.kind) {
    case "none":
      return [];
    case "provider":
      return (input.dashboard?.connections ?? [])
        .filter(
          ({ definitionId, status }) =>
            definitionId === requirement.definitionId && status === "connected",
        )
        .map(({ accountIdentifier, createdAt, displayName, id }) => ({
          accountIdentifier,
          computer: null,
          createdAt,
          displayName,
          id,
        }));
    // An app connection is an account whose name is the computer's, and whose
    // ceiling travels with it: a surface has to know a read-only computer
    // cannot answer a request that asks to send.
    case "computer":
      return (input.dashboard?.connections ?? [])
        .filter(
          ({ computer, definitionId, status }) =>
            definitionId === requirement.definitionId &&
            status === "connected" &&
            computer !== null,
        )
        .map(({ accountIdentifier, computer, createdAt, displayName, id }) => ({
          accountIdentifier,
          computer,
          createdAt,
          displayName,
          id,
        }));
    case "mcp-oauth":
      return (input.platform?.connections ?? [])
        .filter(
          (connection) =>
            connection.installationId === installationId &&
            connection.status === "connected" &&
            (serverId === null || connection.serverId === serverId),
        )
        .map(({ accountIdentifier, connectionId: id, createdAt, displayName }) => ({
          accountIdentifier,
          computer: null,
          createdAt,
          displayName,
          id,
        }));
  }
}

export type AccessPlan = NonNullable<ReturnType<typeof accessPlan>>;

export function effectiveIntegrationAccess(
  requested: IntegrationAccess,
  allowChanges: boolean,
): IntegrationAccess {
  return requested === "read-write" || allowChanges ? "read-write" : "read";
}

/**
 * The access answering a Request gives its Workspace, which its card states. A
 * specialized Workspace gets what the card allows. Tasks in Main use every
 * account their owner connects to read and make changes, whatever the Request
 * asked; only a computer's own access limits that, and the card raises it
 * first when the Request needs changes.
 */
export function grantedIntegrationAccess(input: {
  readonly allowChanges: boolean;
  readonly plan: Pick<
    AccessPlan,
    "definition" | "requestedAccess" | "requirement" | "selectedAccount"
  >;
  readonly workspaceKind: "main" | "specialized";
}): IntegrationAccess {
  const allowed = effectiveIntegrationAccess(input.plan.requestedAccess, input.allowChanges);
  if (input.workspaceKind === "specialized") return allowed;
  if (input.plan.requirement.kind !== "computer") return "read-write";
  const computer = input.plan.selectedAccount?.computer;
  return computer && computerAccessUpgrade(input.plan, allowed) === null
    ? computer.access
    : allowed;
}

/**
 * The access a Request's card grants, in one line, and how much of the
 * integration that reaches: "Read only · 135 of 152 operations".
 * The card's title already names the integration and its account row the account.
 */
export function integrationAccessSummary(
  plan: Pick<AccessPlan, "readCount" | "writeCount">,
  access: IntegrationAccess,
): string {
  const total = plan.readCount + plan.writeCount;
  const reached = access === "read-write" ? total : plan.readCount;
  return `${access === "read-write" ? "Read and write" : "Read only"} · ${
    reached === total ? operationCount(total) : `${reached} of ${operationCount(total)}`
  }`;
}

/** "1 operation", "12 operations". */
export function operationCount(count: number): string {
  return `${count} ${count === 1 ? "operation" : "operations"}`;
}

/** "1 operation that makes changes", "3 operations that make changes". */
export function changingOperationCount(count: number): string {
  return `${operationCount(count)} that ${count === 1 ? "makes" : "make"} changes`;
}

/** A Request pinned to an account that is gone can only be declined. */
export const requestedAccountUnavailableDetail =
  "This account is no longer available. Decline this request, then ask the agent again when you want to reconnect.";

export function accessServerChoices(loaded: LoadedAccessRequest) {
  if (loaded.request.installationId === null || loaded.request.requestedServerId !== null)
    return [];
  const entry = loaded.platform.installations.find(
    ({ installation }) => installation.id === loaded.request.installationId,
  );
  if (!entry) return [];
  const available = entry.servers.filter(({ status }) => status !== "disabled");
  return available.length > 0
    ? available.map(({ id, name }) => ({ id, name, installationTitle: entry.installation.title }))
    : [];
}

export function accessPlan(loaded: LoadedAccessRequest, selectedAccountId: string | null) {
  const { dashboard, platform, request } = loaded;
  const entry = platform.installations.find(
    ({ installation }) => installation.id === request.installationId,
  );
  if (!entry) return null;
  const definition = installationDefinition(entry.installation.manifest);
  const availableServers = entry.servers.filter(({ status }) => status !== "disabled");
  const requestedServer =
    request.requestedServerId === null
      ? null
      : (availableServers.find(({ id }) => id === request.requestedServerId) ?? null);
  // A missing named server, or any omitted real server, is never equivalent
  // to a credential-free installation. The caller has to name what it means.
  if (
    (request.requestedServerId !== null && requestedServer === null) ||
    (request.requestedServerId === null && entry.servers.length > 0)
  ) {
    return null;
  }
  const serverId = requestedServer?.id ?? null;
  const requirement: IntegrationConnectionRequirement = requestedServer?.connectionRequirement ?? {
    kind: "none",
  };
  const accounts = accountsForRequirement({
    dashboard,
    installationId: request.installationId,
    platform,
    requirement,
    serverId,
  });
  const requestedConnectionId = request.requestedConnectionId ?? null;
  const requestedProviderConnection =
    requestedConnectionId !== null && requirement.kind === "provider"
      ? (dashboard.connections.find(
          ({ definitionId, id }) =>
            definitionId === requirement.definitionId && id === requestedConnectionId,
        ) ?? null)
      : null;
  const selectedAccount =
    requestedConnectionId !== null
      ? (accounts.find(({ id }) => id === requestedConnectionId) ?? null)
      : (accounts.find(({ id }) => id === selectedAccountId) ?? accounts[0] ?? null);
  const visibleTools =
    requirement.kind === "mcp-oauth" || requirement.kind === "computer"
      ? entry.tools.filter(
          ({ connectionId, serverId: candidateServerId }) =>
            connectionId === selectedAccount?.id && candidateServerId === serverId,
        )
      : requirement.kind === "provider"
        ? entry.tools.filter(
            ({ connectionId, serverId: candidateServerId }) =>
              candidateServerId === serverId &&
              (connectionId === null || connectionId === selectedAccount?.id),
          )
        : entry.tools.filter(
            ({ connectionId, serverId: candidateServerId }) =>
              connectionId === null && (serverId === null || candidateServerId === serverId),
          );
  /**
   * A definition declares exactly one connection posture, so the requirement
   * says which credential the Host will accept: a provider requirement that
   * needs no provider application is an API key the user can type here.
   */
  const apiKeyMethod =
    requirement.kind === "provider" && !requirement.providerApplicationRequired
      ? definition === null
        ? null
        : connectableApiKeyMethod(definition)
      : null;
  // A connection is repaired the way it was made: a sign-in through the
  // provider's account identity, a key by naming the connection it replaces.
  const reconnectMethod: "api-key" | "sign-in" | null =
    requestedProviderConnection?.status !== "needs-attention"
      ? null
      : requestedProviderConnection.connectionMethod === "api-key"
        ? apiKeyMethod === null
          ? null
          : "api-key"
        : definition?.authMethods.some(({ kind }) => kind === "oauth")
          ? "sign-in"
          : null;
  return {
    accounts,
    apiKeyMethod,
    definition,
    integrationName: definition?.name ?? entry.installation.title,
    installationTitle: entry.installation.title,
    proposed: entry.installation.sourceKind === "proposed",
    readCount: visibleTools.filter(
      ({ annotations }) => integrationToolEffect(annotations) === "read",
    ).length,
    requirement,
    requestedAccountMissing: requestedConnectionId !== null && selectedAccount === null,
    /**
     * The account the Request names, when it needs attention and this surface
     * can repair it, and how. A key reconnect keeps the account's own name
     * unless the person gives a new one.
     */
    requestedAccountReconnect:
      requestedProviderConnection === null || reconnectMethod === null
        ? null
        : {
            account: {
              accountIdentifier: requestedProviderConnection.accountIdentifier,
              computer: null,
              createdAt: requestedProviderConnection.createdAt,
              displayName: requestedProviderConnection.displayName,
              id: requestedProviderConnection.id,
            } satisfies AccessRequestAccount,
            method: reconnectMethod,
            /** Why it needs attention, as the Host recorded it. */
            statusDetail: requestedProviderConnection.statusDetail,
          },
    requestedAccess: request.access,
    requestedConnectionId,
    serverId,
    selectedAccount,
    writeCount: visibleTools.filter(
      ({ annotations }) => integrationToolEffect(annotations) === "write",
    ).length,
  };
}
