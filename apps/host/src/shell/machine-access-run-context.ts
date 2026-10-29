import type { RunnerId, UserId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import type { RunnerRegistry } from "@opensteer/orchestration";
import {
  allocateMachineAliases,
  budgetReachableMachines,
  MachineAccessRunContextSchema,
  runnerCommandMaxSerializedBytes,
  type MachineAccessRunContext,
  type MachineAccessRunMachine,
} from "@opensteer/protocol";

/**
 * The Run's computer and the other computers it may reach, fixed at dispatch.
 *
 * Three bounds apply and all three are real: at most 32 entries, at most 128
 * KiB of serialized machine list, and — because the list travels inside a Run
 * command that already carries the Thread's history — whatever is left of the
 * command's own size cap. Machines are dropped whole from the end of a stable
 * order until all three hold, never truncated, because half a machine's share
 * list would describe access the target does not actually grant. Everything
 * dropped is counted so the agent-facing note can say how many were left off.
 */
export async function computeMachineAccess(options: {
  /** The Run's own computer, as the Deployment names it. */
  readonly callerMachineName: string;
  readonly callerRunnerId: RunnerId;
  readonly requestedBy: UserId;
  readonly runners: Pick<RunnerRegistry, "isRunnerConnected">;
  /** The rest of the command this list has to fit inside. */
  readonly serializedCommandBytes: (context: MachineAccessRunContext) => number;
  readonly store: Pick<OpensteerStore, "listReachableMachines">;
}): Promise<MachineAccessRunContext> {
  const { callerMachineName } = options;
  const reachable = await options.store.listReachableMachines(
    options.requestedBy,
    options.callerRunnerId,
  );
  const aliases = allocateMachineAliases(reachable);
  const machines: MachineAccessRunMachine[] = reachable.flatMap((machine) => {
    const alias = aliases.get(machine.runnerId);
    if (!alias) return [];
    return [
      {
        alias,
        commands: machine.commands,
        forwarding: machine.forwarding,
        fullDiskAccess: machine.fullDiskAccess,
        hostPublicKey: machine.hostPublicKey,
        lastSeenAt: machine.lastSeenAt?.toISOString() ?? null,
        name: machine.name,
        platform: machine.platform,
        runnerId: machine.runnerId,
        shares: machine.shares,
        status: options.runners.isRunnerConnected(machine.runnerId) ? "online" : "offline",
      },
    ];
  });
  const budgeted = budgetReachableMachines(callerMachineName, machines);
  let kept = [...budgeted.machines];
  let omitted = budgeted.omittedMachines;
  let context = runContext(callerMachineName, kept, omitted);
  while (
    kept.length > 0 &&
    options.serializedCommandBytes(context) > runnerCommandMaxSerializedBytes
  ) {
    kept.pop();
    omitted += 1;
    context = runContext(callerMachineName, kept, omitted);
  }
  return context;
}

function runContext(
  callerMachineName: string,
  machines: readonly MachineAccessRunMachine[],
  omittedMachines: number,
): MachineAccessRunContext {
  return MachineAccessRunContextSchema.parse({
    callerMachineName,
    machines: [...machines],
    omittedMachines,
  });
}
