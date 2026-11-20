import { describe, expect, it } from "vitest";
import {
  cloudComputerReasonNext,
  cloudComputerReasonSentence,
  cloudComputerStepLabel,
} from "./cloud-computer-copy.js";
import {
  CloudComputerPreparationStepSchema,
  CloudComputerReasonCodeSchema,
} from "./cloud-computers.js";

describe("Cloud Computer reason codes", () => {
  it("has its own sentence where it can, and defers to the Account's where it carries details", () => {
    expect(cloudComputerReasonSentence("cloud-computer-owner-suspended")).toBe(
      "You paused this Cloud Computer.",
    );
    for (const code of [
      "cloud-computer-operator-suspended",
      "cloud-computer-claim-failed",
      "cloud-computer-provisioning-failed",
      "cloud-computer-billing-problem",
    ] as const)
      expect(cloudComputerReasonSentence(code)).toBeNull();
    expect(cloudComputerReasonSentence(undefined)).toBeNull();
    const own = CloudComputerReasonCodeSchema.options.filter((code) =>
      cloudComputerReasonSentence(code),
    );
    expect(own.length).toBe(CloudComputerReasonCodeSchema.options.length - 4);
  });

  it("says what to do next only where there is one thing to do", () => {
    expect(cloudComputerReasonNext("cloud-computer-billing-problem")).toMatch(/Manage billing/u);
    expect(cloudComputerReasonNext("cloud-computer-deleted")).toBeNull();
  });

  it("names every preparation step", () => {
    for (const id of CloudComputerPreparationStepSchema.shape.id.options)
      expect(cloudComputerStepLabel(id)).not.toMatch(/^cloud\./u);
  });
});
