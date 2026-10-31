import { describe, expect, it } from "vitest";
import { MockHostClient } from "../mock/mock-host-client.js";
import {
  browserProfileAccessSummary,
  browserProfileDeleteConsequence,
  browserProfileSettingsRows,
} from "./browser-profile-settings.js";

describe("browser profile settings", () => {
  it("lists profiles by name with the specialists allowed and says what deleting takes", () => {
    const mock = new MockHostClient({ latencyMs: 0 });
    try {
      const base = mock.getSnapshot();
      const main = base.workspaces.find((workspace) => workspace.kind === "main")!;
      const buyer = { ...main, id: "wsp_buyer", kind: "specialized" as const, name: "Buyer" };
      const research = { ...buyer, id: "wsp_research", name: "Research" };
      const grant = (id: string, profileId: string, workspaceId: string) => ({
        access: "full-control" as const,
        createdAt: "2026-10-30T12:00:00.000Z",
        id,
        profileId,
        workspaceId,
      });
      const rows = browserProfileSettingsRows({
        ...base,
        browserProfiles: [
          { id: "bpr_work", name: "Work", revision: 2 },
          { id: "bpr_shopping", name: "Shopping", revision: 1 },
        ],
        browserProfileGrants: [
          grant("g1", "bpr_work", buyer.id),
          grant("g2", "bpr_work", research.id),
          // Main's inherited access is implied, never listed as a specialist.
          grant("g3", "bpr_shopping", main.id),
        ],
        workspaces: [...base.workspaces, buyer, research],
      });

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
});
