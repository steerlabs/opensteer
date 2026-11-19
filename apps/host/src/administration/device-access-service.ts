import type { RequestId, RequestResponse, UserId } from "@opensteer/core";
import { DeviceIdSchema } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import type { RunToolScope } from "../agents/run-tool-tokens.js";

interface DeviceAccessServiceOptions {
  readonly store: Pick<OpensteerStore, "requests" | "getDeviceSelfRunnerId">;
  readonly deviceOnline?: (
    id: import("@opensteer/core").DeviceId,
    capability: "browser" | "apps" | "files",
  ) => boolean;
  readonly runners: Pick<RunnerRegistry, "isRunnerConnected">;
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
    const machineId = DeviceIdSchema.parse(input.machineId);
    const self = await this.#options.store.getDeviceSelfRunnerId(machineId);
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
      () =>
        self !== null
          ? this.#options.runners.isRunnerConnected(self)
          : (this.#options.deviceOnline?.(machineId, input.access) ?? false),
    );
    return {
      kind: "device.access" as const,
      replayed: created.replayed,
      requestId: created.request.id,
      status: created.request.status,
    };
  }
  async decline(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly settlementSessionId?: string;
    readonly response: RequestResponse;
  }) {
    const result = await this.#options.store.requests.declineDeviceAccessRequest(input);
    return result;
  }
}
