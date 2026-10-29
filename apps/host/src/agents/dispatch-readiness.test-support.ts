import type { CommandId, MessageId, RunId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { vi } from "vitest";

export function observeDispatchReadiness(store: OpensteerStore) {
  let observedInputId: MessageId | undefined;
  const retries: Awaited<ReturnType<typeof snapshot>>[] = [];
  const retryCommand = store.retryCommand.bind(store);
  vi.spyOn(store, "retryCommand").mockImplementation(async (commandId, error) => {
    const events = await retryCommand(commandId, error);
    retries.push(await snapshot(commandId));
    return events;
  });
  const loadContext = store.loadRunDispatchContext.bind(store);
  let gate:
    | {
        readonly commandId: CommandId;
        readonly entered: () => void;
        readonly released: Promise<void>;
      }
    | undefined;
  // Dispatch reads its Runner only after this context, so holding it here
  // lets that Runner leave in between.
  vi.spyOn(store, "loadRunDispatchContext").mockImplementation(async (commandId) => {
    const context = await loadContext(commandId);
    if (gate?.commandId === commandId) {
      const held = gate;
      gate = undefined;
      held.entered();
      await held.released;
    }
    return context;
  });

  async function snapshot(commandId: CommandId) {
    const command = await store.database
      .selectFrom("commands")
      .select(["id", "runId", "attempts", "status", "lastError"])
      .where("id", "=", commandId)
      .executeTakeFirstOrThrow();
    if (!command.runId) throw new Error("Retry has no Run");
    const run = await store.database
      .selectFrom("runs")
      .select([
        "id",
        "status",
        "failure",
        "bindingGeneration",
        "reportContext",
        "initialContext",
        "activationInputId",
      ])
      .where("id", "=", command.runId)
      .executeTakeFirstOrThrow();
    const inputs = await store.database
      .selectFrom("threadInputs")
      .select(["messageId", "runId", "state", "cancelReason", "policy"])
      .where("messageId", "=", observedInputId ?? run.activationInputId)
      .execute();
    const attempts = await store.database
      .selectFrom("runAttempts")
      .select("id")
      .where("runId", "=", command.runId)
      .execute();
    return { command, inputs, run, runAttempts: attempts, recordedAt: new Date().toISOString() };
  }

  return {
    observeInput: (messageId: MessageId) => {
      observedInputId = messageId;
    },
    retries,
    snapshot,
    holdDispatch: (commandId: CommandId) => {
      let entered = false;
      const released = Promise.withResolvers<void>();
      gate = {
        commandId,
        entered: () => {
          entered = true;
        },
        released: released.promise,
      };
      return { isEntered: () => entered, release: released.resolve };
    },
    snapshotsFor: (runId: RunId) => retries.filter((retry) => retry.run.id === runId),
  };
}
