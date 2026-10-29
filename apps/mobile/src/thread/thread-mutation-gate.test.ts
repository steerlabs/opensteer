import { describe, expect, it, vi } from "vitest";
import {
  createThreadMutationGate,
  type ThreadMutationClaim,
  type ThreadMutationGate,
  type ThreadMutationOwner,
} from "./thread-mutation-gate.js";

/** The claim a case is about to hold, so a refusal fails the case by name. */
function held(claim: ThreadMutationClaim | null, owner: ThreadMutationOwner): ThreadMutationClaim {
  if (claim === null) throw new Error(`the ${owner} claim was refused`);
  return claim;
}

function acquired(gate: ThreadMutationGate, owner: ThreadMutationOwner): ThreadMutationClaim {
  return held(gate.acquire(owner), owner);
}

describe("thread mutation ownership", () => {
  it("blocks model changes throughout a pending send and allows its retry", () => {
    const changed = vi.fn();
    const gate = createThreadMutationGate("message", changed);
    expect(gate.acquire("settings")).toBeNull();
    // The send found on disk is this bar's own claim, so its retry continues
    // that claim instead of competing for a second one.
    const pending = held(gate.resume("message"), "message");
    expect(gate.acquire("message")).toBeNull();
    gate.release(pending);
    expect(gate.acquire("settings")).not.toBeNull();
    expect(changed.mock.calls).toEqual([[null], ["settings"]]);
  });

  it("prevents a send in the same event turn as an execution change", () => {
    const gate = createThreadMutationGate(null, () => undefined);
    const settings = acquired(gate, "settings");
    expect(gate.acquire("message")).toBeNull();
    gate.release(settings);
    expect(acquired(gate, "message").owner).toBe("message");
    expect(gate.acquire("settings")).toBeNull();
  });

  it("holds a request answer against sends and settings until it settles", () => {
    const gate = createThreadMutationGate(null, () => undefined);
    const answer = acquired(gate, "request");
    expect(gate.acquire("message")).toBeNull();
    expect(gate.acquire("settings")).toBeNull();
    expect(gate.acquire("request")).toBeNull();
    gate.release(answer);
    expect(gate.acquire("message")).not.toBeNull();
  });

  it("refuses a second settings change while a dismissed sheet's own is pending", () => {
    const changed = vi.fn();
    const gate = createThreadMutationGate(null, changed);
    // The sheet starts a model change and is dismissed before the Host answers.
    const sheet = acquired(gate, "settings");
    // The AI settings sheet makes the same kind of change, and there is
    // one to make at a time however it is reached. Send waits for it too.
    expect(gate.acquire("settings")).toBeNull();
    expect(gate.acquire("message")).toBeNull();
    gate.release(sheet);
    expect(changed.mock.calls).toEqual([["settings"], [null]]);
    expect(gate.acquire("message")).not.toBeNull();
  });

  it("ignores a release from an operation that no longer holds the thread", () => {
    const gate = createThreadMutationGate(null, () => undefined);
    const first = acquired(gate, "settings");
    gate.release(first);
    const second = acquired(gate, "settings");
    // The dismissed change answers late: its claim is spent, and freeing a
    // Thread another change is holding is not its to do.
    gate.release(first);
    expect(gate.acquire("message")).toBeNull();
    gate.release(second);
    expect(gate.acquire("message")).not.toBeNull();
  });

  it("resumes nothing for a kind that is not holding the thread", () => {
    const gate = createThreadMutationGate(null, () => undefined);
    acquired(gate, "settings");
    expect(gate.resume("message")).toBeNull();
    expect(gate.resume("request")).toBeNull();
  });
});
