import { createId } from "@opensteer/core";
import type { OpensteerStore } from "@opensteer/database";
import { describe, expect, it, vi } from "vitest";
import { triggerProgramCompatibilityReason } from "./trigger-program-compatibility.js";

// Failure modes: missing environment/Runner, never-advertised Runner, old advertisement,
// and conflating discovery support with program support. Offline stored support must work.
describe("Trigger program Runner compatibility", () => {
  it.each(
    [null, [], ["environment-list-v1"], ["browser-profile-create-v1"]].map((capabilities) => ({
      capabilities,
    })),
  )("refuses v3 without its dedicated stored advertisement: %j", async ({ capabilities }) => {
    const store = {
      getEnvironment: vi.fn(async () => ({ runnerId: createId("runner") })),
      runnerCapabilities: vi.fn(async () => capabilities),
    } as unknown as Pick<OpensteerStore, "getEnvironment" | "runnerCapabilities">;
    expect(await triggerProgramCompatibilityReason(store, createId("environment"), 3)).toBe(
      "This computer's Runner cannot run Trigger program version 3. Use version 2 or update that computer.",
    );
  });
  it.each([null, { runnerId: null }])(
    "refuses v3 without an anchor Runner: %j",
    async (environment) => {
      const runnerCapabilities = vi.fn();
      const store = {
        getEnvironment: vi.fn(async () => environment),
        runnerCapabilities,
      } as unknown as Pick<OpensteerStore, "getEnvironment" | "runnerCapabilities">;
      expect(await triggerProgramCompatibilityReason(store, createId("environment"), 3)).toContain(
        "Use version 2 or update that computer",
      );
      expect(runnerCapabilities).not.toHaveBeenCalled();
    },
  );
  it("accepts a stored v3 advertisement without requiring a connected Runner", async () => {
    const store = {
      getEnvironment: vi.fn(async () => ({ runnerId: createId("runner") })),
      runnerCapabilities: vi.fn(async () => ["trigger-program-v3"]),
    } as unknown as Pick<OpensteerStore, "getEnvironment" | "runnerCapabilities">;
    expect(await triggerProgramCompatibilityReason(store, createId("environment"), 3)).toBeNull();
  });
  it.each([1, 2] as const)("does not change version %s admission", async (version) => {
    const getEnvironment = vi.fn();
    const store = { getEnvironment } as unknown as Pick<
      OpensteerStore,
      "getEnvironment" | "runnerCapabilities"
    >;
    expect(
      await triggerProgramCompatibilityReason(store, createId("environment"), version),
    ).toBeNull();
    expect(getEnvironment).not.toHaveBeenCalled();
  });
});
