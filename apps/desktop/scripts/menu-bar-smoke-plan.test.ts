import { expect, it } from "vitest";
import {
  menuBarSmokeAccepted,
  menuBarSmokeTrialPlan,
  menuBarSmokeTrials,
} from "./menu-bar-smoke-plan.js";

it("runs every trial in order, or the ones named, and refuses an unknown one", () => {
  expect(menuBarSmokeTrialPlan([]).map((plan) => plan.trial)).toEqual([...menuBarSmokeTrials]);
  expect(menuBarSmokeTrialPlan(["dock", "home-stop"])).toEqual([
    { trial: "home-stop", needsHome: true, drive: "self" },
    { trial: "dock", needsHome: false, drive: "self" },
  ]);
  expect(() => menuBarSmokeTrialPlan(["tray"])).toThrow(/Unknown menu bar smoke trial: tray/u);
});

it("accepts the journey only when every trial passed, the real helper alone may be unverified", () => {
  const all = menuBarSmokeTrials.map((trial) => ({ trial, outcome: "pass" as const }));
  expect(menuBarSmokeAccepted(all)).toBe(true);
  expect(
    menuBarSmokeAccepted(
      all.map((row) =>
        row.trial === "row-stop" ? { ...row, outcome: "unverified" as const } : row,
      ),
    ),
  ).toBe(true);
  expect(
    menuBarSmokeAccepted(
      all.map((row) => (row.trial === "dock" ? { ...row, outcome: "unverified" as const } : row)),
    ),
  ).toBe(false);
  expect(menuBarSmokeAccepted(all.slice(1))).toBe(false);
  expect(
    menuBarSmokeAccepted(
      all.map((row) => (row.trial === "home-stop" ? { ...row, outcome: "fail" as const } : row)),
    ),
  ).toBe(false);
});
