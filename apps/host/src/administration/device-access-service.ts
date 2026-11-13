import type { AgentEvent, RequestId, RequestResponse, UserId } from "@opensteer/core";
import { RunnerIdSchema } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { RunToolScope } from "../agents/run-tool-tokens.js";
import type { ContinuationService } from "../agents/continuation-service.js";

interface DeviceAccessServiceOptions {
  readonly store: Pick<OpensteerStore, "requests">;
  readonly runners: Pick<RunnerRegistry, "isRunnerConnected">;
  readonly onDeploymentEvent: (event: AgentEvent) => void;
  readonly continuations: Pick<ContinuationService, "notify">;
}
export class DeviceAccessService {
  readonly #options: DeviceAccessServiceOptions;
  constructor(options: DeviceAccessServiceOptions) {
    this.#options = options;
  }
  async request(input: {
    readonly callId: string;
    readonly machineId: string;
    readonly access: "browser" | "apps" | "files";
    readonly reason: string;
    readonly claims: RunToolScope;
  }) {
    const machineId = RunnerIdSchema.parse(input.machineId);
    const created = await this.#options.store.requests.createDeviceAccessRequest(
      {
        callId: input.callId,
        machineId,
        access: input.access,
        reason: input.reason,
        originatingThreadId: input.claims.threadId,
        originatingRunId: input.claims.runId,
        requestedBy: input.claims.requestedBy,
      },
      () => this.#options.runners.isRunnerConnected(machineId),
    );
    for (const event of created.events) this.#options.onDeploymentEvent(event);
    return {
      kind: "device.access" as const,
      replayed: created.replayed,
      requestId: created.request.id,
      status: created.request.status,
    };
  }
  async decline(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }) {
    const result = await this.#options.store.requests.declineDeviceAccessRequest(input);
    for (const event of result.events) this.#options.onDeploymentEvent(event);
    this.#options.continuations.notify();
    return result;
  }
}
