import { describe, expect, it } from "vitest";
import {
  after,
  afterSession,
  canTakeStart,
  captureWaitMs,
  firstFrameWaitMs,
  fits,
  frameVerdict,
  initialSessionCastState,
  initialTabCastState,
  loadingFirstFrameWaitMs,
  nextStep,
  otherSizeWaitMs,
  pictureLimit,
  prepareWaitMs,
  refusalReleased,
  repairWaitMs,
  sameCast,
  startFacts,
  stopAnswerWaitMs,
  wanted,
  type CastEvent,
  type CastFacts,
  type CastKey,
  type NavigationFact,
  type Refusal,
  type TabCastState,
  type TabFacts,
  type Told,
  type Trouble,
} from "./screencast-plan.js";

/*
 * The follow view's decision, over every combination of its small spaces: what is wanted, whether
 * a cast still fits it, whether the page can take a start, what a frame is, the one next step,
 * and the state each event leaves. Each step and each transition is checked against the facts
 * that may cause it, so one taken for any other reason fails here.
 */

const size = { height: 600, width: 800 };
const tab = (over: Partial<TabFacts> = {}): TabFacts => ({
  binding: "tab#1",
  capture: null,
  dialogOpen: false,
  document: "a",
  geometryRevision: 1,
  loading: false,
  native: false,
  navigation: null,
  size,
  sizesView: true,
  ...over,
});
const facts = (over: Partial<CastFacts> = {}, tabOver: Partial<TabFacts> = {}): CastFacts => ({
  captureRegions: false,
  closed: false,
  density: 2,
  streaming: true,
  tab: tab(tabOver),
  ...over,
});
const keyOf = (from: CastFacts): CastKey => {
  const want = wanted(from);
  if (want.kind !== "cast") throw new Error(`no cast is wanted: ${want.why}`);
  return want.key;
};
const refusal = (over: Partial<Refusal> = {}): Refusal => ({
  document: "a",
  finished: null,
  loading: false,
  pending: false,
  why: "x",
  ...over,
});

describe("what the follow view wants cast", () => {
  it("is nothing when closed, paused or without a tab, and holds what runs while the page cannot be pictured", () => {
    expect(wanted(facts({ closed: true })).kind).toBe("none");
    expect(wanted(facts({ streaming: false })).kind).toBe("none");
    expect(wanted({ ...facts(), tab: null }).kind).toBe("none");
    expect(wanted(facts({}, { dialogOpen: true }))).toEqual({
      kind: "hold",
      why: "a dialog is open",
    });
    expect(wanted(facts({}, { size: null })).kind).toBe("hold");
    expect(wanted(facts({}, { native: true, capture: null })).kind).toBe("hold");
    expect(
      wanted(
        facts(
          {},
          { native: true, capture: { height: 700, rasterScale: 1, revision: 1, width: 800 } },
        ),
      ).kind,
    ).toBe("hold");
  });

  it("casts the capture's region at the raster its density allows, or the page's size", () => {
    expect(keyOf(facts())).toMatchObject({
      captureRevision: null,
      expectedRaster: null,
      raster: { height: 1200, width: 1600 },
      region: size,
    });
    const capture = { height: 500, rasterScale: 1, revision: 3, width: 700 };
    expect(keyOf(facts({ density: 2 }, { capture, native: true }))).toMatchObject({
      captureRevision: 3,
      expectedRaster: { height: 500, width: 700 },
      raster: { height: 500, width: 700 },
      region: { height: 500, width: 700 },
    });
  });
});

describe("whether a cast still fits what is wanted", () => {
  const base = facts();
  const told = keyOf(base);
  const variants: Array<[string, CastFacts, "same" | "new-document" | false]> = [
    ["the same facts", base, "same"],
    ["another size", facts({}, { size: { height: 600, width: 900 } }), false],
    ["another density", facts({ density: 1 }), false],
    ["new metrics at the same size", facts({}, { geometryRevision: 2 }), false],
    [
      "a new document at the same size",
      facts({}, { document: "b", geometryRevision: 2 }),
      "new-document",
    ],
    [
      "a new document at another size",
      facts({}, { document: "b", geometryRevision: 2, size: { height: 700, width: 800 } }),
      false,
    ],
    ["a page now sized another way", facts({}, { sizesView: false }), false],
    ["regions now shown with their own header", facts({ captureRegions: true }), false],
  ];
  for (const [name, now, expected] of variants)
    it(`is ${String(expected)} for ${name}`, () => expect(fits(told, keyOf(now))).toBe(expected));

  it("is false for another capture revision, the region the same", () => {
    const capture = { height: 600, rasterScale: 1, revision: 1, width: 800 };
    const before = keyOf(facts({}, { capture, native: true }));
    expect(
      fits(before, keyOf(facts({}, { capture: { ...capture, revision: 2 }, native: true }))),
    ).toBe(false);
  });

  it("is the same cast for one given up while only the metrics revision moved, not when the document did", () => {
    expect(sameCast(told, keyOf(facts({}, { geometryRevision: 5 })))).toBe(true);
    expect(sameCast(told, keyOf(facts({}, { document: "b", geometryRevision: 5 })))).toBe(false);
    expect(sameCast(told, keyOf(facts({}, { size: { height: 700, width: 800 } })))).toBe(false);
  });
});

describe("whether the page can take a start", () => {
  const navigations: Array<NavigationFact | null> = [null];
  for (const finished of [0, 1, 2])
    for (const pending of [false, true])
      for (const blankDocument of [false, true])
        navigations.push({ blankDocument, finished, pending });
  const refusals: Array<Refusal | null> = [null];
  for (const finished of [null, 0, 1])
    for (const loading of [false, true])
      for (const pending of [false, true])
        for (const document of ["a", "b"])
          refusals.push(refusal({ document, finished, loading, pending }));

  it("refuses exactly while the first document is to commit, or until a fact a refusal recorded differs", () => {
    let cases = 0;
    for (const navigation of navigations)
      for (const recorded of refusals)
        for (const loading of [false, true])
          for (const document of ["a", "b"]) {
            cases += 1;
            const now = tab({ document, loading, navigation });
            const gate = navigation?.pending === true && navigation.blankDocument;
            // S5: released as soon as any fact it recorded differs, loading either way.
            const released =
              recorded === null ||
              (navigation?.finished ?? null) !== recorded.finished ||
              (navigation?.pending ?? false) !== recorded.pending ||
              loading !== recorded.loading ||
              document !== recorded.document;
            if (recorded) expect(refusalReleased(now, recorded)).toBe(released);
            const result = canTakeStart(now, recorded);
            expect(result.ok, JSON.stringify({ document, loading, navigation, recorded })).toBe(
              !gate && released,
            );
            if (!result.ok) expect(result.why.length).toBeGreaterThan(0);
          }
    expect(cases).toBe(navigations.length * refusals.length * 4);
  });

  // Re-check 10, finding 6 (S5): on Linux a start refused before the page said it loads, then a
  // load that began and ended on the same document, never let the refusal go.
  it("releases a refusal sent before loading began as loading begins, and one sent while it loaded as it ends", () => {
    expect(refusalReleased(tab({ loading: true }), refusal({ loading: false }))).toBe(true);
    expect(refusalReleased(tab({ loading: false }), refusal({ loading: true }))).toBe(true);
  });

  it("keeps a refusal with nothing pending, nothing loading and no navigation until the document changes", () => {
    const recorded = refusal();
    expect(refusalReleased(tab(), recorded)).toBe(false);
    expect(refusalReleased(tab({ geometryRevision: 9 }), recorded)).toBe(false);
    expect(refusalReleased(tab({ document: "b" }), recorded)).toBe(true);
  });
});

const native = facts(
  {},
  {
    capture: { height: 600, rasterScale: 2, revision: 1, width: 800 },
    native: true,
    sizesView: false,
  },
);
const base = facts();
const key = keyOf(base);
const otherKey = keyOf(facts({}, { size: { height: 700, width: 900 } }));
const tolds: Told[] = [
  { state: "none" },
  { state: "preparing" },
  { at: startFacts(base.tab!), key, state: "sent" },
  { key, state: "running" },
  { key: otherKey, state: "running" },
];
const wants: Array<[string, CastFacts]> = [
  ["cast", base],
  ["paused", facts({ streaming: false })],
  ["closed", facts({ closed: true })],
  ["dialog", facts({}, { dialogOpen: true })],
  [
    "first document pending",
    facts({}, { navigation: { blankDocument: true, finished: 0, pending: true } }),
  ],
  ["native", native],
];
const states: TabCastState[] = [];
const troubles: Array<Trouble | null> = [null, "other-size", "no-picture", "set-aside", "misfit"];
for (const told of tolds)
  for (const shown of [false, true])
    for (const trouble of troubles)
      for (const redraw of [false, true])
        // A retry and a change are one to the next step: both wait for the page to be drawn.
        for (const repairing of [null, "retry"] as const)
          for (const unpictured of [0, 1, 2, 3])
            for (const paint of [null, { captureRevision: null, geometryRevision: 1, size }])
              for (const recorded of [null, refusal()])
                for (const failed of [null, { key, why: "no picture arrived" }])
                  states.push({
                    ...initialTabCastState(),
                    failed,
                    paint,
                    redraw,
                    refusal: recorded,
                    repairing,
                    shown,
                    told,
                    trouble,
                    unpictured,
                  });

describe("the next step", () => {
  it("binds the tab in view first, and is idle with nothing bound", () => {
    expect(nextStep(base, null, null)).toEqual({ kind: "bind" });
    expect(nextStep(base, "other#1", initialTabCastState())).toEqual({ kind: "bind" });
    expect(nextStep(facts({ closed: true }), "tab#1", initialTabCastState())).toEqual({
      kind: "bind",
    });
    expect(nextStep({ ...base, tab: null }, null, null)).toEqual({ kind: "idle" });
  });

  it("takes each step only when the facts call for it", () => {
    let cases = 0;
    for (const [name, now] of wants)
      for (const state of states) {
        cases += 1;
        const step = nextStep(now, now.closed ? null : "tab#1", now.closed ? null : state);
        const at = JSON.stringify({ name, state, step });
        const want = wanted(now);
        const told = state.told;
        const fit =
          told.state === "running" && want.kind === "cast" ? fits(told.key, want.key) : null;
        const limit = pictureLimit(now.tab!.native);
        switch (step.kind) {
          case "bind":
          case "idle":
            if (want.kind === "cast")
              expect(
                told.state === "running" && fit === "same" && state.shown && !state.redraw,
                at,
              ).toBe(true);
            if (want.kind === "none") expect(told.state === "none" || now.closed, at).toBe(true);
            break;
          case "stop":
            expect(want.kind === "none" && told.state !== "none", at).toBe(true);
            break;
          case "start": {
            expect(want.kind === "cast" && told.state === "none" && !state.repairing, at).toBe(
              true,
            );
            expect(canTakeStart(now.tab!, state.refusal).ok, at).toBe(true);
            if (want.kind === "cast" && state.failed && state.failed.key !== null)
              expect(sameCast(state.failed.key, want.key), at).toBe(false);
            // A paint wait holds only the picture it timed out for.
            expect(
              state.paint === null ||
                want.kind !== "cast" ||
                state.paint.geometryRevision !== want.key.geometryRevision ||
                state.paint.captureRevision !== want.key.captureRevision,
              at,
            ).toBe(true);
            break;
          }
          case "restart":
            // A restart for another cast is a change; one for a frame set aside, a retry.
            expect(told.state === "running", at).toBe(true);
            if (step.retry)
              expect(
                fit === "same" && state.trouble === "set-aside" && state.unpictured < limit,
                at,
              ).toBe(true);
            else expect(fit, at).toBe(false);
            break;
          case "restamp":
            expect(fit, at).toBe("new-document");
            break;
          case "repair":
            if (want.kind === "hold" && want.why === "its capture is let go") {
              expect(
                step.retry &&
                  state.trouble === "no-picture" &&
                  !state.captureRetried &&
                  (state.shown || state.unpictured < limit),
                at,
              ).toBe(true);
              break;
            }
            expect(told.state === "running" && fit === "same", at).toBe(true);
            // A repair a closed tab asked for is a change; one for a frame that did not fit, or
            // for no picture in its time, a retry.
            if (step.retry)
              expect(
                !state.redraw &&
                  (state.trouble === "misfit" || state.trouble === "no-picture") &&
                  state.unpictured < limit,
                at,
              ).toBe(true);
            else expect(state.redraw, at).toBe(true);
            break;
          case "fail":
            if (want.kind === "hold" && want.why === "its capture is let go") {
              expect(
                state.trouble === "no-picture" &&
                  (state.captureRetried === true || (!state.shown && state.unpictured >= limit)),
                at,
              ).toBe(true);
              expect(step.why, at).toBe("the page lost its capture");
              break;
            }
            expect(told.state === "running" && fit === "same" && !state.shown, at).toBe(true);
            expect(["misfit", "set-aside", "no-picture"], at).toContain(state.trouble);
            expect(state.unpictured >= limit, at).toBe(true);
            // It says what came of the cast: no picture, when none came in its time.
            if (state.trouble === "no-picture") expect(step.why, at).toBe("no picture arrived");
            break;
          case "wait":
            // A wait is for a named fact, or the plan gives it a time: a running cast waiting for
            // its first frame, or its own after one of another size, always has one (R10), as do
            // starts with Chromium, starts being prepared, repairs, and lost captures (X2).
            expect(step.why.length, at).toBeGreaterThan(0);
            if (step.why === "its first frame") {
              expect(state.trouble === null && !state.redraw && !state.shown, at).toBe(true);
              expect(step.timer, at).toBe(firstFrameWaitMs * 2 ** Math.min(state.unpictured, 2));
            } else if (step.why === "its document's first frame, as it loads") {
              expect(state.trouble === null && !state.redraw && !state.shown, at).toBe(true);
              expect(step.timer, at).toBe(
                loadingFirstFrameWaitMs * 2 ** Math.min(state.unpictured, 2),
              );
            } else if (step.why === "its own frame, after one of another size") {
              expect(state.trouble, at).toBe("other-size");
              expect(step.timer, at).toBe(otherSizeWaitMs);
            } else if (step.why === "a start is with Chromium") {
              expect(state.told.state, at).toBe("sent");
              expect(step.timer, at).toBe(stopAnswerWaitMs);
            } else if (step.why === "a start is being prepared") {
              expect(state.told.state, at).toBe("preparing");
              expect(step.timer, at).toBe(prepareWaitMs);
            } else if (step.why === "the page is drawn again") {
              expect(state.repairing, at).not.toBeNull();
              expect(step.timer, at).toBe(repairWaitMs);
            } else if (step.why === "its capture is let go") {
              expect(want.kind === "hold" && want.why === "its capture is let go", at).toBe(true);
              expect(step.timer, at).toBe(captureWaitMs);
            } else expect(step.timer, at).toBeUndefined();
            if (want.kind === "none") throw new Error(`waits while nothing is wanted: ${at}`);
            break;
        }
      }
    expect(cases).toBe(wants.length * states.length);
  });

  it("sends no start while one is prepared or with Chromium, or while the session's stop is", () => {
    const stopping = { ...initialSessionCastState, stops: 1 };
    for (const [, now] of wants)
      for (const state of states) {
        expect(nextStep(now, "tab#1", state, stopping).kind).not.toMatch(
          /^(start|restart|repair)$/u,
        );
        if (["preparing", "sent"].includes(state.told.state) || state.repairing)
          expect(nextStep(now, "tab#1", state).kind).not.toMatch(/^(start|restart|repair)$/u);
      }
  });

  it("reaches the bound for frames set aside, and gives up then (finding 1)", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    let state: TabCastState = { ...running, trouble: "set-aside" };
    const seen: string[] = [];
    for (let round = 0; round < 6; round += 1) {
      const step = nextStep(base, "tab#1", state);
      seen.push(step.kind);
      if (step.kind === "fail") break;
      expect(step.kind).toBe("restart");
      // The restart, its start for the same cast, its answer, and its frame set aside again.
      state = after(state, { kind: "stopped", retry: true }, base);
      state = after(state, { at: startFacts(base.tab!), key, kind: "sent" }, base);
      state = after(state, { kind: "answered" }, base);
      state = after(state, { kind: "frame", verdict: "set-aside" }, base);
    }
    expect(seen).toEqual(["restart", "restart", "restart", "fail"]);
  });
});

describe("what a frame is", () => {
  const measured = (geometry = size, raster = { height: 1200, width: 1600 }) => ({
    document: "a",
    geometry,
    raster,
  });
  const sent: TabCastState = {
    ...initialTabCastState(),
    told: { at: startFacts(base.tab!), key, state: "sent" },
  };
  const none = initialSessionCastState;
  const running: TabCastState = { ...initialTabCastState(), told: { key, state: "running" } };

  it("is held with its start when it pictures what the start asked for, and of another size otherwise", () => {
    expect(frameVerdict(sent, none, measured(), base)).toBe("held");
    expect(frameVerdict(sent, none, measured({ height: 650, width: 900 }), base)).toBe(
      "misfit-with-start",
    );
    const sentNative: TabCastState = {
      ...sent,
      told: { at: startFacts(native.tab!), key: keyOf(native), state: "sent" },
    };
    expect(frameVerdict(sentNative, none, measured({ height: 650, width: 900 }), native)).toBe(
      "other-size-with-start",
    );
  });

  it("is shown, set aside, a misfit or dropped once its cast runs", () => {
    expect(frameVerdict(running, none, measured(), base)).toBe("show");
    expect(frameVerdict(running, none, measured(), facts({}, { dialogOpen: true }))).toBe(
      "set-aside",
    );
    expect(frameVerdict(running, none, measured(), facts({ density: 1 }))).toBe("set-aside");
    expect(frameVerdict(running, none, measured({ height: 650, width: 900 }), base)).toBe("misfit");
    expect(frameVerdict(running, none, measured(size, { height: 600, width: 1600 }), base)).toBe(
      "misfit",
    );
    expect(frameVerdict({ ...running, told: { state: "none" } }, none, measured(), base)).toBe(
      "dropped",
    );
  });

  // Re-check 10, S1 and S6: whether a frame is no one's is the plan's to say, from the session's
  // stops and whether anything is streamed.
  it("is dropped on a session whose stop is with Chromium, and while nothing is streamed", () => {
    const stopping = { ...initialSessionCastState, stops: 1 };
    for (const state of [sent, running])
      for (const now of [base, facts({ streaming: false })])
        expect(frameVerdict(state, stopping, measured(), now)).toBe("dropped");
    expect(frameVerdict(sent, none, measured(), facts({ streaming: false }))).toBe("dropped");
    expect(
      frameVerdict(sent, none, measured({ height: 650, width: 900 }), facts({ streaming: false })),
    ).toBe("dropped");
  });

  it("is the old document's when it came before the follow view saw the new one, and the new one's after", () => {
    const committed = facts({}, { document: "b", geometryRevision: 2 });
    expect(frameVerdict(running, none, { ...measured(), document: "a" }, committed)).toBe(
      "dropped",
    );
    expect(frameVerdict(running, none, { ...measured(), document: "b" }, committed)).toBe(
      "restamp-show",
    );
  });
});

describe("the state after each event", () => {
  const events: CastEvent[] = [
    { kind: "observed" },
    { kind: "start-begun" },
    { at: startFacts(base.tab!), key, kind: "sent" },
    { at: startFacts(base.tab!), key: otherKey, kind: "sent" },
    { kind: "answered" },
    { kind: "start-failed", why: "x" },
    { kind: "not-sent" },
    { kind: "paint-timed-out" },
    { kind: "paint-backoff-ended" },
    { kind: "stopped", retry: false },
    { kind: "stopped", retry: true },
    { givenUp: "no picture arrived", kind: "stopped", retry: false },
    { kind: "repair-begun", retry: true },
    { kind: "repair-begun", retry: false },
    { kind: "repair-drawn" },
    { kind: "stop-timed-out" },
    { kind: "casts-ended" },
    { kind: "frame", verdict: "show" },
    { kind: "frame", verdict: "set-aside" },
    { kind: "frame", verdict: "misfit" },
    { kind: "frame", verdict: "other-size-with-start" },
    { kind: "first-frame-timeout" },
    { kind: "resumed" },
    { kind: "tab-closed-beside" },
    { document: "b", geometryRevision: 2, kind: "restamped" },
  ];

  it("changes what was told only as each event says", () => {
    let cases = 0;
    for (const [name, now] of wants)
      for (const state of states.filter((_, index) => index % 7 === 0))
        for (const event of events) {
          cases += 1;
          const next = after(state, event, now);
          const at = JSON.stringify({ event, name, state: state.told.state });
          const told = state.told.state;
          const changed = next.told.state !== told;
          if (!changed) continue;
          const to = next.told.state;
          const allowed: Record<string, readonly string[]> = {
            answered: told === "sent" ? ["running"] : [],
            "casts-ended": ["none"],
            "first-frame-timeout": told === "preparing" || told === "sent" ? ["none"] : [],
            "not-sent": told === "preparing" ? ["none"] : [],
            "paint-timed-out": told === "preparing" ? ["none"] : [],
            "repair-begun": ["none"],
            sent: ["sent"],
            "start-begun": ["preparing"],
            "start-failed": told === "preparing" || told === "sent" ? ["none"] : [],
            stopped: ["none"],
          };
          expect(allowed[event.kind] ?? [], at).toContain(to);
        }
    expect(cases).toBeGreaterThan(10_000);
  });

  it("counts every retry with no picture, a repair once it is drawn, and counts afresh for another cast or a resume", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    expect(after(running, { kind: "stopped", retry: true }, base).unpictured).toBe(1);
    expect(after(running, { kind: "stopped", retry: false }, base).unpictured).toBe(0);
    expect(
      after({ ...running, shown: true }, { kind: "stopped", retry: true }, base).unpictured,
    ).toBe(0);
    // R10: a repair counts once the page is drawn again, not as it is asked for; R2: one a closed
    // tab asked for is a change and never counts.
    const retried = after(running, { kind: "repair-begun", retry: true }, base);
    expect(retried.unpictured).toBe(0);
    expect(after(retried, { kind: "repair-drawn" }, base).unpictured).toBe(1);
    const changed = after(running, { kind: "repair-begun", retry: false }, base);
    expect(after(changed, { kind: "repair-drawn" }, base).unpictured).toBe(0);
    const counted = { ...running, unpictured: 2 };
    const at = startFacts(base.tab!);
    expect(after(counted, { at, key, kind: "sent" }, base).unpictured).toBe(2);
    expect(after(counted, { at, key: otherKey, kind: "sent" }, base).unpictured).toBe(0);
    expect(after(counted, { kind: "resumed" }, base).unpictured).toBe(0);
  });

  it("tries a cast given up again, counted afresh, when its size, capture, raster or document changes", () => {
    const failed: TabCastState = {
      ...initialTabCastState(),
      failed: { key, why: "no picture arrived" },
      unpictured: 3,
    };
    expect(
      after(failed, { kind: "observed" }, facts({}, { geometryRevision: 9 })).failed?.key,
    ).toBe(key);
    const navigated = after(
      failed,
      { kind: "observed" },
      facts({}, { document: "b", geometryRevision: 2 }),
    );
    expect(navigated).toMatchObject({ failed: null, unpictured: 0 });
  });

  // Re-check 11, finding 3 (U3): a paint wait belongs to the picture it timed out for; once the
  // size, capture revision or geometry revision moves on, `observed` clears it so `reconcile`
  // restores rendering demand and clears the stale backoff timer.
  it("clears a stale paint backoff on observed once the cast's key moves on", () => {
    const waiting = after(
      { ...initialTabCastState(), told: { state: "preparing" } },
      { kind: "paint-timed-out" },
      base,
    );
    expect(waiting.paint).not.toBeNull();
    // Same size, capture and geometry: paint wait stays.
    expect(after(waiting, { kind: "observed" }, base).paint).toEqual(waiting.paint);
    // Resize / geometry move: paint wait is cleared.
    expect(
      after(
        waiting,
        { kind: "observed" },
        facts({}, { geometryRevision: 2, size: { height: 700, width: 900 } }),
      ).paint,
    ).toBeNull();
    // Capture revision move on a native page: paint wait is cleared.
    const nativeWaiting = after(
      { ...initialTabCastState(), told: { state: "preparing" } },
      { kind: "paint-timed-out" },
      native,
    );
    expect(
      after(
        nativeWaiting,
        { kind: "observed" },
        facts(
          {},
          {
            capture: { height: 600, rasterScale: 2, revision: 2, width: 800 },
            native: true,
            sizesView: false,
          },
        ),
      ).paint,
    ).toBeNull();
  });

  it("gives a running cast's first picture its time only while the plan still gives one (R10)", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    const otherSize: TabCastState = { ...running, trouble: "other-size" };
    for (const awaiting of [running, otherSize]) {
      expect(after(awaiting, { kind: "first-frame-timeout" }, base).trouble).toBe("no-picture");
      // Not under a hold, not once pictured, not for a pause.
      expect(
        after(awaiting, { kind: "first-frame-timeout" }, facts({}, { dialogOpen: true })),
      ).toBe(awaiting);
      expect(after(awaiting, { kind: "first-frame-timeout" }, facts({ streaming: false }))).toBe(
        awaiting,
      );
      const shown = { ...awaiting, shown: true };
      expect(after(shown, { kind: "first-frame-timeout" }, base)).toBe(shown);
    }
    // Re-check 11, finding 5.2 (U6): a page still loading (or with a pending navigation) gets a
    // longer limit (10 s, 20 s, 40 s) rather than waiting forever.
    const loadingNow = facts({}, { loading: true });
    const pendingNow = facts(
      {},
      { navigation: { blankDocument: false, finished: 1, pending: true } },
    );
    for (const slow of [loadingNow, pendingNow]) {
      const slowSteps = [0, 1, 2, 3].map((unpictured) =>
        nextStep(slow, "tab#1", { ...running, unpictured }),
      );
      expect(slowSteps.map((step) => (step.kind === "wait" ? step.timer : null))).toEqual([
        10_000, 20_000, 40_000, 40_000,
      ]);
      expect(after(running, { kind: "first-frame-timeout" }, slow).trouble).toBe("no-picture");
    }
    // Three seconds, then six, then twelve as it is retried; given up at the bound, saying so.
    const steps = [0, 1, 2, 3].map((unpictured) =>
      nextStep(base, "tab#1", { ...running, unpictured }),
    );
    expect(steps.slice(0, 3).map((step) => (step.kind === "wait" ? step.timer : null))).toEqual([
      3_000, 6_000, 12_000,
    ]);
    expect(nextStep(base, "tab#1", { ...running, trouble: "no-picture", unpictured: 3 })).toEqual({
      kind: "fail",
      why: "no picture arrived",
    });
    expect(nextStep(base, "tab#1", { ...running, trouble: "no-picture" })).toEqual({
      kind: "repair",
      retry: true,
      why: "no picture arrived",
    });
  });

  it("finds a session's stop still with Chromium when the tab is bound again", () => {
    expect(
      nextStep(base, "tab#1", initialTabCastState(), { ...initialSessionCastState, stops: 1 }),
    ).toEqual({
      kind: "wait",
      why: "a stop is with Chromium",
    });
  });

  // Re-check 10, S2 (finding 2) and re-check 11, finding 1 (U1): a start that failed before it
  // reached Chromium is no refusal, and `pictureLimit` is the number of RETRIES after the first
  // attempt in every path (1 retry on a native page, 3 on a page sized by command).
  it("retries a start that failed before it was sent up to pictureLimit, then gives up", () => {
    for (const [label, now] of [
      ["native page", native],
      ["page sized by the follow view", base],
    ] as const) {
      const limit = pictureLimit(now.tab!.native);
      let state: TabCastState = { ...initialTabCastState(), told: { state: "preparing" } };
      // First attempt plus `limit` retries: the first `limit` failures retry; failure `limit + 1` gives up.
      for (let failure = 1; failure <= limit + 1; failure += 1) {
        state = after(
          state,
          { kind: "start-failed", why: "Electron browser page is closed." },
          now,
        );
        expect(state, `${label} failure ${failure}`).toMatchObject({
          refusal: null,
          told: { state: "none" },
        });
        if (failure <= limit) {
          expect(state.unpictured, `${label} failure ${failure}`).toBe(failure);
          expect(state.failed, `${label} failure ${failure}`).toBeNull();
          expect(nextStep(now, "tab#1", state).kind, `${label} failure ${failure}`).toBe("start");
          state = after(state, { kind: "start-begun" }, now);
        } else {
          expect(state.failed?.why, `${label} failure ${failure}`).toBe(
            "its start could not be made (Electron browser page is closed.)",
          );
          expect(nextStep(now, "tab#1", state).kind, `${label} failure ${failure}`).toBe("wait");
        }
      }
    }
    // A start Chromium refused is a refusal, of the facts when it was sent.
    const sentAt = startFacts(tab({ loading: true }));
    const sent: TabCastState = {
      ...initialTabCastState(),
      told: { at: sentAt, key, state: "sent" },
    };
    expect(after(sent, { kind: "start-failed", why: "no" }, base)).toMatchObject({
      refusal: { ...sentAt, why: "no" },
      unpictured: 0,
    });
    // Retries from an earlier cast do not carry into a different cast before its first start is sent.
    const moved = after(
      { ...initialTabCastState(), lastKey: keyOf(native), unpictured: 1 },
      { kind: "observed" },
      facts({ density: 1 }, native.tab!),
    );
    expect(moved).toMatchObject({ lastKey: null, unpictured: 0 });
  });

  // Re-check 11, finding 5.1 (U5): a CDP preparation failure (Emulation.setVisibleSize) during a
  // navigation is held as a refusal rather than spinning into `failed`; and a cast given up while
  // loading is cleared once loading ends even without a new document.
  it("holds a preparation CDP failure during navigation as a refusal and clears loading-time failure when load ends", () => {
    const loadingFacts = facts({}, { loading: true });
    const at = startFacts(loadingFacts.tab!);
    const preparing: TabCastState = { ...initialTabCastState(), told: { state: "preparing" } };
    const refused = after(
      preparing,
      { at, kind: "start-failed", why: "Target closed during navigation" },
      loadingFacts,
    );
    expect(refused).toMatchObject({
      failed: null,
      refusal: { ...at, why: "Target closed during navigation" },
      told: { state: "none" },
      unpictured: 0,
    });
    expect(nextStep(loadingFacts, "tab#1", refused).kind).toBe("wait");
    // Once loading ends without a new document, the refusal releases.
    expect(after(refused, { kind: "observed" }, base).refusal).toBeNull();
    // A cast given up while loading is cleared when loading finishes without a new document.
    const failedWhileLoading = after(
      { ...initialTabCastState(), told: { key, state: "running" }, unpictured: 3 },
      { givenUp: "no picture arrived", kind: "stopped", retry: false },
      loadingFacts,
    );
    expect(failedWhileLoading.failed).not.toBeNull();
    expect(after(failedWhileLoading, { kind: "observed" }, loadingFacts).failed).not.toBeNull();
    expect(after(failedWhileLoading, { kind: "observed" }, base)).toMatchObject({
      failed: null,
      unpictured: 0,
    });
    // A cast given up while NOT loading stays given up when loading is false.
    const failedIdle = after(
      { ...initialTabCastState(), told: { key, state: "running" }, unpictured: 3 },
      { givenUp: "no picture arrived", kind: "stopped", retry: false },
      base,
    );
    expect(after(failedIdle, { kind: "observed" }, base).failed).toEqual(failedIdle.failed);
  });

  // Re-check 11, finding 6.3 (U5): first-frame-timeout uses explicit binding and session state.
  it("ignores first-frame-timeout when binding differs or a session stop is in flight", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
    };
    expect(after(running, { binding: "other#2", kind: "first-frame-timeout" }, base)).toBe(running);
    expect(
      after(
        running,
        {
          binding: "tab#1",
          kind: "first-frame-timeout",
          session: { ...initialSessionCastState, stops: 1 },
        },
        base,
      ),
    ).toBe(running);
  });

  // Re-check 10, S6: a cast at its bound is given up, even when a closed tab asks for a repair.
  it("gives up a cast at its bound before a repair a closed tab asks for", () => {
    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      redraw: true,
      told: { key, state: "running" },
      trouble: "misfit",
      unpictured: 3,
    };
    expect(nextStep(base, "tab#1", running).kind).toBe("fail");
    expect(nextStep(base, "tab#1", { ...running, unpictured: 2 })).toEqual({
      kind: "repair",
      retry: false,
      why: "a tab closed",
    });
  });

  // Re-check 10, S1 and S3: the session's stops, written by one pure function.
  it("settles a session's stops when the engine ends its casts or a stop's time is up, and ignores a late answer", () => {
    let session = initialSessionCastState;
    session = afterSession(session, { kind: "stop-sent" });
    session = afterSession(session, { kind: "stop-sent" });
    expect(session).toEqual({
      endedBefore: 0,
      generation: 0,
      staleStops: 0,
      stops: 2,
      timedOut: 0,
    });
    expect(afterSession(session, { generation: 0, kind: "stop-answered" }).stops).toBe(1);
    const ended = afterSession(session, { kind: "casts-ended" });
    expect(ended).toEqual({
      endedBefore: 1,
      generation: 1,
      staleStops: 0,
      stops: 0,
      timedOut: 0,
    });
    // The ended generation's answers change nothing, and never go below none.
    expect(afterSession(ended, { generation: 0, kind: "stop-answered" })).toBe(ended);
    const timedOut = afterSession(session, { generation: 0, kind: "stop-timed-out" });
    expect(timedOut).toEqual({
      endedBefore: 0,
      generation: 1,
      staleStops: 2,
      stops: 0,
      timedOut: 1,
    });
    expect(afterSession(timedOut, { kind: "timed-out-taken" })).toEqual({
      endedBefore: 0,
      generation: 1,
      staleStops: 2,
      stops: 0,
      timedOut: 0,
    });
    expect(afterSession(timedOut, { generation: 0, kind: "stop-timed-out" })).toBe(timedOut);
    const again = afterSession(timedOut, { kind: "stop-sent" });
    // W1: a late answer to a timed-out stop decrements staleStops without touching current stops.
    expect(afterSession(again, { generation: 0, kind: "stop-answered" })).toEqual({
      endedBefore: 0,
      generation: 1,
      staleStops: 1,
      stops: 1,
      timedOut: 1,
    });
    // The tab's next start after a stop given up on counts as an attempt, even across a resize or
    // rebind (re-check 11, finding 4 / U4).
    const afterRebind = after(initialTabCastState(), { kind: "stop-timed-out" }, base);
    expect(afterRebind.unpictured).toBe(1);
    expect(
      after(afterRebind, { at: startFacts(base.tab!), key, kind: "sent" }, base).unpictured,
    ).toBe(1);
    const resized = after(
      { ...initialTabCastState(), lastKey: key, told: { key, state: "running" } },
      { kind: "stopped", retry: false },
      facts({}, { size: { height: 700, width: 900 } }),
    );
    const timedOutResize = after(
      resized,
      { kind: "stop-timed-out" },
      facts({}, { size: { height: 700, width: 900 } }),
    );
    expect(
      after(
        timedOutResize,
        { at: startFacts(base.tab!), key: otherKey, kind: "sent" },
        facts({}, { size: { height: 700, width: 900 } }),
      ).unpictured,
    ).toBe(1);
    // A stop timeout on a retry/repair of one document still resets retries if a new document
    // commits before the next start (caught by 3,000-seed generated test, Linux seed 3769445).
    const retryTimedOut = after(
      { ...initialTabCastState(), lastKey: key, unpictured: 1 },
      { kind: "stop-timed-out" },
      base,
    );
    expect(retryTimedOut).toMatchObject({ lastKey: key, unpictured: 2 });
    expect(after(retryTimedOut, { kind: "observed" }, facts({}, { document: "b" }))).toMatchObject({
      lastKey: null,
      unpictured: 0,
    });
  });

  it("clears a pending tab-closed redraw when the running cast stops or its casts end", () => {
    const base = facts();
    const key = keyOf(base);
    const pendingRedraw = after(
      { ...initialTabCastState(), lastKey: key, shown: true, told: { key, state: "running" } },
      { kind: "tab-closed-beside" },
      base,
    );
    expect(pendingRedraw.redraw).toBe(true);
    expect(
      after(pendingRedraw, { kind: "stopped", retry: false }, facts({ density: 1 })).redraw,
    ).toBe(false);
    expect(after(pendingRedraw, { kind: "casts-ended" }, base).redraw).toBe(false);
  });

  it("resets retries when a preparation failure lands after the wanted cast moved to a new key", () => {
    const oldFacts = facts();
    const oldKey = keyOf(oldFacts);
    const newFacts = facts({}, { document: "b", size: { height: 700, width: 900 } });
    const newKey = keyOf(newFacts);
    const preparing = {
      ...initialTabCastState(),
      lastKey: oldKey,
      told: { state: "preparing" as const },
      unpictured: 3,
    };
    const failed = after(
      preparing,
      { kind: "start-failed", why: "Emulation.setVisibleSize failed" },
      newFacts,
    );
    expect(failed.failed).toBeNull();
    expect(failed.unpictured).toBe(1);
    expect(failed.lastKey).toEqual(newKey);
    // Resizing away and back while preparing also clears the old cast's retries on observed
    // (caught by 30,000-seed generated test, Linux seed 222745633).
    const observedAway = after(preparing, { kind: "observed" }, newFacts);
    expect(observedAway).toMatchObject({ lastKey: null, unpictured: 0 });
    const failedBack = after(
      observedAway,
      { kind: "start-failed", why: "Emulation.setVisibleSize failed" },
      oldFacts,
    );
    expect(failedBack.failed).toBeNull();
    expect(failedBack.unpictured).toBe(1);
  });

  // Opus review W1: frames arriving while an earlier-generation timed-out stop is unanswered
  // may be shown but do not mark the running cast pictured or clear retries.
  it("counts earlier-generation timed-out stops and shows their frames without marking the cast pictured (W1)", () => {
    const base = facts();
    const key = keyOf(base);
    let session = afterSession(initialSessionCastState, { kind: "stop-sent" });
    session = afterSession(session, { generation: 0, kind: "stop-timed-out" });
    expect(session).toMatchObject({ generation: 1, staleStops: 1, stops: 0, timedOut: 1 });

    const running: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { key, state: "running" },
      unpictured: 1,
    };
    const verdict = frameVerdict(
      running,
      session,
      { document: "a", geometry: key.region, raster: key.raster },
      base,
    );
    expect(verdict).toBe("show-unproven");
    const afterUnproven = after(running, { kind: "frame", verdict }, base);
    expect(afterUnproven.shown).toBe(false);
    expect(afterUnproven.unpictured).toBe(1);
    expect(nextStep(base, "tab#1", afterUnproven, session)).toMatchObject({
      kind: "wait",
      timer: 6_000,
    });

    // A late answer to the timed-out stop decrements staleStops without touching current stops.
    const withNewStop = afterSession(session, { kind: "stop-sent" });
    const afterLate = afterSession(withNewStop, { generation: 0, kind: "stop-answered" });
    expect(afterLate).toMatchObject({ generation: 1, staleStops: 0, stops: 1 });

    // Once casts-ended advances the generation, earlier answers change nothing.
    const ended = afterSession(withNewStop, { kind: "casts-ended" });
    expect(ended).toMatchObject({ generation: 2, staleStops: 0, stops: 0, timedOut: 0 });
    expect(afterSession(ended, { generation: 0, kind: "stop-answered" })).toBe(ended);
    expect(afterSession(ended, { generation: 1, kind: "stop-answered" })).toBe(ended);

    // Restamping for a new document at the same size resets unpictured so the new document gets
    // its full retries (caught by generated test Linux seed 815658).
    const restampedState = after(
      { ...running, trouble: "no-picture", unpictured: 3 },
      { document: "b", geometryRevision: 2, kind: "restamped" },
      facts({}, { document: "b", geometryRevision: 2 }),
    );
    expect(restampedState).toMatchObject({ shown: false, trouble: null, unpictured: 0 });
  });

  // Opus review W2: a refusal held while loading/navigating is bounded by the loading wait timer.
  it("bounds a refusal held while loading or navigating and gives up at pictureLimit (W2)", () => {
    const loadingFacts = facts({}, { loading: true });
    const key = keyOf(loadingFacts);
    const preparing: TabCastState = {
      ...initialTabCastState(),
      told: { state: "preparing" },
    };
    const refused = after(
      preparing,
      {
        at: startFacts(loadingFacts.tab!),
        kind: "start-failed",
        why: "Emulation.setVisibleSize failed",
      },
      loadingFacts,
    );
    expect(refused.refusal?.why).toBe("Emulation.setVisibleSize failed");
    expect(nextStep(loadingFacts, "tab#1", refused)).toEqual({
      kind: "wait",
      timer: 10_000,
      why: "refused (Emulation.setVisibleSize failed) until its loading, its document change",
    });

    // At the 10 s bound, refusal is released and unpictured increments (retry 1).
    const retry1 = after(refused, { binding: "tab#1", kind: "first-frame-timeout" }, loadingFacts);
    expect(retry1).toMatchObject({ failed: null, refusal: null, unpictured: 1 });
    expect(nextStep(loadingFacts, "tab#1", retry1)).toEqual({ kind: "start" });

    // Backoff doubles while still loading (20 s at unpictured=1, 40 s at unpictured=2).
    expect(nextStep(loadingFacts, "tab#1", { ...refused, unpictured: 1 })).toMatchObject({
      kind: "wait",
      timer: 20_000,
    });
    expect(nextStep(loadingFacts, "tab#1", { ...refused, unpictured: 2 })).toMatchObject({
      kind: "wait",
      timer: 40_000,
    });

    // At pictureLimit (3 on command-sized), the bound gives up with whileLoading and Opensteer's
    // sentence (keeping the raw refusal text in detail for diagnostics).
    const givenUp = after(
      { ...refused, unpictured: 3 },
      { binding: "tab#1", kind: "first-frame-timeout" },
      loadingFacts,
    );
    expect(givenUp).toMatchObject({
      failed: {
        detail: "Emulation.setVisibleSize failed",
        key,
        whileLoading: true,
        why: "the page could not start casting while loading",
      },
      refusal: null,
      unpictured: 3,
    });

    // Outside loading/navigation, a refusal wait has no timer (already reported to caller).
    const idleFacts = facts({}, { loading: false });
    const idleRefused = after(
      { ...initialTabCastState(), told: { at: startFacts(idleFacts.tab!), key, state: "sent" } },
      { kind: "start-failed", why: "Target closed" },
      idleFacts,
    );
    expect(nextStep(idleFacts, "tab#1", idleRefused)).toEqual({
      kind: "wait",
      why: "refused (Target closed) until its loading, its document change",
    });
  });

  // Opus re-check X1: answering a start proves earlier-generation timed-out stops took effect.
  it("settles earlier stale stops when a start is answered so subsequent frames prove the running cast (X1)", () => {
    let session = afterSession(initialSessionCastState, { kind: "stop-sent" });
    session = afterSession(session, { generation: 0, kind: "stop-timed-out" });
    expect(session.staleStops).toBe(1);
    const settled = afterSession(session, { kind: "start-answered" });
    expect(settled).toMatchObject({ endedBefore: 1, generation: 1, staleStops: 0, stops: 0 });
    // Even if another stop later times out in gen 1, a super-late gen 0 answer cannot lower gen 1's staleStops.
    const nextTimedOut = afterSession(afterSession(settled, { kind: "stop-sent" }), {
      generation: 1,
      kind: "stop-timed-out",
    });
    expect(nextTimedOut.staleStops).toBe(1);
    expect(afterSession(nextTimedOut, { generation: 0, kind: "stop-answered" }).staleStops).toBe(1);
  });

  // Opus re-check X2: a start with Chromium (plus preparing, repairing, and lost capture) has a bounded wait timer.
  it("bounds a start with Chromium, a start being prepared, and a repair with timers and gives up at pictureLimit (X2)", () => {
    const base = facts();
    const key = keyOf(base);
    const sentState: TabCastState = {
      ...initialTabCastState(),
      lastKey: key,
      told: { at: startFacts(base.tab!), key, state: "sent" },
    };
    expect(nextStep(base, "tab#1", sentState)).toEqual({
      kind: "wait",
      timer: stopAnswerWaitMs,
      why: "a start is with Chromium",
    });
    const retry1 = after(sentState, { binding: "tab#1", kind: "first-frame-timeout" }, base);
    expect(retry1).toMatchObject({ failed: null, told: { state: "none" }, unpictured: 1 });
    const givenUp = after(
      { ...sentState, unpictured: 3 },
      { binding: "tab#1", kind: "first-frame-timeout" },
      base,
    );
    expect(givenUp).toMatchObject({
      failed: { key, why: "the page did not answer the start" },
      told: { state: "none" },
      unpictured: 3,
    });

    // Preparing, repairing, and lost-capture waits are also bounded by timers.
    const preparingState: TabCastState = { ...initialTabCastState(), told: { state: "preparing" } };
    expect(nextStep(base, "tab#1", preparingState)).toEqual({
      kind: "wait",
      timer: prepareWaitMs,
      why: "a start is being prepared",
    });
    const repairingState: TabCastState = { ...initialTabCastState(), repairing: "retry" };
    expect(nextStep(base, "tab#1", repairingState)).toEqual({
      kind: "wait",
      timer: repairWaitMs,
      why: "the page is drawn again",
    });
    const lostCaptureFacts = facts({}, { capture: null, native: true });
    expect(nextStep(lostCaptureFacts, "tab#1", initialTabCastState())).toEqual({
      kind: "wait",
      timer: captureWaitMs,
      why: "its capture is let go",
    });
  });
});
