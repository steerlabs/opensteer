import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShadowLedger,
  compareShadow,
  type ShadowCatalog,
  type ShadowInventory,
} from "./shadow-comparison.js";
import { ShadowHostSession } from "./shadow-host.js";

afterEach(() => {
  vi.useRealTimers();
});

const catalog = (overrides: Partial<ShadowCatalog> = {}): ShadowCatalog => ({
  ended: false,
  tabs: new Map([["t1", 1]]),
  closed: new Set(),
  eligible: new Set(["run_a:1"]),
  ...overrides,
});
const inventory = (overrides: Partial<ShadowInventory> = {}): ShadowInventory => ({
  surfaces: new Map([["t1", "live"]]),
  admitted: new Map([["t1", 1]]),
  pending: new Set(),
  personUsed: new Set(),
  viewing: new Set(),
  holders: [],
  ...overrides,
});

describe("compareShadow", () => {
  it.each([
    ["agreement", catalog(), inventory(), []],
    [
      "a page whose tab the catalog closed would be destroyed",
      catalog({ tabs: new Map(), closed: new Set(["t1"]) }),
      inventory(),
      [{ kind: "would-destroy", reason: "closed", tab: "t1", state: "live" }],
    ],
    [
      "a page the catalog never had would be destroyed",
      catalog({ tabs: new Map() }),
      inventory({ admitted: new Map() }),
      [{ kind: "would-destroy", reason: "never-admitted", tab: "t1" }],
    ],
    [
      "a page still being admitted is not yet a disagreement",
      catalog({ tabs: new Map() }),
      inventory({ admitted: new Map([["t1", 1]]), pending: new Set(["t1"]) }),
      [],
    ],
    [
      "a closed tab stays one to destroy even while the Host writes its other changes",
      catalog({ tabs: new Map(), closed: new Set(["t1"]) }),
      inventory({ pending: new Set(["t1"]) }),
      [{ kind: "would-destroy", reason: "closed" }],
    ],
    [
      "a page bound at an earlier generation of a reopened tab would be destroyed",
      catalog({ tabs: new Map([["t1", 3]]) }),
      inventory(),
      [{ kind: "would-destroy", reason: "generation", generation: 1 }],
    ],
    [
      "an ended session would destroy even a sleeping tab",
      catalog({ ended: true }),
      inventory({ surfaces: new Map([["t1", "suspended"]]) }),
      [{ kind: "would-destroy", reason: "ended", state: "suspended" }],
    ],
    [
      "an open tab asleep has no page",
      catalog(),
      inventory({ surfaces: new Map([["t1", "suspended"]]) }),
      [{ kind: "tab-without-page", reason: "asleep", tab: "t1" }],
    ],
    [
      "an open tab the runtime does not report is missing",
      catalog(),
      inventory({ surfaces: new Map() }),
      [{ kind: "tab-without-page", reason: "missing", tab: "t1", state: null }],
    ],
    [
      "a hold by a Run binding that may no longer use the session would be dropped",
      catalog({ eligible: new Set() }),
      inventory({
        holders: [{ surface: "t1", run: "run_a", bindingGeneration: 1 }],
        viewing: new Set(["t1"]),
      }),
      [{ kind: "would-drop-hold", run: "run_a", bindingGeneration: 1, viewing: true }],
    ],
    [
      "a hold by an earlier binding of an eligible Run would be dropped",
      catalog(),
      inventory({ holders: [{ surface: "t1", run: "run_a", bindingGeneration: 0 }] }),
      [{ kind: "would-drop-hold", bindingGeneration: 0 }],
    ],
  ] as const)("%s", (_name, desired, observed, expected) => {
    expect(compareShadow(desired, observed)).toEqual(
      expected.map((finding) => expect.objectContaining(finding)),
    );
  });
});

describe("ShadowLedger", () => {
  it("logs a disagreement once as it appears, once with its age as it resolves, and counts on change", () => {
    const ledger = new ShadowLedger();
    const closed = compareShadow(
      catalog({ tabs: new Map(), closed: new Set(["t1"]) }),
      inventory({ personUsed: new Set(["t1"]) }),
    );
    expect(ledger.update(closed, 0).map((line) => line.event)).toEqual([
      "browser.shadow.appeared",
      "browser.shadow.summary",
    ]);
    expect(ledger.update(closed, 5_000), "Unchanged: nothing").toEqual([]);
    expect(ledger.update([], 9_000)).toEqual([
      {
        event: "browser.shadow.resolved",
        kind: "would-destroy",
        reason: "closed",
        tab: "t1",
        ageMs: 9_000,
      },
      {
        event: "browser.shadow.summary",
        counts: { "would-destroy": 0, "tab-without-page": 0, "would-drop-hold": 0 },
        oldestMs: {},
      },
    ]);
  });

  it("is loud once when more than ten pages a person viewed would be destroyed at once", () => {
    const ledger = new ShadowLedger();
    const ids = Array.from({ length: 11 }, (_, index) => `t${index}`);
    const findings = compareShadow(
      catalog({ tabs: new Map(), closed: new Set(ids) }),
      inventory({
        surfaces: new Map(ids.map((id) => [id, "live"])),
        personUsed: new Set(ids),
      }),
    );
    expect(
      ledger.update(findings, 0).filter((line) => line.event === "browser.shadow.loud"),
    ).toEqual([{ event: "browser.shadow.loud", viewed: 11, wouldDestroy: 11 }]);
    expect(
      ledger.update(findings, 1).filter((line) => line.event === "browser.shadow.loud"),
    ).toEqual([]);
  });
});

describe("ShadowHostSession", () => {
  it("reads only on a catalog change, coalesces bursts, logs a failing read once, and arms no timer at rest", async () => {
    vi.useFakeTimers();
    let fail = true;
    const read = vi.fn(async () => {
      if (fail) throw new Error("connection reset");
      return catalog();
    });
    const lines: Record<string, unknown>[] = [];
    const session = new ShadowHostSession({
      session: "bsn_test",
      read,
      inventory: () => inventory(),
      log: (line) => lines.push(line),
    });
    for (let index = 0; index < 5; index++) session.catalogChanged();
    await vi.advanceTimersByTimeAsync(50);
    session.catalogChanged();
    await vi.advanceTimersByTimeAsync(50);
    expect(read).toHaveBeenCalledTimes(2);
    expect(lines).toEqual([{ event: "browser.shadow.failed", kind: "read", session: "bsn_test" }]);
    fail = false;
    session.inventoryChanged();
    await vi.advanceTimersByTimeAsync(50);
    expect(read, "An inventory change compares without reading").toHaveBeenCalledTimes(2);
    session.catalogChanged();
    await vi.advanceTimersByTimeAsync(50);
    expect(read).toHaveBeenCalledTimes(3);
    expect(lines.at(-1)).toMatchObject({ event: "browser.shadow.summary", session: "bsn_test" });
    expect(vi.getTimerCount(), "Nothing armed while idle").toBe(0);
    session.stop();
  });
});
