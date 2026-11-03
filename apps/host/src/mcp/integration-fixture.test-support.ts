import type { Thread } from "@opensteer/core";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type { TriggerControlScope } from "../triggers/trigger-control-service.js";
import type { AgentCaller, RunCaller } from "./agent-caller.js";
import {
  IntegrationToolHandlers,
  type IntegrationToolsTriggerScope,
} from "./handlers/integrations.js";
import { agentToolHandlers } from "./handlers/index.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";
import { MemoryOperationReceipts } from "./receipts.test-support.js";

type IntegrationOptions = ConstructorParameters<typeof IntegrationToolHandlers>[0];
export function createIntegrationMcpFixture(
  options: IntegrationOptions & {
    readonly publicUrl: URL;
    readonly reach?: import("@opensteer/core").ThreadReachScope;
    readonly runTokens: { authenticate(token: string): Promise<RunCapabilityClaims<string>> };
    readonly triggerTokens: { authenticate(token: string): Promise<IntegrationToolsTriggerScope> };
  },
) {
  const integration = new IntegrationToolHandlers(options);
  const unavailable = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error("Unexpected product tool");
      },
    },
  );
  const handlers = agentToolHandlers({
    integrations: integration,
    product: unavailable as never,
    triggers: unavailable as never,
    apps: unavailable as never,
    pluginInstall: async () => {
      throw new Error("Unexpected install");
    },
  });
  return Object.assign(
    new OpensteerMcpService({
      handlers,
      publicUrl: options.publicUrl,
      store: unavailable as never,
      receipts: new MemoryOperationReceipts(),
      callers: {
        authenticate: async (token: string): Promise<AgentCaller> => {
          const run = await options.runTokens.authenticate(token).catch(() => null);
          const claims = run ?? (await options.triggerTokens.authenticate(token));
          const thread = {
            id: claims.threadId,
            workspaceId: claims.workspaceId,
            environmentId: claims.environmentId,
            lineageRootThreadId: claims.threadId,
            accessMode: "full-access",
          } as Thread;
          const base = {
            key: run
              ? `run:${run.runId}`
              : `trigger:${(claims as IntegrationToolsTriggerScope).occurrenceId}`,
            userId: claims.requestedBy,
            accessMode: thread.accessMode,
            reach: options.reach ?? { kind: "user" as const },
          };
          return run
            ? { ...base, kind: "run", thread, claims: run as RunCaller["claims"] }
            : {
                ...base,
                kind: "program",
                anchor: thread,
                program: {
                  ...claims,
                  kind: "trigger",
                  aud: "opensteer-trigger-control",
                } as TriggerControlScope & { kind: "trigger" },
              };
        },
      },
    }),
    { requestSpecialistAccess: integration.requestSpecialistAccess.bind(integration) },
  );
}
