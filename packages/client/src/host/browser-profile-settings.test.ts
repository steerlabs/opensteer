import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  browserProfileAccessSummary,
  browserProfileDeleteConsequence,
  browserProfileDeletionRows,
  browserProfileSettingsRows,
  profileHomeChoice,
} from "./browser-profile-settings.js";

describe("browser profile settings", () => {
  it("handles absent deletion fields and an unavailable computer name", () => {
    expect(browserProfileDeletionRows({ machines: [] })).toEqual([]);
    expect(
      browserProfileDeletionRows({
        machines: [],
        browserProfileDeletions: [
          { profileId: "bpr_deleted", computerId: "rnr_missing", state: "pending-computer" },
        ],
      }),
    ).toEqual([
      { profileId: "bpr_deleted", status: "Will be erased when its computer is back online" },
    ]);
  });

  it("lists profiles by name with the projects allowed and says what deleting takes", () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const base = mock.getSnapshot();
      const main = base.workspaces.find((workspace) => workspace.kind === "main")!;
      const buyer = { ...main, id: "wsp_buyer", kind: "project" as const, name: "Buyer" };
      const research = { ...buyer, id: "wsp_research", name: "Research" };
      const grant = (id: string, profileId: string, workspaceId: string) => ({
        access: "read-write" as const,
        createdAt: "2026-10-30T12:00:00.000Z",
        id,
        profileId,
        workspaceId,
      });
      const rows = browserProfileSettingsRows(
        {
          ...base,
          browserProfiles: [
            { homeRunnerId: null, id: "bpr_work", name: "Work" },
            { homeRunnerId: null, id: "bpr_shopping", name: "Shopping" },
          ],
          browserProfileGrants: [
            grant("g1", "bpr_work", buyer.id),
            grant("g2", "bpr_work", research.id),
            // Main's inherited access is implied, never listed as a project.
            grant("g3", "bpr_shopping", main.id),
          ],
          workspaces: [...base.workspaces, buyer, research],
        },
        null,
      );

      expect(rows.map((row) => row.profile.name)).toEqual(["Shopping", "Work"]);
      expect(rows.map(browserProfileAccessSummary)).toEqual([
        "Opensteer only",
        "Opensteer, Buyer and Research",
      ]);
      expect(browserProfileDeleteConsequence({ ...rows[1]!, tabs: 2 })).toBe(
        "Its sign-ins and site data are erased from this Opensteer. Buyer and Research lose access. The 2 tabs using it close. This can’t be undone.",
      );
      expect(browserProfileDeleteConsequence(rows[0]!)).toBe(
        "Its sign-ins and site data are erased from this Opensteer. This can’t be undone.",
      );
    } finally {
      mock.dispose();
    }
  });

  it("names where a profile lives only away from it, and says when it has none yet", () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = mock.getSnapshot();
      const id = (name: string) => snapshot.machines.find((machine) => machine.name === name)!.id;
      const mini = id("Mac mini");
      const where = (hereId: string | null, source = snapshot) =>
        Object.fromEntries(
          browserProfileSettingsRows(source, hereId).map((row) => [
            row.profile.name,
            row.unopened
              ? "unopened"
              : row.device && `${row.device.name}${row.device.online ? "" : " · Offline"}`,
          ]),
        );
      expect(where(mini)).toEqual({
        Design: "Studio Mac",
        Personal: null,
        Shopping: "Alex's iPhone",
        Travel: "Studio iMac · Offline",
        Work: null,
      });
      // A browser tab can't say which computer it is on, so every device is named.
      expect(where(null)).toMatchObject({ Personal: "Mac mini", Shopping: "Alex's iPhone" });
      expect(where(id("Alex's iPhone"))).toMatchObject({ Personal: "Mac mini", Shopping: null });
      const old = snapshot.browserProfiles.map((profile) =>
        profile.name === "Work" ? { ...profile, homeRunnerId: null } : profile,
      );
      expect(where(mini, { ...snapshot, browserProfiles: old }).Work).toBe("unopened");
      // An older Host says nothing of homes: nothing is claimed about any profile.
      expect(
        where(mini, {
          ...snapshot,
          browserProfileHomes: undefined,
          browserProfiles: old.map((profile) => ({ ...profile, homeRunnerId: null })),
        }),
      ).toEqual({ Design: null, Personal: null, Shopping: null, Travel: null, Work: null });
    } finally {
      mock.dispose();
    }
  });

  it("starts a new profile on this device, else the main computer, else the first listed", () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const snapshot = mock.getSnapshot();
      const id = (name: string) => snapshot.machines.find((machine) => machine.name === name)!.id;
      const choice = (hereId: string | null, source = snapshot) => {
        const homes = profileHomeChoice(source, hereId);
        return (
          homes && {
            initial: homes.options.find((option) => option.id === homes.initial)!.name,
            options: homes.options.map(({ name }) => name),
          }
        );
      };
      expect(choice(id("Alex's iPhone"))).toEqual({
        initial: "Alex's iPhone",
        options: ["Alex's iPhone", "Alex's MacBook Pro", "Mac mini", "Studio iMac", "Studio Mac"],
      });
      expect(choice(null)?.initial).toBe("Mac mini");
      // A device that can't hold profiles is no default, though the reader is at it.
      expect(choice(id("Pixel 7"))?.initial).toBe("Mac mini");
      const server = { ...snapshot.deploymentShape!, kind: "server" as const };
      expect(choice(null, { ...snapshot, deploymentShape: server })?.initial).toBe("Alex's iPhone");
      // Nothing to choose: one device, or a Host that does not say.
      expect(choice(null, { ...snapshot, browserProfileHomes: [id("Mac mini")] })).toBeNull();
      expect(choice(null, { ...snapshot, browserProfileHomes: undefined })).toBeNull();
    } finally {
      mock.dispose();
    }
  });
});
