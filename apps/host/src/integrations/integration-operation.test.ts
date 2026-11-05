import type { CallableIntegrationTool } from "@opensteer/database";
import { describe, expect, it } from "vitest";
import { describedOperation, operationAddress, resolveOperation } from "./integration-operation.js";

function operation(input: {
  readonly account?: string | null;
  readonly digest?: string;
  readonly id?: string;
  readonly name?: string;
}): CallableIntegrationTool {
  return {
    grant: { alias: `Alias ${input.account}`, connectionId: input.account ?? null },
    tool: {
      id: input.id ?? "itl_1",
      name: input.name ?? "list",
      schemaDigest: input.digest ?? "digest",
    },
  } as unknown as CallableIntegrationTool;
}

describe("resolveOperation", () => {
  it("needs an account for an account-backed operation, even with only one", () => {
    const only = operation({ account: "con_1" });
    expect(resolveOperation([only], operationAddress(only), undefined)).toEqual({
      kind: "account-required",
      candidates: [only],
    });
    expect(resolveOperation([only], operationAddress(only), "con_1")).toEqual({
      kind: "found",
      callable: only,
    });
  });

  it("never lets one account's call reach another account", () => {
    const personal = operation({ account: "con_1" });
    const work = operation({ account: "con_2" });
    const address = operationAddress(work);
    expect(address).toBe(operationAddress(personal));
    expect(resolveOperation([personal, work], address, "con_2")).toEqual({
      kind: "found",
      callable: work,
    });
    expect(resolveOperation([personal], address, "con_2")).toEqual({ kind: "none" });
  });

  it("calls an operation with no account without one", () => {
    const open = operation({ account: null });
    expect(resolveOperation([open], operationAddress(open), undefined)).toEqual({
      kind: "found",
      callable: open,
    });
  });

  // A generated name like account.get2 can move to another endpoint when a spec changes.
  it("does not let a held address reach a different operation that took its name", () => {
    const held = operationAddress(operation({ id: "itl_old" }));
    const replacement = operation({ account: "con_1", id: "itl_new" });
    expect(resolveOperation([replacement], held, "con_1")).toEqual({ kind: "changed" });
  });

  it("stops matching when the operation's schema changes", () => {
    const held = operationAddress(operation({ digest: "before" }));
    const changed = operation({ account: "con_1", digest: "after" });
    expect(resolveOperation([changed], held, "con_1")).toEqual({ kind: "changed" });
  });

  it("follows an operation renamed in place, which keeps its identity", () => {
    const held = operationAddress(operation({ name: "account.get2" }));
    const renamed = operation({ account: "con_1", name: "account.getDetails" });
    expect(resolveOperation([renamed], held, "con_1")).toEqual({
      kind: "found",
      callable: renamed,
    });
  });

  it("accepts a bare name only when it means one operation", () => {
    const gmail = operation({ account: "con_1" });
    const slack = operation({ account: "con_1", id: "itl_2" });
    expect(resolveOperation([gmail], "list", "con_1")).toEqual({ kind: "found", callable: gmail });
    expect(resolveOperation([gmail, slack], "list", "con_1")).toEqual({
      kind: "ambiguous",
      operations: [operationAddress(gmail), operationAddress(slack)].sort(),
    });
  });

  it("reports nothing for a name this caller cannot reach", () => {
    expect(resolveOperation([operation({})], "send", "con_1")).toEqual({ kind: "none" });
  });
});

describe("describedOperation", () => {
  it("describes any account's copy of one operation without naming an account", () => {
    const first = operation({ account: "con_1" });
    const second = operation({ account: "con_2" });
    expect(
      describedOperation(resolveOperation([first, second], operationAddress(first), undefined)),
    ).toBe(first);
  });
});
