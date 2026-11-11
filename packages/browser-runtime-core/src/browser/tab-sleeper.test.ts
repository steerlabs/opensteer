import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeContext, FakePage } from "../test-support/fakes.js";
import { SurfaceLedger, type TabRecord } from "./surface-ledger.js";
import { TabSleeper } from "./tab-sleeper.js";

describe("TabSleeper", () => {
  afterEach(() => vi.useRealTimers());
  async function fixture() {
    vi.useFakeTimers();
    const page = new FakePage({ url: "https://leftover.test/" });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    await vi.advanceTimersByTimeAsync(0);
    const record = [...ledger.policyRecords()][0]!;
    record.origin = "agent";
    record.personUsed = false;
    const sleeper = new TabSleeper();
    sleeper.add("session", { ledger, restoreVersion: 1, blocked: () => null });
    return {
      page,
      ledger,
      record,
      sleeper,
      close: async () => {
        sleeper.close();
        await ledger.close();
      },
    };
  }
  it("waits for Host state and release, and a Watch pin never makes a tab a person's", async () => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.record.live).not.toBeNull();
      f.sleeper.setSessionState("session", { runs: 1, viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.record.live).not.toBeNull();
      f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [f.record.id] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.record.live).not.toBeNull();
      expect(f.record.personUsed).toBe(false);
      f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.record.live).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it.each([
    "unknown",
    "keepAwake",
    "viewed",
    "pinned",
    "restore",
    "busy",
    "agentActed",
    "typed",
    "quiet",
    "dialog",
    "loading",
    "navigation",
    "opener",
    "unrestorable",
    "address",
    "external",
  ])("protects %s", async (reason) => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(70_000);
      let state = {
        runs: 0,
        viewed: [] as (typeof f.record.id)[],
        pinned: [] as (typeof f.record.id)[],
        keepAwake: false,
      };
      if (reason === "keepAwake") state.keepAwake = true;
      if (reason === "viewed") state.viewed = [f.record.id];
      if (reason === "pinned") state.pinned = [f.record.id];
      if (reason !== "unknown") f.sleeper.setSessionState("session", state);
      if (reason === "restore") f.sleeper.add("session", { ledger: f.ledger, blocked: () => null });
      if (reason === "busy") void f.record.lease.use(() => new Promise<void>(() => {}));
      if (reason === "agentActed") {
        f.record.agentActed = true;
        f.sleeper.setSessionState("session", { ...state, runs: 1 });
      }
      if (reason === "typed") f.record.typed = true;
      if (reason === "quiet") f.record.usedAt = Date.now();
      if (reason === "dialog")
        f.page.cdpSession.emit("Page.javascriptDialogOpening", { type: "alert", message: "Wait" });
      if (reason === "loading") f.record.live!.loading = true;
      if (reason === "navigation") f.record.live!.pendingNavigations.set("pending", {} as never);
      if (reason === "opener") {
        const sibling = { ...f.record, id: "sibling" as typeof f.record.id } as TabRecord;
        f.record.openerId = sibling.id;
        vi.spyOn(f.ledger, "policyRecords").mockReturnValue([f.record, sibling]);
      }
      if (reason === "unrestorable") f.record.unrestorable = true;
      if (reason === "address") f.record.url = "file:///tmp/not-restorable";
      if (reason === "external")
        f.sleeper.add("session", { ledger: f.ledger, restoreVersion: 1, blocked: () => "native" });
      expect(f.sleeper.blocked("session", f.record, Date.now())).not.toBeNull();
    } finally {
      await f.close();
    }
  });
  it("disarms after the last batch of eight live tabs sleeps", async () => {
    const f = await fixture();
    try {
      for (let i = 1; i < 8; i++) await f.ledger.openSurface();
      for (const record of f.ledger.policyRecords()) {
        record.origin = "agent";
        record.personUsed = false;
      }
      f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.ledger.snapshot().every((tab) => tab.state === "suspended")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("uses one timer for 500 live tabs and none after removal", async () => {
    const f = await fixture();
    try {
      const records = Array.from({ length: 500 }, (_, i) => ({
        ...f.record,
        id: `surface_${i}` as typeof f.record.id,
        order: i,
      }));
      vi.spyOn(f.ledger, "policyRecords").mockImplementation(() => records);
      f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [] });
      expect(vi.getTimerCount()).toBe(1);
      f.sleeper.poke();
      expect(vi.getTimerCount()).toBe(1);
      f.sleeper.remove("session");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });
});
