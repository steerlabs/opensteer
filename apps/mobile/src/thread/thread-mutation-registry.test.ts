import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetThreadMutationRegistryForTests,
  threadMutationEntry,
  threadMutationScopeKey,
} from "./thread-mutation-registry.js";

const scope = { deploymentId: "dep_1", threadId: "thr_1", userId: "usr_1" };

describe("thread mutation registry", () => {
  beforeEach(() => resetThreadMutationRegistryForTests());

  it("hands two surfaces the same gate for one scope", () => {
    const composer = threadMutationEntry(scope, "message");
    const sheet = threadMutationEntry(scope);
    expect(sheet.gate).toBe(composer.gate);
    // The composer's durable pending send is the claim the sheet sees.
    expect(sheet.owner()).toBe("message");
    expect(sheet.gate.acquire("settings")).toBeNull();
    const pending = composer.gate.resume("message");
    if (pending === null) throw new Error("the durable claim was not resumable");
    composer.gate.release(pending);
    expect(sheet.gate.acquire("settings")).not.toBeNull();
    expect(composer.owner()).toBe("settings");
  });

  it("keeps scopes apart by deployment, user and thread", () => {
    const a = threadMutationEntry(scope, "request");
    const otherUser = threadMutationEntry({ ...scope, userId: "usr_2" });
    const otherThread = threadMutationEntry({ ...scope, threadId: "thr_2" });
    expect(otherUser.gate).not.toBe(a.gate);
    expect(otherThread.gate).not.toBe(a.gate);
    expect(otherUser.gate.acquire("message")).not.toBeNull();
    expect(threadMutationScopeKey(scope)).not.toBe(
      threadMutationScopeKey({ ...scope, userId: null }),
    );
  });

  it("does not let a later initial owner overwrite a live claim", () => {
    threadMutationEntry(scope, "message");
    const again = threadMutationEntry(scope, "settings");
    expect(again.owner()).toBe("message");
  });

  /**
   * The hook reads its entry once, in a memo, and subscribes in an effect. A
   * replayed effect — Strict Mode, a Fast Refresh — tears the subscription down
   * and sets it up again while that memo still holds the first entry, so this
   * walks that lifecycle through the exported surface: one gate throughout, or
   * the pane and the sheet would be mutating two.
   */
  it("keeps one gate across a subscription teardown and replay", () => {
    const retained = threadMutationEntry(scope);
    const notified = vi.fn();
    retained.subscribe(notified)();
    const resubscribed = retained.subscribe(notified);

    const sheet = threadMutationEntry(scope);
    expect(sheet.gate).toBe(retained.gate);
    const settings = sheet.gate.acquire("settings");
    if (settings === null) throw new Error("the settings claim was refused");
    expect(retained.owner()).toBe("settings");
    expect(notified).toHaveBeenCalledTimes(1);
    expect(retained.gate.acquire("message")).toBeNull();

    resubscribed();
    sheet.gate.release(settings);
    // The last watcher leaving does not forget a Thread: the next mount has to
    // find this gate, not a second one that believes the Thread is idle.
    expect(threadMutationEntry(scope).gate).toBe(retained.gate);
    expect(notified).toHaveBeenCalledTimes(1);
  });

  it("keeps a claim a surface left in flight after every listener goes", () => {
    const entry = threadMutationEntry(scope);
    const stop = entry.subscribe(() => undefined);
    const claim = entry.gate.acquire("settings");
    if (claim === null) throw new Error("the settings claim was refused");
    // The sheet is dismissed while the Host has yet to answer.
    stop();
    const reopened = threadMutationEntry(scope);
    expect(reopened.gate).toBe(entry.gate);
    expect(reopened.owner()).toBe("settings");
    expect(reopened.gate.acquire("message")).toBeNull();
  });
});
