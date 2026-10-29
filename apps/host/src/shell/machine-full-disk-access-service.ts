import {
  OpensteerError,
  type AgentEvent,
  type RequestId,
  type RequestResponse,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { allocateMachineAliases, type RequestCreationResult } from "@opensteer/protocol";
import type { AgentControlRunScope } from "../agents/agent-control-service.js";
import type { ContinuationService } from "../agents/continuation-service.js";

type FullAccessStore = Pick<OpensteerStore, "listReachableMachines"> & {
  readonly requests: Pick<
    OpensteerStore["requests"],
    "create" | "declineMachineFullDiskAccessRequest" | "fulfillMachineFullDiskAccessRequests"
  >;
};

export class MachineFullDiskAccessService {
  readonly #store: FullAccessStore;
  readonly #onWorkspaceEvent: (event: AgentEvent) => void;
  readonly #continuations: Pick<ContinuationService, "notify">;

  constructor(options: {
    readonly store: FullAccessStore;
    readonly onWorkspaceEvent: (event: AgentEvent) => void;
    readonly continuations: Pick<ContinuationService, "notify">;
  }) {
    this.#store = options.store;
    this.#onWorkspaceEvent = options.onWorkspaceEvent;
    this.#continuations = options.continuations;
  }

  async request(input: {
    readonly callId: string;
    readonly computer: string;
    readonly reason: string;
    readonly claims: AgentControlRunScope;
  }): Promise<RequestCreationResult & { kind: "machine.full-disk-access" }> {
    const { claims } = input;
    const machines = await this.#store.listReachableMachines(claims.requestedBy, claims.runnerId);
    const aliases = allocateMachineAliases(machines);
    const machine = machines.find((entry) => aliases.get(entry.runnerId) === input.computer);
    if (!machine)
      throw new OpensteerError({
        code: "bad_request",
        message: `No reachable computer is called ${input.computer}.`,
      });
    if (machine.platform !== "darwin")
      throw new OpensteerError({
        code: "bad_request",
        message: `${machine.name} is not a Mac, so macOS Full Disk Access does not apply.`,
      });
    if (machine.fullDiskAccess === true)
      throw new OpensteerError({
        code: "bad_request",
        message: `${machine.name} already has macOS Full Disk Access.`,
      });
    const kind = "machine.full-disk-access";
    const created = await this.#store.requests.create({
      callId: input.callId,
      kind,
      mode: "durable",
      requiredActor: "requester",
      payload: {
        kind,
        machineId: machine.runnerId,
        machineName: machine.name,
        reason: input.reason,
      },
      presentation: {
        kind: "external",
        subject: { kind: "machine", id: machine.runnerId },
        title: `Allow macOS Full Disk Access on ${machine.name}`,
        detail: input.reason,
      },
      targetWorkspaceId: claims.workspaceId,
      originatingWorkspaceId: claims.workspaceId,
      originatingThreadId: claims.threadId,
      originatingRunId: claims.runId,
      requestedBy: claims.requestedBy,
    });
    for (const event of created.events) this.#onWorkspaceEvent(event);
    return {
      kind,
      replayed: created.replayed,
      requestId: created.request.id,
      status: created.request.status,
    };
  }

  async decline(input: {
    readonly requestId: RequestId;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }) {
    const result = await this.#store.requests.declineMachineFullDiskAccessRequest(input);
    for (const event of result.events) this.#onWorkspaceEvent(event);
    this.#continuations.notify();
    return result;
  }

  async fulfillForMachine(machineId: RunnerId): Promise<void> {
    const result = await this.#store.requests.fulfillMachineFullDiskAccessRequests(machineId);
    for (const event of result.events) this.#onWorkspaceEvent(event);
    if (result.requests.length > 0) this.#continuations.notify();
  }
}
