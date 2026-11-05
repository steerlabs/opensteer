import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { PhoneTabs } from "./phone-tabs.js";

const owner = createId("user");
const machine = createId("runner");

function tabs(input: { held?: boolean; opened?: boolean; effectiveOwner?: typeof owner } = {}) {
  const store = {
    closePhoneTab: vi.fn(async () => undefined),
    effectiveMachineOwners: vi.fn(
      async () => new Map([[machine, { effectiveOwner: input.effectiveOwner ?? owner }]]),
    ),
    openPhoneTab: vi.fn(async () => input.opened ?? true),
  };
  const closeViews = vi.fn();
  const changed = vi.fn();
  const onError = vi.fn();
  const service = new PhoneTabs({
    store: store as never,
    heldByTask: () => input.held ?? false,
    closeViews,
    changed,
    onError,
  });
  return { changed, closeViews, onError, service, store };
}

describe("phone tabs", () => {
  it("publishes only after the tab is recorded, and only when that changed anything", async () => {
    const first = tabs();
    first.service.opened(machine);
    expect(first.changed).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(first.changed).toHaveBeenCalledOnce());

    const again = tabs({ opened: false });
    again.service.opened(machine);
    await vi.waitFor(() => expect(again.store.openPhoneTab).toHaveBeenCalledOnce());
    await Promise.resolve();
    expect(again.changed).not.toHaveBeenCalled();
  });

  it("closes the tab and the person's view of the phone together", async () => {
    const test = tabs();
    await test.service.close(owner, machine);
    expect(test.closeViews).toHaveBeenCalledExactlyOnceWith(owner, machine);
    expect(test.store.closePhoneTab).toHaveBeenCalledExactlyOnceWith(machine);
    expect(test.changed).toHaveBeenCalledOnce();
  });

  it("refuses anyone but the phone's effective owner", async () => {
    const test = tabs({ effectiveOwner: createId("user") });
    await expect(test.service.close(owner, machine)).rejects.toMatchObject({ code: "not_found" });
    expect(test.store.closePhoneTab).not.toHaveBeenCalled();
    expect(test.closeViews).not.toHaveBeenCalled();
  });

  it("refuses while a task holds the phone, whatever a stale client believes", async () => {
    const test = tabs({ held: true });
    await expect(test.service.close(owner, machine)).rejects.toMatchObject({ code: "conflict" });
    expect(test.store.closePhoneTab).not.toHaveBeenCalled();
    expect(test.closeViews).not.toHaveBeenCalled();
  });
});
