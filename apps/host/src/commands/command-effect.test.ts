import { OpensteerError, raisedBeforeEffect } from "@opensteer/core";
import { commandTable, type CommandRow } from "@opensteer/protocol/command-table";
import { describe, expect, it, vi } from "vitest";
import { runCommandEffect, type CommandAttempts } from "./command-effect.js";

const outside = commandTable["machine.revoke"] as CommandRow;
const database = commandTable["harness.rename"] as CommandRow;
const attempt = {
  requestedBy: "usr_owner" as never,
  callerKey: "connection:conn_1",
  connectionId: "conn_1",
  type: "machine.revoke",
  idempotencyKey: "k",
};

/** Attempts kept in memory, with the last admission run where the attempt is recorded. */
function recorded() {
  const states = new Map<string, string>();
  const attempts: CommandAttempts = {
    begin: async (_input, readmit) => {
      await readmit?.({} as never);
      const id = `cat_${states.size + 1}`;
      states.set(id, "running");
      return id;
    },
    settle: async (id, state) => {
      states.set(id, state);
    },
  };
  return { attempts, states };
}

describe("the one way a command acts (G4)", () => {
  it("records an outside command before it acts and settles what is known of it", async () => {
    const { attempts, states } = recorded();
    expect(
      await runCommandEffect({ row: outside, attempts, attempt, act: async () => "ok" }),
    ).toEqual({ status: "done", output: "ok" });
    // An error after the effect may have happened: unknown, never failed.
    const after = await runCommandEffect({
      row: outside,
      attempts,
      attempt,
      act: async () => {
        throw new OpensteerError({ code: "conflict", message: "The computer went away" });
      },
    });
    expect(after.status).toBe("unknown");
    // Only an error marked where it was raised, before anything was sent, is a failure.
    const before = await runCommandEffect({
      row: outside,
      attempts,
      attempt,
      act: async () => {
        throw raisedBeforeEffect(new OpensteerError({ code: "conflict", message: "Not there" }));
      },
    });
    expect(before.status).toBe("failed");
    expect([...states.values()]).toEqual(["done", "unknown", "failed"]);
  });

  it("acts only after its last admission, which records nothing when it refuses (G3)", async () => {
    const { attempts, states } = recorded();
    const act = vi.fn(async () => "ok");
    const refusal = new OpensteerError({ code: "forbidden", message: "Access changed" });
    await expect(
      runCommandEffect({
        row: outside,
        attempts,
        attempt,
        readmit: async () => {
          throw refusal;
        },
        act,
      }),
    ).rejects.toBe(refusal);
    expect(act).not.toHaveBeenCalled();
    expect(states.size).toBe(0);
  });

  it("records no attempt for a database-only command, whose own refusal is a failure", async () => {
    const { attempts, states } = recorded();
    const refused = await runCommandEffect({
      row: database,
      attempts,
      attempt,
      act: async () => {
        throw new OpensteerError({ code: "conflict", message: "Changed meanwhile" });
      },
    });
    expect(refused.status).toBe("failed");
    // A commit lost on the way may have happened.
    const lost = await runCommandEffect({
      row: database,
      attempts,
      attempt,
      act: async () => {
        throw new Error("The database went away mid-commit");
      },
    });
    expect(lost.status).toBe("unknown");
    expect(states.size).toBe(0);
  });
});
