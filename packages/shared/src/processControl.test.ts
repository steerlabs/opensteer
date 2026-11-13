import { describe, expect, it } from "vitest";
import { supervisedExitCode, windowsSupervisorDrained } from "./processControl.js";

const drained = (status: number) => 0x2f53_0000 + status;

describe("a Windows supervisor's exit code", () => {
  it.each([0, 3, 137, 255])("proves its Job drained and carries target status %i", (status) => {
    expect(windowsSupervisorDrained(drained(status))).toBe(true);
    expect(supervisedExitCode(drained(status), "win32")).toBe(status);
  });

  it.each([
    ["it gave up draining", 256],
    ["it was killed from outside", 1],
    ["it crashed", 0xc000_0005],
    ["it exited by signal", null],
    ["it is just below the tag", drained(0) - 1],
    ["it is just above the tag", drained(256)],
  ])("proves nothing when %s, and passes the code through", (_reason, code) => {
    expect(windowsSupervisorDrained(code)).toBe(false);
    expect(supervisedExitCode(code, "win32")).toBe(code);
  });

  it("is the target's own status elsewhere", () => {
    expect(supervisedExitCode(drained(3), "darwin")).toBe(drained(3));
    expect(supervisedExitCode(3, "linux")).toBe(3);
  });
});
