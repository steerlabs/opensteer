import type { IntegrationAuthorizationTracking } from "../../integrations/use-integration-authorization-tracking.js";
import type {
  IntegrationAuthorizationStart,
  IntegrationAuthorizationStatus,
  IntegrationDashboard,
  IntegrationOAuthApplicationSource,
  IntegrationProviderApplication,
  SaveIntegrationProviderApplication,
} from "@opensteer/integration-core/models";
import type { IntegrationRepositoryAccess } from "@opensteer/integration-core";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { desktopBridge } from "../../desktop/desktop-bridge.js";
import {
  integrationAuthorizationSurface,
  beginIntegrationAuthorization,
  waitForIntegrationAuthorization,
} from "../../integrations/integration-authorization.js";
/**
 * Everything the Connect flow does to the Host, as one small injectable
 * surface. It exists so the flow can be driven in a test without a Host, and so
 * both entry points speak to the same typed rpc members.
 */
export interface ConnectOperations {
  /**
   * Observe the same durable attempt while authorization runs in another
   * surface. It answers a terminal status, or rejects once aborted.
   */
  readonly awaitAuthorization: (
    started: IntegrationAuthorizationStart,
    signal: AbortSignal,
  ) => Promise<IntegrationAuthorizationStatus>;
  /** The exact app the person chose is pinned to the attempt, never a kind. */
  readonly beginAuthorization: (input: {
    readonly applicationSource: IntegrationOAuthApplicationSource | null;
    readonly definitionId: string;
    readonly returnPath: string;
  }) => Promise<IntegrationAuthorizationStart>;
  readonly cancelAuthorization: (
    attemptId: IntegrationAuthorizationStart["attemptId"],
  ) => Promise<IntegrationAuthorizationStatus>;
  readonly reloadDashboard: () => Promise<IntegrationDashboard>;
  readonly checkRepositoryAccess: (connectionId: string) => Promise<IntegrationRepositoryAccess>;
  /** Answers with the record the Host wrote, which is the only way to name it. */
  readonly saveProviderApplication: (
    input: SaveIntegrationProviderApplication,
  ) => Promise<IntegrationProviderApplication>;
  readonly setApplicationStatus: (input: {
    readonly applicationId: IntegrationProviderApplication["id"];
    readonly expectedRevision: number;
    readonly provider: IntegrationProviderApplication["provider"];
    readonly status: "active" | "disabled";
  }) => Promise<IntegrationProviderApplication>;
}

export function createConnectOperations(
  client: HostClient,
  tracking: IntegrationAuthorizationTracking,
): ConnectOperations {
  return {
    checkRepositoryAccess: async (connectionId) =>
      unwrapRpcResult(
        await client.rpc["integration.repositoryAccess.check"]({
          connectionId: connectionId as never,
        }),
      ),
    awaitAuthorization: async (started, signal) => {
      const status = await waitForIntegrationAuthorization({
        attemptId: started.attemptId,
        client,
        expiresAt: started.expiresAt,
        signal,
      });
      tracking.finished(started.attemptId);
      return status;
    },
    beginAuthorization: ({ applicationSource, definitionId, returnPath }) =>
      beginIntegrationAuthorization({
        bridge: desktopBridge(),
        onStarted: tracking.started,
        returnPath,
        begin: async (authorizationReturnPath) => {
          const started = await client.dispatch({
            idempotencyKey: mutationIdempotencyKey(`integration-auth:${definitionId}`),
            input: {
              ...(applicationSource ? { exactApplicationSource: applicationSource } : {}),
              definitionId,
              returnPath: authorizationReturnPath,
              surface: integrationAuthorizationSurface(desktopBridge()),
            },
            type: "integration.authorization.begin",
          });
          if (started.type !== "integration.authorization.begin") {
            throw new Error("Integration authorization command mismatch.");
          }
          return started;
        },
      }),
    cancelAuthorization: async (attemptId) => {
      const cancelled = await client.dispatch({
        attemptId,
        idempotencyKey: mutationIdempotencyKey(`integration-auth:${attemptId}`),
        type: "integration.authorization.cancel",
      });
      if (cancelled.type !== "integration.authorization.cancel") {
        throw new Error("Integration authorization cancellation command mismatch.");
      }
      tracking.finished(attemptId);
      return cancelled;
    },
    reloadDashboard: async () => unwrapRpcResult(await client.rpc["integrations.get"]({})),
    saveProviderApplication: async (input) => {
      const saved = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-app:${input.provider}`),
        input,
        type: "integration.providerApplication.save",
      });
      if (saved.type !== "integration.providerApplication.save") {
        throw new Error("Integration application command mismatch.");
      }
      return saved.application;
    },
    setApplicationStatus: async ({ applicationId, expectedRevision, provider, status }) => {
      const changed = await client.dispatch({
        idempotencyKey: mutationIdempotencyKey(`integration-app-status:${applicationId}`),
        input: { applicationId, expectedRevision, status },
        provider,
        type: "integration.providerApplication.status.set",
      });
      if (changed.type !== "integration.providerApplication.status.set") {
        throw new Error("Integration application command mismatch.");
      }
      return changed.application;
    },
  };
}
