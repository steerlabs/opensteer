import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShadowLedger,
  compareShadow,
  type ShadowCatalog,
  type ShadowInventory,
} from "./shadow-comparison.js";
import { ShadowHostSession, ShadowReader } from "./shadow-host.js";

afterEach(() => {
  vi.useRealTimers();
});

const t1 = "surface_00000000-0000-4000-8000-000000000001";
const t2 = "surface_00000000-0000-4000-8000-000000000002";
const none = { awaitingAdmission: 0, generationUnknown: 0, holderUnknown: 0 };

const catalog = (overrides: Partial<ShadowCatalog> = {}): ShadowCatalog => ({
  ended: false,
  tabs: new Map([[t1, 1]]),
  closed: new Set(),
  eligible: new Set(["run_a:1"]),
  known: new Set(["run_a"]),
  ...overrides,
});
const inventory = (overrides: Partial<ShadowInventory> = {}): ShadowInventory => ({
  surfaces: new Map([[t1, "live"]]),
  admitted: new Map([[t1, 1]]),
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
      catalog({ tabs: new Map(), closed: new Set([t1]) }),
      inventory(),
      [{ kind: "would-destroy", reason: "closed", tab: t1, state: "live" }],
    ],
    [
      "a page the catalog never had would be destroyed",
      catalog({ tabs: new Map() }),
      inventory({ admitted: new Map() }),
      [{ kind: "would-destroy", reason: "never-admitted", tab: t1 }],
    ],
    [
      "a page still being admitted is not yet a disagreement",
      catalog({ tabs: new Map() }),
      inventory({ pending: new Set([t1]) }),
      [],
    ],
    [
      "a closed tab stays one to destroy even while the Host writes its other changes",
      catalog({ tabs: new Map(), closed: new Set([t1]) }),
      inventory({ pending: new Set([t1]) }),
      [{ kind: "would-destroy", reason: "closed" }],
    ],
    [
      "a page bound at an earlier generation of a reopened tab would be destroyed",
      catalog({ tabs: new Map([[t1, 3]]) }),
      inventory(),
      [{ kind: "would-destroy", reason: "generation", generation: 1 }],
    ],
    [
      "an ended session would destroy even a sleeping tab",
      catalog({ ended: true }),
      inventory({ surfaces: new Map([[t1, "suspended"]]) }),
      [{ kind: "would-destroy", reason: "ended", state: "suspended" }],
    ],
    [
      "an open tab asleep has no page",
      catalog(),
      inventory({ surfaces: new Map([[t1, "suspended"]]) }),
      [{ kind: "tab-without-page", reason: "asleep", tab: t1 }],
    ],
    [
      "an open tab the runtime does not report is missing",
      catalog(),
      inventory({ surfaces: new Map() }),
      [{ kind: "tab-without-page", reason: "missing", tab: t1, state: null }],
    ],
    [
      "a hold by a Run binding that may no longer use the session would be dropped",
      catalog({ eligible: new Set() }),
      inventory({
        holders: [{ surface: t1, run: "run_a", bindingGeneration: 1 }],
        viewing: new Set([t1]),
      }),
      [{ kind: "would-drop-hold", run: "run_a", bindingGeneration: 1, viewing: true }],
    ],
    [
      "a hold by an earlier binding of an eligible Run would be dropped",
      catalog(),
      inventory({ holders: [{ surface: t1, run: "run_a", bindingGeneration: 0 }] }),
      [{ kind: "would-drop-hold", bindingGeneration: 0 }],
    ],
    [
      "a hold by a Run the read knows nothing of is unknown, never dropped",
      catalog({ eligible: new Set(), known: new Set() }),
      inventory({ holders: [{ surface: t1, run: "run_b", bindingGeneration: 1 }] }),
      [],
    ],
  ] as const)("%s", (_name, desired, observed, expected) => {
    expect(compareShadow(desired, observed).findings).toEqual(
      expected.map((finding) => expect.objectContaining(finding)),
    );
  });

  it("counts what it cannot judge instead of naming it", () => {
    expect(
      compareShadow(
        catalog({ tabs: new Map([[t2, 1]]), known: new Set() }),
        inventory({
          surfaces: new Map([
            [t1, "live"],
            [t2, "live"],
          ]),
          admitted: new Map(),
          pending: new Set([t1]),
          holders: [{ surface: t2, run: "run_x", bindingGeneration: 1 }],
        }),
      ).uncertain,
    ).toEqual({ awaitingAdmission: 1, generationUnknown: 1, holderUnknown: 1 });
  });
});

describe("ShadowLedger", () => {
  it("logs a disagreement once as it appears, once with its age as it resolves, and counts on change", () => {
    const ledger = new ShadowLedger();
    const { findings } = compareShadow(
      catalog({ tabs: new Map(), closed: new Set([t1]) }),
      inventory({ personUsed: new Set([t1]) }),
    );
    expect(ledger.update(findings, none, 0).map((line) => line.event)).toEqual([
      "browser.shadow.appeared",
      "browser.shadow.summary",
    ]);
    expect(ledger.update(findings, none, 5_000), "Unchanged: nothing").toEqual([]);
    expect(ledger.update([], none, 9_000)[0]).toEqual({
      event: "browser.shadow.resolved",
      kind: "would-destroy",
      reason: "closed",
      tab: t1,
      ageMs: 9_000,
    });
  });

  it("never writes a runtime-supplied id that is not of the issued shape", () => {
    const hostile = [
      `${t1}\n{"event":"forged"}`,
      "https://bank.example/account?token=secret",
      "x".repeat(10 * 1024),
    ];
    const ledger = new ShadowLedger();
    const { findings } = compareShadow(
      catalog({ tabs: new Map(), closed: new Set(hostile) }),
      inventory({ surfaces: new Map(hostile.map((id) => [id, "live" as const])) }),
    );
    const lines = [...ledger.update(findings, none, 0), ...ledger.update([], none, 1)];
    const written = JSON.stringify(lines);
    for (const id of hostile) expect(written).not.toContain(id);
    expect(written).not.toContain("bank.example");
    expect(written).not.toContain("xxxxxxxxxx");
    expect(lines.filter((line) => line.event === "browser.shadow.appeared")).toEqual(
      hostile.map(() =>
        expect.objectContaining({ tab: null, tabRecognized: false, tabDigest: expect.any(String) }),
      ),
    );
  });

  it("names the Run and binding on a hold's resolution as on its appearance", () => {
    const ledger = new ShadowLedger();
    const held = compareShadow(
      catalog({ eligible: new Set() }),
      inventory({ holders: [{ surface: t1, run: "run_a", bindingGeneration: 2 }] }),
    ).findings;
    ledger.update(held, none, 0);
    expect(ledger.update([], none, 10)[0]).toMatchObject({
      event: "browser.shadow.resolved",
      kind: "would-drop-hold",
      run: "run_a",
      bindingGeneration: 2,
    });
  });

  it("bounds a flapping finding and folds the rest into the summary", () => {
    const ledger = new ShadowLedger();
    const { findings } = compareShadow(
      catalog({ tabs: new Map(), closed: new Set([t1]) }),
      inventory(),
    );
    const lines: Record<string, unknown>[] = [];
    for (let index = 0; index < 100; index++)
      lines.push(...ledger.update(index % 2 ? [] : findings, none, index));
    const perFinding = lines.filter(
      (line) =>
        line.event === "browser.shadow.appeared" || line.event === "browser.shadow.resolved",
    );
    expect(perFinding).toHaveLength(4);
    expect(lines.filter((line) => line.event === "browser.shadow.summary").at(-1)).toMatchObject({
      folded: 96,
    });
  });

  it("is loud once when more than ten pages a person viewed would be destroyed at once", () => {
    const ledger = new ShadowLedger();
    const ids = Array.from(
      { length: 11 },
      (_, index) => `surface_00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    const { findings } = compareShadow(
      catalog({ tabs: new Map(), closed: new Set(ids) }),
      inventory({ surfaces: new Map(ids.map((id) => [id, "live"])), personUsed: new Set(ids) }),
    );
    expect(
      ledger.update(findings, none, 0).filter((line) => line.event === "browser.shadow.loud"),
    ).toEqual([{ event: "browser.shadow.loud", viewed: 11, wouldDestroy: 11 }]);
  });
});

describe("ShadowHostSession", () => {
  function harness(read: (surfaces: readonly string[]) => Promise<ShadowCatalog | null>) {
    vi.useFakeTimers();
    const lines: Record<string, unknown>[] = [];
    let current = inventory();
    const reads = vi.fn(read);
    const session = new ShadowHostSession({
      session: "bsn_test",
      reader: new ShadowReader(),
      read: (surfaces) => reads(surfaces),
      inventory: () => current,
      log: (line) => lines.push(line),
    });
    return {
      session,
      lines,
      reads,
      setInventory: (next: ShadowInventory) => {
        current = next;
      },
    };
  }

  it("after a failed read compares nothing, even on an inventory change, until a read succeeds", async () => {
    let fail = false;
    const f = harness(async () => {
      if (fail) throw new Error("connection reset");
      return catalog({ tabs: new Map(), closed: new Set([t1]) });
    });
    f.session.catalogChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.lines.filter((line) => line.event === "browser.shadow.appeared")).toHaveLength(1);
    fail = true;
    f.session.catalogChanged();
    await vi.advanceTimersByTimeAsync(0);
    const after = f.lines.length;
    // The tab came back in the runtime; the stale cut would call it something it no longer is.
    f.setInventory(inventory({ surfaces: new Map([[t2, "live"]]), admitted: new Map() }));
    f.session.inventoryChanged();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.lines.slice(after), "Nothing compared against the stale cut").toEqual([]);
    expect(f.lines.filter((line) => line.event === "browser.shadow.failed")).toEqual([
      { event: "browser.shadow.failed", kind: "read", session: "bsn_test" },
    ]);
    fail = false;
    f.session.catalogChanged();
    await vi.advanceTimersByTimeAsync(0);
    // Compared again only now, against the fresh cut.
    expect(f.lines.at(-1)).toMatchObject({
      event: "browser.shadow.appeared",
      reason: "never-admitted",
    });
    expect(vi.getTimerCount(), "Nothing armed at rest").toBe(0);
    f.session.stop();
  });

  it("discards a cut a later commit superseded, and keeps a page pending at the read out of never-admitted", async () => {
    const reads: PromiseWithResolvers<ShadowCatalog | null>[] = [];
    const f = harness(() => {
      const read = Promise.withResolvers<ShadowCatalog | null>();
      reads.push(read);
      return read.promise;
    });
    // The new page is still being admitted when the cut is read.
    f.setInventory(inventory({ admitted: new Map(), pending: new Set([t1]) }));
    f.session.catalogChanged();
    await vi.advanceTimersByTimeAsync(0);
    // Its admission commits and the Host's pending write clears before the old cut returns.
    f.setInventory(inventory());
    f.session.catalogChanged();
    reads[0]!.resolve(catalog({ tabs: new Map() }));
    await vi.advanceTimersByTimeAsync(100);
    expect(
      f.lines.filter((line) => line.event === "browser.shadow.appeared"),
      "The superseded cut is never compared",
    ).toEqual([]);
    expect(reads).toHaveLength(2);
    reads[1]!.resolve(catalog());
    await vi.advanceTimersByTimeAsync(100);
    expect(f.lines.filter((line) => line.event === "browser.shadow.appeared")).toEqual([]);
    f.session.stop();
  });

  it("keeps a page that was pending when its cut was read out of never-admitted", async () => {
    const read = Promise.withResolvers<ShadowCatalog | null>();
    const f = harness(() => read.promise);
    f.setInventory(inventory({ admitted: new Map(), pending: new Set([t1]) }));
    f.session.catalogChanged();
    await vi.advanceTimersByTimeAsync(0);
    // Its pending write clears before the cut returns, with no commit seen here.
    f.setInventory(inventory());
    read.resolve(catalog({ tabs: new Map() }));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.lines.filter((line) => line.event === "browser.shadow.appeared")).toEqual([]);
    expect(f.lines.at(-1)).toMatchObject({ awaitingAdmission: 1 });
    f.session.stop();
  });

  it("reads one cut at a time across sessions, each session once however many commits", async () => {
    vi.useFakeTimers();
    let inFlight = 0;
    let most = 0;
    const read = vi.fn(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Promise.resolve();
      await Promise.resolve();
      inFlight--;
      return catalog();
    });
    const reader = new ShadowReader();
    const sessions = Array.from(
      { length: 50 },
      (_, index) =>
        new ShadowHostSession({
          session: `bsn_${index}`,
          reader,
          read,
          inventory: () => inventory(),
          log: () => undefined,
        }),
    );
    for (const session of sessions)
      for (let index = 0; index < 3; index++) session.catalogChanged();
    await vi.advanceTimersByTimeAsync(0);
    // One read per session; the first session's was already under way when its later commits
    // arrived, so it reads once more, after them.
    expect(read).toHaveBeenCalledTimes(51);
    expect(most, "Never more than one read, so one connection, at a time").toBe(1);
    for (const session of sessions) session.stop();
  });
});
