import { createId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { TRIGGER_PROGRAM_VERSION_REFUSAL } from "@opensteer/triggers";
import { describe, expect, it, vi } from "vitest";
import { triggerProgramCompatibilityReason } from "./trigger-program-compatibility.js";

// Failure modes: missing environment/Runner, never-advertised Runner, old advertisement,
// and conflating discovery support with program support. Offline stored support must work.
describe("Trigger program Runner compatibility", () => {
  it.each(
    [null, [], ["environment-list-v1"], ["browser-profile-create-v1"]].map((capabilities) => ({
      capabilities,
    })),
  )("refuses v5 without its dedicated stored advertisement: %j", async ({ capabilities }) => {
    const store = {
      getEnvironment: vi.fn(async () => ({ runnerId: createId("runner") })),
      runnerCapabilities: vi.fn(async () => capabilities),
    } as unknown as Pick<OpensteerStore, "getEnvironment" | "runnerCapabilities">;
    expect(await triggerProgramCompatibilityReason(store, createId("environment"), 5)).toBe(
      "Update this computer to run automation programs with tool contract version 5.",
    );
  });
  it.each([null, { runnerId: null }])(
    "refuses v5 without an anchor Runner: %j",
    async (environment) => {
      const runnerCapabilities = vi.fn();
      const store = {
        getEnvironment: vi.fn(async () => environment),
        runnerCapabilities,
      } as unknown as Pick<OpensteerStore, "getEnvironment" | "runnerCapabilities">;
      expect(await triggerProgramCompatibilityReason(store, createId("environment"), 5)).toContain(
        "version 5",
      );
      expect(runnerCapabilities).not.toHaveBeenCalled();
    },
  );
  it("accepts a stored v5 advertisement without requiring a connected Runner", async () => {
    const store = {
      getEnvironment: vi.fn(async () => ({ runnerId: createId("runner") })),
      runnerCapabilities: vi.fn(async () => ["trigger-program-v5"]),
    } as unknown as Pick<OpensteerStore, "getEnvironment" | "runnerCapabilities">;
    expect(await triggerProgramCompatibilityReason(store, createId("environment"), 5)).toBeNull();
  });
  it.each([1, 2, 3, 4])("refuses a version %s program by naming version 5", async (version) => {
    const getEnvironment = vi.fn();
    const store = { getEnvironment } as unknown as Pick<
      OpensteerStore,
      "getEnvironment" | "runnerCapabilities"
    >;
    expect(await triggerProgramCompatibilityReason(store, createId("environment"), version)).toBe(
      TRIGGER_PROGRAM_VERSION_REFUSAL,
    );
    expect(getEnvironment).not.toHaveBeenCalled();
  });
});
