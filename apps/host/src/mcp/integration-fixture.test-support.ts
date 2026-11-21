import type { Thread } from "@opensteer/core";
import type { RunCapabilityClaims } from "../agents/run-capability.js";
import type { DeviceServicesTestHarness } from "../devices/device-services.test-support.js";
import type {
  TriggerCapabilityClaims,
  TriggerControlScope,
} from "../triggers/trigger-control-service.js";
import type { AgentCaller, RunCaller } from "./agent-caller.js";
import { DeviceToolHandlers } from "./handlers/devices.js";
import { agentToolHandlers } from "./handlers/index.js";
import { OpensteerMcpService } from "./opensteer-mcp-service.js";

type TriggerScope = TriggerCapabilityClaims<"opensteer-trigger-integration-tools">;

/** The device tools over MCP, with the device services a test built behind them. */
export function createIntegrationMcpFixture(options: {
  readonly platform: Pick<DeviceServicesTestHarness, "access" | "devices">;
  readonly publicUrl: URL;
  readonly runTokens: { authenticate(token: string): Promise<RunCapabilityClaims<string>> };
  readonly triggerTokens: { authenticate(token: string): Promise<TriggerScope> };
}) {
  const devices = new DeviceToolHandlers({
    devices: options.platform.devices,
    access: options.platform.access,
  });
  const unavailable = new Proxy(
    {},
    {
      get: () => async () => {
        throw new Error("Unexpected product tool");
      },
    },
  );
  const handlers = agentToolHandlers({
    tabs: unavailable as never,
    administration: new Proxy(
      {},
      {
        get: () => {
          throw new Error("Unexpected administration tool");
        },
      },
    ) as never,
    devices,
    product: unavailable as never,
    triggers: unavailable as never,
    apps: unavailable as never,
  });
  return new OpensteerMcpService({
    handlers,
    publicUrl: options.publicUrl,
    store: {
      requests: { get: async () => null },
      getThreadForOwner: Reflect.get(unavailable, "getThreadForOwner"),
    } as never,
    callers: {
      authenticate: async (token: string): Promise<AgentCaller> => {
        const run = await options.runTokens.authenticate(token).catch(() => null);
        const claims = run ?? (await options.triggerTokens.authenticate(token));
        const thread = {
          id: claims.threadId,

          environmentId: claims.environmentId,
          lineageRootThreadId: claims.threadId,
          accessMode: "full-access",
          teamOrigin: null,
        } as Thread;
        const base = {
          key: run ? `run:${run.runId}` : `trigger:${(claims as TriggerScope).occurrenceId}`,
          userId: claims.requestedBy,
          accessMode: thread.accessMode,
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
  });
}
