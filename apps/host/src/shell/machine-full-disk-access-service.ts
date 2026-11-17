import {
  OpensteerError,
  type RequestId,
  type RequestResponse,
  type RunnerId,
  type UserId,
} from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RequestCreationResult } from "@opensteer/protocol";
import type { RunToolScope } from "../agents/run-tool-tokens.js";

type FullAccessStore = Pick<OpensteerStore, "listReachableMachines" | "requireSelfDeviceId"> & {
  readonly requests: Pick<
    OpensteerStore["requests"],
    "create" | "declineMachineFullDiskAccessRequest" | "fulfillMachineFullDiskAccessRequests"
  >;
};

export class MachineFullDiskAccessService {
  readonly #store: FullAccessStore;

  readonly #probe: ((runnerId: RunnerId) => void) | undefined;

  constructor(options: {
    readonly store: FullAccessStore;
    readonly probe?: (runnerId: RunnerId) => void;
  }) {
    this.#store = options.store;
    this.#probe = options.probe;
  }

  async request(input: {
    readonly callId: string;
    readonly computerId: RunnerId;
    readonly reason: string;
    readonly claims: RunToolScope;
  }): Promise<RequestCreationResult & { kind: "machine.full-disk-access" }> {
    const { claims } = input;
    const machines = await this.#store.listReachableMachines(claims.requestedBy, claims.runnerId);
    const machine = machines.find((entry) => entry.runnerId === input.computerId);
    if (!machine)
      throw new OpensteerError({
        code: "bad_request",
        message: `This Run reaches no computer with that computerId over SSH.${
          machines.length
            ? ` It reaches ${machines.map(({ name, runnerId }) => `${name} (${runnerId})`).join(", ")}.`
            : ""
        }`,
      });
    if (machine.platform !== "darwin")
      throw new OpensteerError({
        code: "bad_request",
        message: `${machine.name} is not a Mac, so macOS Full Disk Access does not apply.`,
      });
    this.#probe?.(machine.runnerId);
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
        machineId: await this.#store.requireSelfDeviceId(machine.runnerId),
        machineName: machine.name,
        reason: input.reason,
      },
      presentation: {
        kind: "external",
        subject: { kind: "machine", id: machine.runnerId },
        title: `Allow macOS Full Disk Access on ${machine.name}`,
        detail: input.reason,
      },
      originatingThreadId: claims.threadId,
      originatingRunId: claims.runId,
      requestedBy: claims.requestedBy,
    });
    return {
      kind,
      replayed: created.replayed,
      requestId: created.request.id,
      status: created.request.status,
    };
  }

  async decline(input: {
    readonly requestId: RequestId;
    readonly expectedRevision: string;
    readonly resolvedBy: UserId;
    readonly response: RequestResponse;
  }) {
    const result = await this.#store.requests.declineMachineFullDiskAccessRequest(input);
    return result;
  }

  async fulfillForMachine(machineId: RunnerId): Promise<void> {
    await this.#store.requests.fulfillMachineFullDiskAccessRequests(machineId);
  }
}
