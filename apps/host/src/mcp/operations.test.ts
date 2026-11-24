import { opensteer_task_delegate, opensteer_task_send } from "@opensteer/agent-tools/tools";
import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import type { AgentCaller } from "./agent-caller.js";
import { fingerprint, operationId, toolOperationKey } from "./operations.js";

describe("domain operation identity", () => {
  it("canonicalizes input while excluding only the top-level operationKey", () => {
    const input = { operationKey: "first", b: 2, a: { operationKey: "nested" } };
    expect(fingerprint(input)).toBe(
      fingerprint({ a: { operationKey: "nested" }, b: 2, operationKey: "second" }),
    );
    expect(fingerprint(input)).not.toBe(
      fingerprint({ ...input, a: { operationKey: "different" } }),
    );
  });
  it("uses operationKey without any watch observationId fallback and rejects observationId in task tool schemas (AA7)", () => {
    const watch = { kind: "program", program: { kind: "watch" } } as AgentCaller;
    expect(toolOperationKey(watch, { operationKey: "explicit" }, "rpc")).toBe("explicit");
    expect(toolOperationKey(watch, { observationId: "seen" }, "rpc")).toBe("rpc");
    expect(toolOperationKey(watch, {}, "rpc")).toBe("rpc");
    expect(
      opensteer_task_send.input.safeParse({
        delivery: "queue",
        message: "hello",
        observationId: "legacy-obs",
        taskId: createId("thread"),
      }).success,
    ).toBe(false);
    expect(
      opensteer_task_delegate.input.safeParse({
        message: "hello",
        observationId: "legacy-obs",
      }).success,
    ).toBe(false);
  });
  it("namespaces a domain key by caller and tool", () => {
    const caller = { kind: "connection", key: "connection:one" } as AgentCaller;
    const key = operationId(caller, "same", "opensteer_task_send");
    expect(
      operationId({ ...caller, key: "connection:two" }, "same", "opensteer_task_send"),
    ).not.toBe(key);
    expect(operationId(caller, "same", "opensteer_task_delegate")).not.toBe(key);
  });
});
