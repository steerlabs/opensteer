import { describe, expect, it } from "vitest";
import { PORTABLEFS_KNOWN_VOLUME_STATES, PortableFsManagerVolumeStateSchema } from "./schemas.js";

/**
 * The Manager's authoritative volume-state enum, transcribed from
 * `vcs/internal/controlplane/types.go` in the PortableFS repo at the ref
 * `verify:portablefs-*` anchors, plus the states the tiered-storage rollout
 * adds there. Opensteer must know every one of them *before* the Manager ships
 * it, so this fixture is the release gate: it fails loudly if a known state is
 * dropped from the list this Host maps.
 */
const MANAGER_VOLUME_STATES = [
  "PROVISIONING",
  "READY",
  "FENCING",
  "RETIRED",
  "QUARANTINED",
  // Tiered storage (PortableFS `docs/tiered-storage/`).
  "ARCHIVING",
  "ARCHIVED",
  "RESTORING",
  "DESTROYED",
] as const;

describe("PORTABLEFS_KNOWN_VOLUME_STATES", () => {
  it("covers every state the Manager can report", () => {
    const known = new Set<string>(PORTABLEFS_KNOWN_VOLUME_STATES);
    expect([...MANAGER_VOLUME_STATES].filter((state) => !known.has(state))).toEqual([]);
  });
});

describe("PortableFsManagerVolumeStateSchema", () => {
  it("parses any non-empty state so one unknown value cannot fail the fleet", () => {
    for (const state of MANAGER_VOLUME_STATES) {
      expect(PortableFsManagerVolumeStateSchema.safeParse(state).success).toBe(true);
    }
    expect(PortableFsManagerVolumeStateSchema.safeParse("HIBERNATING").success).toBe(true);
    expect(PortableFsManagerVolumeStateSchema.safeParse("").success).toBe(false);
    expect(PortableFsManagerVolumeStateSchema.safeParse("A".repeat(65)).success).toBe(false);
    expect(PortableFsManagerVolumeStateSchema.safeParse(7).success).toBe(false);
  });
});
