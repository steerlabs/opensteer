import { describe, expect, it } from "vitest";
import { BoundedRunnerInbox } from "./bounded-inbox.js";

describe("BoundedRunnerInbox", () => {
  it("rejects item and byte overflow without growing the queue", async () => {
    const byItems = new BoundedRunnerInbox<string>({ maxBytes: 10, maxItems: 1 });
    byItems.push({ bytes: 1, value: "first" });
    expect(() => byItems.push({ bytes: 1, value: "second" })).toThrow("bounded input queue");
    expect((await byItems[Symbol.asyncIterator]().next()).value).toBe("first");

    const byBytes = new BoundedRunnerInbox<string>({ maxBytes: 3, maxItems: 10 });
    byBytes.push({ bytes: 2, value: "first" });
    expect(() => byBytes.push({ bytes: 2, value: "second" })).toThrow("bounded input queue");
    expect((await byBytes[Symbol.asyncIterator]().next()).value).toBe("first");
  });

  it("delivers to a waiting consumer and drops queued work when closed", async () => {
    const inbox = new BoundedRunnerInbox<string>({ maxBytes: 10, maxItems: 2 });
    const iterator = inbox[Symbol.asyncIterator]();
    const waiting = iterator.next();
    inbox.push({ bytes: 3, value: "direct" });
    expect(await waiting).toEqual({ done: false, value: "direct" });

    inbox.push({ bytes: 3, value: "discarded" });
    inbox.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });
  it("retains commands in order while selecting a handshake response within the same limits", async () => {
    const inbox = new BoundedRunnerInbox<string>({ maxBytes: 6, maxItems: 2 });
    inbox.push({ bytes: 3, value: "provision" });
    const ticket = inbox.nextMatching((value) => value === "ticket");
    inbox.push({ bytes: 3, value: "inspect" });
    expect(() => inbox.push({ bytes: 1, value: "overflow" })).toThrow("bounded input queue");
    inbox.push({ bytes: 1, value: "ticket" });
    expect(await ticket).toEqual({ done: false, value: "ticket" });
    const iterator = inbox[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("provision");
    expect((await iterator.next()).value).toBe("inspect");
    inbox.push({ bytes: 3, value: "provision" });
    inbox.push({ bytes: 1, value: "ticket" });
    expect((await inbox.nextMatching((value) => value === "ticket")).value).toBe("ticket");
    expect((await iterator.next()).value).toBe("provision");
  });
});
