import { createId } from "@opensteer/core";
import { CorrelationIdSchema, type RunnerCommand } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { CommandLedger, type CommandDecision } from "./command-ledger.js";

describe("CommandLedger", () => {
  it("coalesces duplicate commands and rejects identity reuse", async () => {
    const ledger = new CommandLedger();
    const command = interruptCommand();
    let executions = 0;
    const operation = async () => {
      executions += 1;
      return { status: "accepted" as const };
    };

    const [first, duplicate] = await Promise.all([
      ledger.execute(command, operation),
      ledger.execute(command, operation),
    ]);
    expect(first.status).toBe("accepted");
    expect(duplicate.status).toBe("accepted");
    expect(executions).toBe(1);

    const conflict = await ledger.execute({ ...command, threadId: createId("thread") }, operation);
    expect(conflict).toMatchObject({ error: { code: "conflict" }, status: "rejected" });
    expect(executions).toBe(1);
  });

  it("forgets a retryable rejection so the Host's retry is admitted again", async () => {
    const ledger = new CommandLedger();
    const command = interruptCommand();
    let executions = 0;
    const operation = async (): Promise<CommandDecision> => {
      executions += 1;
      return executions === 1
        ? {
            error: { code: "conflict", message: "Runner is saturated", retryable: true },
            status: "rejected",
          }
        : { status: "accepted" };
    };

    expect(await ledger.execute(command, operation)).toMatchObject({ status: "rejected" });
    // The Host retries the same command ID, possibly with changed content
    // (a new execution generation); neither replays the refusal nor conflicts.
    expect(await ledger.execute({ ...command, runId: createId("run") }, operation)).toEqual({
      status: "accepted",
    });
    expect(executions).toBe(2);

    // An accepted command stays coalesced exactly as before.
    expect(await ledger.execute({ ...command, runId: createId("run") }, operation)).toMatchObject({
      error: { code: "conflict", retryable: false },
      status: "rejected",
    });
    expect(executions).toBe(2);
  });
});

function interruptCommand(): Extract<RunnerCommand, { type: "run.interrupt" }> {
  return {
    commandId: createId("command"),
    correlationId: CorrelationIdSchema.parse("test-command"),
    environmentId: createId("environment"),
    runId: createId("run"),
    threadId: createId("thread"),
    type: "run.interrupt",
  };
}
