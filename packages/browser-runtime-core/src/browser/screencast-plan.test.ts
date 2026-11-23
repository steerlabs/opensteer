import { describe, expect, it } from "vitest";
import {
  canTakeStart,
  fits,
  initialTabCastState,
  nextStep,
  unpicturedLimit,
  wanted,
  type CastFacts,
  type CastKey,
  type NavigationFact,
  type Refusal,
  type TabCastState,
  type TabFacts,
  type Told,
} from "./screencast-plan.js";

/*
 * The follow view's decision, over every combination of its small spaces: what is wanted, whether
 * a cast still fits it, whether the page can take a start, and the one next step. Each step is
 * checked against the facts that may cause it, so a step taken for any other reason fails here.
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
      for (const document of ["a", "b"]) refusals.push({ document, finished, loading, why: "x" });

  it("refuses exactly while the first document is to commit, or until a fact that bears on a refusal changes", () => {
    let cases = 0;
    for (const navigation of navigations)
      for (const refusal of refusals)
        for (const loading of [false, true])
          for (const document of ["a", "b"]) {
            cases += 1;
            const now = tab({ document, loading, navigation });
            const gate = navigation?.pending === true && navigation.blankDocument;
            const released =
              refusal === null ||
              (refusal.loading && !loading) ||
              (navigation
                ? navigation.finished > (refusal.finished ?? -1)
                : document !== refusal.document);
            const result = canTakeStart(now, refusal);
            expect(result.ok, JSON.stringify({ document, loading, navigation, refusal })).toBe(
              !gate && released,
            );
            if (!result.ok) expect(result.why.length).toBeGreaterThan(0);
          }
    expect(cases).toBe(navigations.length * refusals.length * 4);
  });
});

describe("the next step", () => {
  const base = facts();
  const key = keyOf(base);
  const otherKey = keyOf(facts({}, { size: { height: 700, width: 900 } }));
  const tolds: Told[] = [
    { state: "none" },
    { state: "preparing" },
    { key, state: "sent" },
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
    [
      "native",
      facts(
        {},
        {
          native: true,
          capture: { height: 600, rasterScale: 2, revision: 1, width: 800 },
          sizesView: false,
        },
      ),
    ],
  ];
  const states: TabCastState[] = [];
  for (const told of tolds)
    for (const shown of [false, true])
      for (const setAside of [0, 1])
        for (const misfit of [false, true])
          for (const redraw of [false, true])
            for (const unpictured of [0, unpicturedLimit])
              for (const repaired of [false, true])
                for (const paint of [null, { captureRevision: null, geometryRevision: 1, size }])
                  for (const refusal of [
                    null,
                    { document: "a", finished: null, loading: false, why: "x" },
                  ])
                    for (const failedFor of [null, key])
                      states.push({
                        ...initialTabCastState,
                        failedFor,
                        misfit,
                        paint,
                        redraw,
                        refusal,
                        repaired,
                        setAside,
                        shown,
                        told,
                        unpictured,
                      });

  it("binds the tab in view first, and is idle with nothing bound", () => {
    expect(nextStep(base, null, null)).toEqual({ kind: "bind" });
    expect(nextStep(base, "other#1", initialTabCastState)).toEqual({ kind: "bind" });
    expect(nextStep(facts({ closed: true }), "tab#1", initialTabCastState)).toEqual({
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
            expect(want.kind === "cast" && told.state === "none", at).toBe(true);
            expect(canTakeStart(now.tab!, state.refusal).ok, at).toBe(true);
            const failed =
              state.failedFor !== null &&
              want.kind === "cast" &&
              fits(state.failedFor, want.key) === "same";
            expect(failed, at).toBe(false);
            // A paint wait holds only the picture it timed out for.
            expect(
              state.paint === null ||
                want.kind !== "cast" ||
                state.paint.geometryRevision !== want.key.geometryRevision ||
                state.paint.captureRevision !== want.key.captureRevision ||
                state.paint.size.width !== want.key.size.width ||
                state.paint.size.height !== want.key.size.height,
              at,
            ).toBe(true);
            break;
          }
          case "restart":
            expect(
              told.state === "running" &&
                (fit === false || (state.setAside > 0 && state.unpictured < unpicturedLimit)),
              at,
            ).toBe(true);
            break;
          case "restamp":
            expect(fit, at).toBe("new-document");
            break;
          case "repair":
            expect(told.state === "running" && fit === "same", at).toBe(true);
            expect(
              state.redraw ||
                (state.misfit &&
                  !(now.tab!.native && state.repaired) &&
                  state.unpictured < unpicturedLimit),
              at,
            ).toBe(true);
            break;
          case "fail":
            expect(told.state === "running" && fit === "same" && !state.shown, at).toBe(true);
            expect(state.misfit || state.setAside > 0, at).toBe(true);
            expect(
              state.unpictured >= unpicturedLimit || (now.tab!.native && state.repaired),
              at,
            ).toBe(true);
            break;
          case "wait":
            // A wait is for a named fact; a running cast whose frame was set aside or did not fit
            // never waits for its first frame.
            expect(step.why.length, at).toBeGreaterThan(0);
            if (step.why === "its first frame")
              expect(state.setAside === 0 && !state.misfit && !state.redraw, at).toBe(true);
            if (want.kind === "none") throw new Error(`waits while nothing is wanted: ${at}`);
            break;
        }
      }
    expect(cases).toBe(wants.length * states.length);
  });

  it("never sends a start while one is prepared or with Chromium", () => {
    for (const [, now] of wants)
      for (const state of states)
        if (state.told.state === "preparing" || state.told.state === "sent")
          expect(nextStep(now, "tab#1", state).kind).not.toMatch(/^(start|restart|repair)$/u);
  });
});
