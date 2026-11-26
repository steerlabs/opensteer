import { OpensteerError, raisedBeforeEffect } from "@opensteer/core";
import { hostApi } from "@opensteer/protocol";
import { commandTable, type CommandRow, type CommandType } from "@opensteer/protocol/command-table";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { commandResultReceipts, runCommandEffect, type CommandAttempts } from "./command-effect.js";

// These commands complete when they return their typed receipt. The status describes a
// separate resource, authentication flow, or approved command with its own outcome.
const completedOnReply: Partial<Record<CommandType, string>> = {
  "thread.create": "The task was created. The returned status is the task's lifecycle.",
  "thread.rename": "The task was renamed. Its lifecycle is independent of the rename.",
  "thread.icon.set": "The icon was saved. The returned status is the task's lifecycle.",
  "thread.inputQueue.resume": "The queue was resumed. The status is the task's lifecycle.",
  "thread.sendMessage": "The message was accepted. The returned Run can still fail.",
  "assignment.cancel":
    "The assignment cancellation was recorded. Its worker has its own lifecycle.",
  "thread.execution.update": "Execution settings were saved. The status is the task's lifecycle.",
  "thread.done.set": "The task's done flag was saved. Task status describes the resulting task.",
  "thread.access.update": "Access was saved. The returned status describes the task.",
  "request.command.approve":
    "This is the person's approval RPC. It carries the inner receipt as-is.",
  "harness.authentication.begin": "Starts an authentication flow. Its state is the output.",
  "harness.authentication.submit": "Answers an authentication step. Its state is the output.",
  "harness.authentication.logout":
    "Requests logout. The authentication envelope is its own UI state.",
  "harness.authentication.cancel": "Cancels the authentication flow. Its state is the output.",
  "integration.computer.setup.set": "The setup choice was saved. Connection readiness is separate.",
  "plugin.authorization.return": "Reconciles an OAuth return. The OAuth state is the output.",
  "plugin.authorization.cancel": "Ends an OAuth attempt and returns its state.",
  "integration.grant.create": "The grant was written. Its own lifecycle status is returned.",
  "channel.connection.create": "The connection was created. Provider readiness is separate.",
  "channel.connection.computer.create":
    "The connection was created. Computer readiness is separate.",
  "trigger.create": "The automation was created. Its status is the automation's lifecycle.",
  "trigger.update": "The automation was updated. Its status is the automation's lifecycle.",
  "trigger.status.set": "The automation status was changed to the requested value.",
  "trigger.run": "The occurrence was accepted. It has its own execution outcome.",
};

function* commandResultVariants(schema: z.ZodType): Generator<z.ZodType> {
  if (schema instanceof z.ZodUnion) {
    for (const option of schema.options) yield* commandResultVariants(option as z.ZodType);
  } else yield schema;
}

function hasOutcomeProperty(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  const { properties } = schema as { properties?: Record<string, unknown> };
  if (properties && ("status" in properties || "outcome" in properties || "failed" in properties))
    return true;
  return Object.values(schema).some(hasOutcomeProperty);
}

it("requires an explicit receipt rule for command outputs that carry a status or outcome", () => {
  const commands = new Set<string>();
  for (const variant of commandResultVariants(hostApi["commands.dispatch"].success)) {
    const [type] = variant._zod.propValues?.type ?? [];
    if (
      typeof type === "string" &&
      Object.hasOwn(commandTable, type) &&
      hasOutcomeProperty(z.toJSONSchema(variant, { io: "input", unrepresentable: "any" }))
    )
      commands.add(type);
  }
  expect([...commands].sort()).toEqual(
    [...Object.keys(commandResultReceipts), ...Object.keys(completedOnReply)].sort(),
  );
});

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
      return { kind: "begun", id };
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

  it("keeps an install receipt with the effect, including the version that became active", async () => {
    const { attempts } = recorded();
    const settle = vi.spyOn(attempts, "settle");
    const output = {
      type: "plugins.install",
      result: {
        status: "installed",
        pluginId: "pets",
        versionId: "v1",
        warnings: ["x".repeat(199) + "😀", ...Array.from({ length: 16 }, () => "x".repeat(204))],
      },
    };
    const effect = await runCommandEffect({
      row: outside,
      attempts,
      attempt: { ...attempt, type: output.type },
      act: async () => output,
    });
    const receipt = {
      status: "done",
      result: {
        type: "plugins.install",
        result: {
          status: "installed",
          pluginId: "pets",
          versionId: "v1",
          warnings: ["x".repeat(199) + "�", ...Array.from({ length: 15 }, () => "x".repeat(200))],
        },
      },
    };
    expect(effect).toEqual({ status: "done", output, receipt });
    expect(settle).toHaveBeenCalledExactlyOnceWith("cat_1", "done", receipt);
  });

  it.each([
    [{ type: "tab.close", closed: ["tab-a"], failed: [{}] }, "unknown", "partial"],
    [{ type: "tab.close", closed: [], failed: [{}] }, "failed", undefined],
    [
      { type: "tab.group.close", closed: ["tab-a"], failed: [], groupClosed: false },
      "unknown",
      "partial",
    ],
    [{ type: "browser.password-sign-in.respond", status: "pending" }, "unknown", "pending"],
    [{ type: "browser.password-sign-in.respond", status: "declined" }, "failed", undefined],
    [{ type: "browser.password-sign-in.respond", status: "cancelled" }, "unknown", "unconfirmed"],
    [{ type: "browser.password-sign-in.respond", status: "withdrawn" }, "unknown", "unconfirmed"],
    [{ type: "browser.password-sign-in.respond", status: "fulfilled" }, "done", undefined],
  ] as const)("records the evidence in %j as %s", async (output, status, progress) => {
    const { attempts, states } = recorded();
    const effect = await runCommandEffect({
      row: outside,
      attempts,
      attempt: { ...attempt, type: output.type },
      act: async () => output,
    });
    expect(effect.status).toBe(status);
    expect([...states.values()]).toEqual([status]);
    if (progress) expect(effect).toMatchObject({ receipt: { progress: { kind: progress } } });
  });

  it.each([
    [
      { type: "machine.access.update", outcome: "conflict" },
      "The device's access settings changed before this command ran.",
    ],
    [
      {
        type: "browser.session.sign-in",
        outcome: {
          status: "problem",
          problem: "chrome-offline",
          site: "https://example.test",
          sourceName: "Private",
        },
      },
      "The Chrome sign-in was not copied.",
    ],
  ])("settles a confirmed returned refusal for $type as failed", async (output, message) => {
    const { attempts, states } = recorded();
    const effect = await runCommandEffect({
      row: outside,
      attempts,
      attempt: { ...attempt, type: output.type },
      act: async () => output,
    });
    expect(effect).toMatchObject({ status: "failed", receipt: { message } });
    expect([...states.values()]).toEqual(["failed"]);
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

  it("sends a key once: running or unknown before, it answers unknown and does not act (K1)", async () => {
    for (const state of ["running", "unknown"] as const) {
      const act = vi.fn(async () => "ok");
      const attempts: CommandAttempts = {
        begin: async () => ({ kind: "prior", state }),
        settle: async () => {
          throw new Error("nothing to settle");
        },
      };
      expect((await runCommandEffect({ row: outside, attempts, attempt, act })).status).toBe(
        "unknown",
      );
      expect(act).not.toHaveBeenCalled();
    }
    // Done: the handler's own lookup answers, and no attempt is settled.
    const settle = vi.fn(async () => undefined);
    expect(
      await runCommandEffect({
        row: outside,
        attempts: { begin: async () => ({ kind: "prior", state: "done" }), settle },
        attempt,
        act: async () => "replayed",
      }),
    ).toEqual({ status: "done", output: "replayed" });
    expect(settle).not.toHaveBeenCalled();
  });
});
