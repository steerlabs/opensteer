import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeContext, FakePage } from "../test-support/fakes.js";
import { SurfaceLedger, type TabRecord } from "./surface-ledger.js";
import { TabSleeper } from "./tab-sleeper.js";

describe("TabSleeper", () => {
  afterEach(() => vi.useRealTimers());
  async function fixture(options: ConstructorParameters<typeof TabSleeper>[0] = {}) {
    vi.useFakeTimers();
    const page = new FakePage({ url: "https://leftover.test/" });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    await vi.advanceTimersByTimeAsync(0);
    const record = [...ledger.policyRecords()][0]!;
    record.origin = "agent";
    record.personUsed = false;
    const sleeper = new TabSleeper(options);
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
        Object.defineProperty(f.page, "hasOpenerAccess", { value: undefined });
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
  it("drops least recently used sleeping engine state at the runtime restore budget", async () => {
    const f = await fixture();
    try {
      await f.ledger.sleep(f.record.id, () => null);
      const records = Array.from({ length: 66 }, (_, i) => ({
        ...f.record,
        live: null,
        usedAt: i,
        restore: { url: f.record.url, engine: { saved: true }, bytes: 1024 ** 2 },
      }));
      vi.spyOn(f.ledger, "policyRecords").mockReturnValue(records);
      f.sleeper.poke();
      expect(records.slice(0, 2).map((record) => record.restore.engine)).toEqual([null, null]);
      expect(records.slice(2).every((record) => record.restore.engine !== null)).toBe(true);
      expect(records[0]!.restore.url).toBe(f.record.url);
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
  it.each([1, 2])(
    "keeps eight newer read tabs per Run (%s Runs) and waits two idle minutes",
    async (runs) => {
      const f = await fixture();
      try {
        f.record.agentActed = true;
        for (let i = 0; i < 8 * runs + 1; i++) {
          await vi.advanceTimersByTimeAsync(1);
          await f.ledger.openSurface();
        }
        for (const record of f.ledger.policyRecords()) {
          record.personUsed = false;
          record.origin = "agent";
        }
        const records = [...f.ledger.policyRecords()];
        const oldRead = records[1]!;
        f.sleeper.setSessionState("session", { runs, viewed: [], pinned: [] });
        await vi.advanceTimersByTimeAsync(oldRead.usedAt + 119_999 - Date.now());
        expect(oldRead.live).not.toBeNull();
        await vi.advanceTimersByTimeAsync(1);
        expect(oldRead.live).toBeNull();
        expect(f.record.live).not.toBeNull();
        expect(records.filter((record) => record.live)).toHaveLength(8 * runs + 1);
      } finally {
        await f.close();
      }
    },
  );
  it("releases budget in class and LRU order through 85%, while protected opens proceed", async () => {
    const f = await fixture({
      memoryBudgetBytes: 400 * 1024 ** 2,
      memory: () => ({ total: 16 * 1024 ** 3, available: 8 * 1024 ** 3 }),
    });
    const reader = new SurfaceLedger(
      new FakeContext([new FakePage({ url: "https://read.test/" })]),
    );
    await reader.start();
    const read = [...reader.policyRecords()][0]!;
    read.origin = "agent";
    read.personUsed = false;
    read.usedAt = Date.now() - 15_000;
    f.sleeper.add("reader", { ledger: reader, restoreVersion: 1, blocked: () => null });
    try {
      for (let i = 0; i < 4; i++) await f.ledger.openSurface();
      const records = [...f.ledger.policyRecords()];
      records.forEach((record, i) => {
        record.usedAt = Date.now() - 20_000 + i;
      });
      f.record.usedAt = Date.now() - 10_001;
      const order: string[] = [];
      const original = f.ledger.sleep.bind(f.ledger),
        readSleep = reader.sleep.bind(reader);
      vi.spyOn(f.ledger, "sleep").mockImplementation((id, blocked) => {
        order.push(id);
        return original(id, blocked);
      });
      vi.spyOn(reader, "sleep").mockImplementation((id, blocked) => {
        order.push(id);
        return readSleep(id, blocked);
      });
      f.sleeper.setSessionState("reader", { runs: 1, viewed: [], pinned: [] });
      f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([f.record.id, read.id, records[1]!.id]);
      expect(records.filter((record) => record.live)).toHaveLength(3);
      f.sleeper.setSessionState("session", { runs: 1, viewed: [], pinned: [], keepAwake: true });
      await f.ledger.openSurface();
      await f.ledger.openSurface();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.ledger.snapshot()).toHaveLength(7);
      expect(records.filter((record) => record.live)).toHaveLength(3);
    } finally {
      await f.close();
      await reader.close();
    }
  });
  it.each(["process", "partition"] as const)(
    "retires only an idle Guest process under pressure (%s)",
    async (hostCost) => {
      let available = 8 * 1024 ** 3;
      let retired = false;
      const retireHost = vi.fn(async () => {
        retired = true;
      });
      const f = await fixture({
        hostCost,
        memoryBudgetBytes: 100 * 1024 ** 2,
        memory: () => ({ total: 16 * 1024 ** 3, available }),
        hosts: () =>
          retired
            ? []
            : [
                {
                  key: "guest",
                  kind: "fresh",
                  lastUsed: 0,
                  sessionIds: ["session"],
                  blocked: false,
                },
              ],
        retireHost,
      });
      try {
        f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.record.live).toBeNull();
        expect(retireHost).not.toHaveBeenCalled();
        available = 0;
        f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [f.record.id] });
        await vi.advanceTimersByTimeAsync(0);
        expect(retireHost).not.toHaveBeenCalled();
        f.sleeper.setSessionState("session", { runs: 0, viewed: [], pinned: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(retireHost).toHaveBeenCalledTimes(hostCost === "process" ? 1 : 0);
      } finally {
        await f.close();
      }
    },
  );
});
