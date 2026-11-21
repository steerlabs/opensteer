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
  it("reports the released ordinary idle sleep byte for byte", async () => {
    const reports: string[] = [];
    const f = await fixture({
      memoryBudgetBytes: 2 * 1024 ** 3,
      onPass: (pass) => reports.push(JSON.stringify(pass)),
    });
    try {
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.ledger.stateOf(f.record.id)).toBe("suspended");
      expect(reports.at(-1)).toBe(
        '{"livePages":1,"rendererProcesses":0,"rendererResidentBytes":null,"unassignedRendererProcesses":0,"underPressure":0,"attempted":1,"slept":1}',
      );
    } finally {
      await f.close();
    }
  });
  it("waits for Host state and release, and a Watch pin never makes a tab a person's", async () => {
    const f = await fixture();
    try {
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.record.live).not.toBeNull();
      f.sleeper.setSessionState("session", { runs: 1, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.record.live).not.toBeNull();
      f.sleeper.setSessionState("session", {
        runs: 0,
        personUsed: [],
        viewed: [],
        pinned: [f.record.id],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.record.live).not.toBeNull();
      expect(f.record.personUsed).toBe(false);
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(1);
      expect(f.record.live).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("starts a fresh release delay when unknown Host facts become known", async () => {
    const f = await fixture();
    try {
      f.sleeper.setSessionState("session", { runs: 1, personUsed: [], viewed: [], pinned: [] });
      f.sleeper.setSessionState("session", {
        runs: 0,
        personUsed: [],
        viewed: [],
        pinned: [],
        keepAwake: true,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.record.live).not.toBeNull();
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(59_999);
      expect(f.record.live).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.record.live).toBeNull();
    } finally {
      await f.close();
    }
  });
  it("resamples idle renderer memory and sleeps agent leftovers that clear protection first", async () => {
    const budget = 100 * 1024 ** 2;
    let usage = { processes: 1, bytes: budget / 2 };
    const onPass = vi.fn();
    const f = await fixture({
      memoryBudgetBytes: budget,
      rendererUsage: () => usage,
      onPass,
    });
    try {
      f.page.keepAwake = () => "media";
      const leftover = await f.ledger.openSurface({ origin: "agent", activate: false });
      const person = await f.ledger.openSurface();
      const pinned = await f.ledger.openSurface();
      f.sleeper.setSessionState("session", {
        runs: 0,
        personUsed: [],
        viewed: [],
        pinned: [pinned.id],
      });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.record.live).not.toBeNull();
      expect(f.ledger.stateOf(person.id)).toBe("live");
      const sleep = f.ledger.sleep.bind(f.ledger);
      vi.spyOn(f.ledger, "sleep").mockImplementation(async (id, blocked) => {
        const committed = await sleep(id, blocked);
        if (committed) usage = { processes: 1, bytes: budget / 2 };
        return committed;
      });
      usage = { processes: 6, bytes: budget * 2 };
      await vi.advanceTimersByTimeAsync(20_000);
      expect(f.record.live).not.toBeNull();
      expect(f.ledger.stateOf(leftover.id)).toBe("suspended");
      expect(f.ledger.stateOf(person.id)).toBe("live");
      expect(f.ledger.stateOf(pinned.id)).toBe("live");
      expect(f.ledger.sleep).toHaveBeenCalledTimes(2);
      expect(f.ledger.sleep).toHaveBeenNthCalledWith(1, f.record.id, expect.any(Function));
      expect(f.ledger.sleep).toHaveBeenNthCalledWith(2, leftover.id, expect.any(Function));
      expect(onPass).toHaveBeenLastCalledWith({
        livePages: 4,
        rendererProcesses: 6,
        rendererResidentBytes: budget * 2,
        unassignedRendererProcesses: 0,
        underPressure: 1,
        attempted: 2,
        slept: 1,
      });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(f.ledger.stateOf(person.id)).toBe("live");
    } finally {
      await f.close();
    }
  });
  it("uses the page estimate when the renderer memory sample is unavailable", async () => {
    const f = await fixture({
      memoryBudgetBytes: 100 * 1024 ** 2,
      rendererUsage: () => ({ processes: 2, bytes: null }),
    });
    try {
      const pinned = await f.ledger.openSurface();
      f.sleeper.setSessionState("session", {
        runs: 0,
        personUsed: [],
        viewed: [],
        pinned: [pinned.id],
      });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(f.record.live).toBeNull();
      expect(f.ledger.stateOf(pinned.id)).toBe("live");
    } finally {
      await f.close();
    }
  });

  it("continues a capped pressure scan past a full rotation of media-protected tabs", async () => {
    const f = await fixture({
      memoryBudgetBytes: 100 * 1024 ** 2,
      rendererUsage: () => ({ processes: 82, bytes: 9 * 1024 ** 3 }),
    });
    const protectedPage = { keepAwake: () => "media" };
    try {
      Object.assign(f.page, protectedPage);
      for (let index = 1; index < 80; index++) {
        const { id } = await f.ledger.openSurface({ origin: "agent", activate: false });
        Object.assign(f.ledger.binding(id)!.page, protectedPage);
      }
      await vi.advanceTimersByTimeAsync(1);
      const { id } = await f.ledger.openSurface({ origin: "agent", activate: false });
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(f.ledger.stateOf(id)).toBe("suspended");
      expect(f.record.live).not.toBeNull();
    } finally {
      await f.close();
    }
  });

  it("backs off pressure shedding when successful sleeps leave renderer use unchanged", async () => {
    const f = await fixture({
      memoryBudgetBytes: 100 * 1024 ** 2,
      rendererUsage: () => ({ processes: 6, bytes: 200 * 1024 ** 2 }),
    });
    try {
      const personUsed = [f.record.id];
      for (let index = 0; index < 5; index++) personUsed.push((await f.ledger.openSurface()).id);
      f.sleeper.setSessionState("session", { runs: 0, personUsed, viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(59_000);
      expect(personUsed.filter((id) => f.ledger.stateOf(id) === "suspended")).toHaveLength(3);
    } finally {
      await f.close();
    }
  });

  it("only reports meaningful census changes or actual suspensions", async () => {
    let usage = { processes: 1, bytes: 128 * 1024 ** 2 };
    const onPass = vi.fn();
    const f = await fixture({ rendererUsage: () => usage, onPass });
    try {
      f.sleeper.setSessionState("session", {
        runs: 0,
        personUsed: [],
        viewed: [],
        pinned: [f.record.id],
      });
      await vi.advanceTimersByTimeAsync(29_999);
      expect(onPass).toHaveBeenCalledOnce();
      usage = { ...usage, bytes: usage.bytes + 1_024 };
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onPass).toHaveBeenCalledOnce();
      usage = { ...usage, processes: 2 };
      await vi.advanceTimersByTimeAsync(30_000);
      expect(onPass).toHaveBeenCalledTimes(2);
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
        personUsed: [],
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
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.ledger.snapshot().every((tab) => tab.state === "suspended")).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.close();
    }
  });
  it("sleeps every due tab of a pass while one page close never answers", async () => {
    const f = await fixture();
    const close = vi.spyOn(f.page, "close").mockImplementation(() => new Promise(() => {}));
    try {
      for (let i = 1; i < 8; i++) await f.ledger.openSurface();
      for (const record of f.ledger.policyRecords()) {
        record.origin = "agent";
        record.personUsed = false;
      }
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(60_000);
      expect([...f.ledger.policyRecords()].filter((record) => record.live)).toEqual([]);
      expect(f.record.lease.state).toBe("suspended");
      expect(f.ledger.pages.counts().states).toMatchObject({ live: 0, closing: 1 });
    } finally {
      close.mockRestore();
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
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
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
        f.sleeper.setSessionState("session", { runs, personUsed: [], viewed: [], pinned: [] });
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
      f.sleeper.setSessionState("reader", { runs: 1, personUsed: [], viewed: [], pinned: [] });
      f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([f.record.id, read.id, records[1]!.id]);
      expect(records.filter((record) => record.live)).toHaveLength(3);
      f.sleeper.setSessionState("session", {
        runs: 1,
        personUsed: [],
        viewed: [],
        pinned: [],
        keepAwake: true,
      });
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
        f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
        await vi.advanceTimersByTimeAsync(60_000);
        expect(f.record.live).toBeNull();
        expect(retireHost).not.toHaveBeenCalled();
        available = 0;
        f.sleeper.setSessionState("session", {
          runs: 0,
          personUsed: [],
          viewed: [],
          pinned: [f.record.id],
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(retireHost).not.toHaveBeenCalled();
        f.sleeper.setSessionState("session", { runs: 0, personUsed: [], viewed: [], pinned: [] });
        await vi.advanceTimersByTimeAsync(0);
        expect(retireHost).toHaveBeenCalledTimes(hostCost === "process" ? 1 : 0);
      } finally {
        await f.close();
      }
    },
  );
});
