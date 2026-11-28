import { expect, it } from "vitest";
import { thisComputerRunnerId } from "./this-computer.js";

it("is the desktop's own Runner for a Home elsewhere", () => {
  expect(thisComputerRunnerId({ hostingRunnerId: null, localRunnerId: "rnr_slot" })).toBe(
    "rnr_slot",
  );
});

// A Home this Mac hosts has no slot Runner: its own Runner is this computer,
// so a sign-in its engine starts opens here, in the person's own browser.
it("is the Home's own Runner when this Mac hosts the Home", () => {
  expect(thisComputerRunnerId({ hostingRunnerId: "rnr_home", localRunnerId: null })).toBe(
    "rnr_home",
  );
});

it("is unknown in a browser that is not the desktop app", () => {
  expect(thisComputerRunnerId({ hostingRunnerId: null, localRunnerId: null })).toBeNull();
});
