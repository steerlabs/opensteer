import { includeDeviceAccessRequests } from "@opensteer/protocol";
import { computerTargetId } from "../host/device-projection.js";
import type { ClientIntegrationDashboard as IntegrationDashboard } from "../host/device-projection.js";
import {
  IntegrationDefinitionSummaryViewSchema,
  type IntegrationDefinitionSummaryView,
} from "@opensteer/integration-core/adapter";
import { IntegrationInstallManifestViewSchema } from "@opensteer/integration-core";
import type {
  IntegrationAccess,
  IntegrationConnectionRequirement,
  IntegrationPlatformDashboardView,
} from "@opensteer/integration-core";
import { integrationToolEffect } from "@opensteer/integration-core/effect";
import type { Request } from "@opensteer/core";
import { mutationIdempotencyKey, unwrapRpcResult } from "../host/host-session-client.js";
import type { HostClient } from "../host/index.js";

/**
 * What one access Request for a device data app or a local server comes to,
 * shared by the browser card and the phone's card: which installation and
 * server it names, which computers can answer it, and how many operations each
 * access class reaches.
 */
export interface LoadedAccessRequest {
  readonly dashboard: IntegrationDashboard;
  readonly platform: IntegrationPlatformDashboardView;
  readonly request: Extract<Request["payload"], { kind: "integration.access" }>;
  readonly reviewedRevision?: string | undefined;
}

/**
 * Whether one Request remains in the Host's durable pending set.
 *
 * A computer connection write may fulfill access in the same transaction.
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
        ...includeDeviceAccessRequests,
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

/** The catalog definition an access Request would install, or null. */
export function catalogInstallDefinition(
  manifest: unknown,
): IntegrationDefinitionSummaryView | null {
  const parsed = IntegrationInstallManifestViewSchema.safeParse(manifest);
  return parsed.success ? parsed.data.definition : null;
}

/** The definition an installation was made from; absent for local servers. */
export function installationDefinition(
  manifest: Readonly<Record<string, unknown>>,
): IntegrationDefinitionSummaryView | null {
  const view = IntegrationDefinitionSummaryViewSchema.safeParse(manifest["definition"]);
  return view.success ? view.data : null;
}

/** Finds only the active installation produced by this exact reviewed catalog manifest. */
export function matchingInstallationForManifest(
  platform: IntegrationPlatformDashboardView,
  manifest: unknown,
) {
  const parsed = IntegrationInstallManifestViewSchema.safeParse(manifest);
  if (!parsed.success) return null;
  return (
    platform.installations.find(
      ({ installation }) =>
        installation.status === "active" &&
        installation.provenance?.["definitionId"] === parsed.data.definition.id &&
        installation.provenance?.["definitionDigest"] === parsed.data.digest,
    ) ?? null
  );
}

export async function resolveIntegrationAccess(
  hostClient: Pick<HostClient, "dispatch">,
  input: {
    readonly access: IntegrationAccess;
    readonly accountsCount: number;
    readonly installationTitle: string;
    readonly requestId: string;
    readonly expectedRevision?: string | undefined;
    readonly selectedAccount: {
      readonly accountIdentifier: string | null;
      readonly displayName: string;
      readonly id: string;
    } | null;
  },
): Promise<void> {
  const { requestId, selectedAccount } = input;
  await hostClient.dispatch({
    idempotencyKey: mutationIdempotencyKey(`request:${requestId}`),
    requestId,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
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
    runnerId: computerTargetId(computer)!,
  };
}

/**
 * One computer a device app Request can be answered with, carrying that
 * computer's ceiling: a read-only computer cannot answer a request to send.
 */
export interface AccessRequestAccount {
  readonly accountIdentifier: string | null;
  readonly computer:
    | ({ readonly access: IntegrationAccess } & (
        { readonly deviceId: string } | { readonly runnerId: string }
      ))
    | null;
  readonly createdAt: string;
  readonly displayName: string;
  readonly id: string;
}

export function accountsForRequirement(input: {
  readonly dashboard: Pick<IntegrationDashboard, "connections"> | null;
  readonly requirement: IntegrationConnectionRequirement;
}): readonly AccessRequestAccount[] {
  const { requirement } = input;
  if (requirement.kind !== "computer") return [];
  return (input.dashboard?.connections ?? [])
    .filter(
      ({ computer, definitionId, status }) =>
        definitionId === requirement.definitionId && status === "connected" && computer !== null,
    )
    .map(({ accountIdentifier, computer, createdAt, displayName, id }) => ({
      accountIdentifier,
      computer,
      createdAt,
      displayName,
      id,
    }));
}

export type AccessPlan = NonNullable<ReturnType<typeof accessPlan>>;

export function effectiveIntegrationAccess(
  requested: IntegrationAccess,
  allowChanges: boolean,
): IntegrationAccess {
  return requested === "read-write" || allowChanges ? "read-write" : "read";
}

export function grantedIntegrationAccess(input: {
  readonly allowChanges: boolean;
  readonly plan: Pick<
    AccessPlan,
    "definition" | "requestedAccess" | "requirement" | "selectedAccount"
  >;
}): IntegrationAccess {
  const allowed = effectiveIntegrationAccess(input.plan.requestedAccess, input.allowChanges);
  if (input.plan.requirement.kind !== "computer") return "read-write";
  const computer = input.plan.selectedAccount?.computer;
  return computer && computerAccessUpgrade(input.plan, allowed) === null
    ? computer.access
    : allowed;
}

/**
 * The access a Request's card grants, in one line, and how much of it that
 * reaches: "Read only · 135 of 152 operations".
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

/** A Request pinned to a computer that is gone can only be declined. */
export const requestedAccountUnavailableDetail =
  "This computer is no longer available. Decline this request, then ask the agent again.";

export function accessServerChoices(loaded: LoadedAccessRequest) {
  if (loaded.request.installationId === null || loaded.request.requestedServerId !== null)
    return [];
  const entry = loaded.platform.installations.find(
    ({ installation }) => installation.id === loaded.request.installationId,
  );
  if (!entry) return [];
  return entry.servers
    .filter(({ status }) => status !== "disabled")
    .map(({ id, name }) => ({ id, name, installationTitle: entry.installation.title }));
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
  const accounts = accountsForRequirement({ dashboard, requirement });
  const requestedConnectionId = request.requestedConnectionId ?? null;
  const selectedAccount =
    requestedConnectionId !== null
      ? (accounts.find(({ id }) => id === requestedConnectionId) ?? null)
      : (accounts.find(({ id }) => id === selectedAccountId) ?? accounts[0] ?? null);
  const visibleTools =
    requirement.kind === "computer"
      ? entry.tools.filter(
          ({ connectionId, serverId: candidateServerId }) =>
            connectionId === selectedAccount?.id && candidateServerId === serverId,
        )
      : entry.tools.filter(
          ({ connectionId, serverId: candidateServerId }) =>
            connectionId === null && (serverId === null || candidateServerId === serverId),
        );
  return {
    accounts,
    definition,
    integrationName: definition?.name ?? entry.installation.title,
    installationTitle: entry.installation.title,
    readCount: visibleTools.filter(
      ({ annotations }) => integrationToolEffect(annotations) === "read",
    ).length,
    requirement,
    requestedAccountMissing: requestedConnectionId !== null && selectedAccount === null,
    requestedAccess: request.access,
    requestedConnectionId,
    serverId,
    selectedAccount,
    writeCount: visibleTools.filter(
      ({ annotations }) => integrationToolEffect(annotations) === "write",
    ).length,
  };
}
