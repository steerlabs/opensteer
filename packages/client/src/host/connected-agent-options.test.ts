import { BrowserSourceIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { chromeTabGrantOptions, draftForCatalog } from "./connected-agent-options.js";

const workMac = BrowserSourceIdSchema.parse("bsr_00000000-0000-4000-8000-000000000001");
const homeMac = BrowserSourceIdSchema.parse("bsr_00000000-0000-4000-8000-000000000002");

describe("Chrome tab sharing at consent", () => {
  it("offers paired Chrome and names the devices that need to pair again in one hint", () => {
    const chrome = chromeTabGrantOptions({
      chromeTabs: [
        { sourceId: workMac, computerName: "Work Mac", paired: true },
        { sourceId: homeMac, computerName: "Home Mac", paired: false },
      ],
      chromeTabsNeedPairing: true,
      chromeTabsRepairNames: ["Studio Mac"],
    });
    expect(chrome.options.map(({ name }) => name)).toEqual([
      "Tabs you share from Chrome on Work Mac",
    ]);
    expect(chrome.repair).toBe(
      "To share tabs from Chrome on Studio Mac and Home Mac, pair Chrome again on each device.",
    );
    expect(
      chromeTabGrantOptions({
        chromeTabs: [{ sourceId: workMac, computerName: "Work Mac", paired: true }],
        chromeTabsNeedPairing: true,
      }).repair,
    ).toBe("To share tabs with a connected agent, pair Chrome again.");
  });

  it("names the Chrome that must be paired again, or says it plainly when the Home doesn't", () => {
    expect(
      chromeTabGrantOptions({
        chromeTabs: [{ sourceId: workMac, computerName: "Work Mac", paired: false }],
      }).repair,
    ).toBe("To share tabs from Chrome on Work Mac, pair it again.");
    expect(chromeTabGrantOptions({ chromeTabs: [], chromeTabsNeedPairing: true }).repair).toBe(
      "To share tabs with a connected agent, pair Chrome again.",
    );
    expect(chromeTabGrantOptions(undefined).repair).toBeNull();
  });

  it("keeps a read-again draft, except a Chrome no longer offered", () => {
    const draft = {
      scope: "selected" as const,
      tasks: true,
      newProfile: null,
      resources: [
        { kind: "chrome-tabs" as const, sourceId: workMac },
        { kind: "chrome-tabs" as const, sourceId: homeMac },
      ],
    };
    expect(
      draftForCatalog(draft, {
        chromeTabs: [
          { sourceId: workMac, computerName: "Work Mac", paired: true },
          { sourceId: homeMac, computerName: "Home Mac", paired: false },
        ],
      }),
    ).toEqual({ ...draft, resources: [{ kind: "chrome-tabs", sourceId: workMac }] });
    const kept = { ...draft, resources: [draft.resources[0]!] };
    expect(
      draftForCatalog(kept, {
        chromeTabs: [{ sourceId: workMac, computerName: "Work Mac", paired: true }],
      }),
    ).toBe(kept);
  });
});
