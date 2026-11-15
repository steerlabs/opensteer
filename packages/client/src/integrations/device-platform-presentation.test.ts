import { hostApi } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  computerGlyph,
  computerStatus,
  computerUsesChosenElsewhere,
} from "../computers/computers.js";
import { computerAppElsewhereDetail, computerAppRunsOnPhone } from "./computer-app-words.js";
import {
  computerAppPermissionNotice,
  computerAppPlatformName,
  computerAppPlatformRequirementLabel,
  computerAppPlatformTargetLabel,
  computerAppRows,
  computerAppStateLabel,
  type ComputerAppLiveState,
} from "./computer-apps.js";

/*
 * Failure cases for a client reading a Host that lists iPhones:
 * - a catalog platform the words do not name prints "a undefined" in every
 *   "Requires …" and "Open Opensteer on …" sentence;
 * - an iPhone is "a iPhone" rather than "an iPhone";
 * - an iPhone's Calendar, Contacts or Reminders remedy sends the reader to a
 *   macOS pane on a phone that has none;
 * - a remedy an iPhone cannot have still borrows macOS directions;
 * - the Mac's own notices change once a platform is supplied, or when it is not;
 * - an app whose every platform is unfamiliar reads as an Android-phone app
 *   and gets plug-in-a-phone directions;
 * - an iPhone is drawn as a plain computer, or treated as an Android phone so
 *   its own sentence is replaced by Android Accessibility steps;
 * - an iPhone's row is labelled "Needs macOS permission";
 * - an iPhone that is away reads as broken rather than closed, since it is
 *   offline whenever Opensteer is not open on it;
 * - a phone reading an iPhone's page is told to choose folders and commands
 *   "in Opensteer on a computer", which an iPhone has none of.
 */

const iphoneName = "Alex's iPhone";

const iphoneCalendarDetail = "Calendar needs full access for Opensteer in iPhone Settings.";

const responses = {
  machines: hostApi["machines.list"].success.parse({
    machines: [
      machine({
        device: { form: "laptop", platform: "macos" },
        id: "rnr_11111111-1111-4111-8111-111111111111",
        name: "Alex's MacBook Pro",
      }),
      machine({
        apps: [
          {
            definitionId: "apple-calendar",
            operations: ["list_calendars", "list_events", "create_event"].map((operation) => ({
              detail: iphoneCalendarDetail,
              operation,
              remedy: "calendars",
              state: "permission-required",
            })),
          },
        ],
        device: { form: "phone", platform: "ios" },
        id: "rnr_22222222-2222-4222-8222-222222222222",
        name: iphoneName,
      }),
    ],
  }).machines,
  platform: hostApi["integration.platform.get"].success.parse({
    authorizationSurface: "canonical",
    catalog: [
      catalogEntry(definition({ id: "apple-calendar", name: "Calendar" }, ["darwin", "ios"])),
      catalogEntry(definition({ id: "future-app", name: "Future app" }, ["future-phone-os"])),
      catalogEntry(definition({ id: "android-phone", name: "Android phone" }, ["android"])),
    ],
    connections: [],
    installations: [],
  }),
};

const [mac, iphone] = responses.machines;
const [calendar, futureApp, androidApp] = responses.platform.catalog.map(
  ({ definition }) => definition,
);

describe("an iPhone listed by the Host", () => {
  it("is drawn as a phone beside an unchanged Mac", () => {
    expect(iphone?.device).toEqual({ form: "phone", platform: "ios" });
    expect(computerGlyph(iphone!)).toBe("phone");
    expect(computerGlyph(mac!)).toBe("laptop");
  });

  it("is named with its own word and article", () => {
    expect(computerAppPlatformName("ios")).toBe("iPhone");
    expect(computerAppPlatformTargetLabel(["ios"])).toBe("an iPhone");
    expect(calendar?.computerApp?.platforms).toEqual(["darwin", "ios"]);
    expect(computerAppPlatformRequirementLabel(calendar!)).toBe("Requires a Mac or an iPhone");
  });

  it("keeps the iPhone's own sentence rather than Android steps", () => {
    const [row] = computerAppRows({
      connections: [],
      definitions: [calendar!],
      machine: iphone!,
    });
    expect(row?.readState).toEqual({
      detail: iphoneCalendarDetail,
      kind: "permission-required",
      remedy: "calendars",
    });
  });

  it("explains iPhone Settings, separately from agent access", () => {
    const [row] = computerAppRows({
      connections: [],
      definitions: [calendar!],
      machine: iphone!,
    });
    expect(
      computerAppPermissionNotice({
        appName: row!.definition.name,
        machineName: iphone!.name,
        platform: iphone!.device?.platform,
        state: row!.readState,
      }),
    ).toEqual({
      detail: `${iphoneCalendarDetail} Allow it in iPhone Settings on ${iphoneName}. It does not change the agent access selected for this app.`,
      title: `Calendar needs access on ${iphoneName}`,
    });
    for (const [appName, remedy, detail] of [
      ["Contacts", "contacts", "Contacts needs access for Opensteer in iPhone Settings."],
      ["Reminders", "reminders", "Reminders needs full access for Opensteer in iPhone Settings."],
    ] as const) {
      expect(
        computerAppPermissionNotice({
          appName,
          machineName: iphoneName,
          platform: "ios",
          state: { detail, kind: "permission-required", remedy },
        }),
      ).toEqual({
        detail: `${detail} Allow it in iPhone Settings on ${iphoneName}. It does not change the agent access selected for this app.`,
        title: `${appName} needs access on ${iphoneName}`,
      });
    }
  });

  it("never borrows macOS directions for a remedy an iPhone cannot have", () => {
    for (const remedy of [
      "accessibility",
      "automation",
      "full-disk-access",
      "screen-recording",
    ] as const) {
      expect(
        computerAppPermissionNotice({
          appName: "Calendar",
          machineName: iphoneName,
          platform: "ios",
          state: { detail: "Provider sentence.", kind: "permission-required", remedy },
        }),
      ).toBeNull();
    }
  });

  it("leaves a Mac's notice exactly as it was, with or without its platform", () => {
    const state: ComputerAppLiveState = {
      detail: "Calendar needs macOS full access to calendars.",
      kind: "permission-required",
      remedy: "calendars",
    };
    const macNotice = {
      detail:
        "Calendar needs macOS full access to calendars. Full access for Opensteer Computer Use in Calendars lets it read and change calendars on Alex's MacBook Pro for the agents you approve. It does not change the agent access selected for this app.",
      title: "Calendar needs macOS Calendars access",
    };
    expect(
      computerAppPermissionNotice({ appName: "Calendar", machineName: mac!.name, state }),
    ).toEqual(macNotice);
    expect(
      computerAppPermissionNotice({
        appName: "Calendar",
        machineName: mac!.name,
        platform: mac!.device?.platform,
        state,
      }),
    ).toEqual(macNotice);
  });
});

describe("an iPhone's state, in the words every surface shares", () => {
  it("labels an iPhone's row with its own sentence, and a Mac's as before", () => {
    const [row] = computerAppRows({
      connections: [],
      definitions: [calendar!],
      machine: iphone!,
    });
    expect(computerAppStateLabel(row!.readState, iphone!.device?.platform)).toBe(
      iphoneCalendarDetail,
    );
    expect(computerAppStateLabel(row!.readState, "ios")).not.toContain("macOS");
    const macState: ComputerAppLiveState = {
      detail: "Calendar needs macOS full access to calendars.",
      kind: "permission-required",
      remedy: "calendars",
    };
    expect(computerAppStateLabel(macState)).toBe("Needs macOS permission");
    expect(computerAppStateLabel(macState, mac!.device?.platform)).toBe("Needs macOS permission");
  });

  it("says an away iPhone is available while Opensteer is open on it", () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    const lastSeenAt = "2026-10-26T11:00:00.000Z";
    expect(computerStatus({ ...iphone!, lastSeenAt, status: "offline" }, now)).toEqual({
      label: `Offline · Available while Opensteer is open on ${iphoneName}`,
      tone: "offline",
    });
    expect(computerStatus({ ...mac!, lastSeenAt, status: "offline" }, now)).toEqual({
      label: "Offline · seen 1h",
      tone: "offline",
    });
  });

  it("sends a phone reader to the iPhone itself, never to a computer's folders", () => {
    expect(computerUsesChosenElsewhere(iphone!)).toBe(
      `Choose which apps agents can use on ${iphoneName} in Opensteer on that iPhone.`,
    );
    expect(computerUsesChosenElsewhere(mac!)).toBe(
      "Choose which apps, folders and commands agents can use on Alex's MacBook Pro in Opensteer on a computer.",
    );
  });
});

describe("an app whose platforms this client does not know", () => {
  it("is not mistaken for an Android-phone app", () => {
    expect(futureApp?.computerApp?.platforms).toEqual([]);
    expect(computerAppRunsOnPhone(futureApp?.computerApp)).toBe(false);
    expect(computerAppPlatformRequirementLabel(futureApp!)).toBe("Requires a supported computer");
    expect(
      computerAppElsewhereDetail({
        integrationName: "Future app",
        presentation: futureApp?.computerApp,
      }),
    ).toBe(
      "Open Opensteer on a supported computer and turn Future app on for it, then return here to allow access.",
    );
    expect(computerAppRunsOnPhone(androidApp?.computerApp)).toBe(true);
  });
});

function machine(input: {
  readonly apps?: readonly object[];
  readonly device: object;
  readonly id: string;
  readonly name: string;
}) {
  return {
    access: null,
    allowedModules: ["integrations"],
    apps: input.apps ?? null,
    detail: null,
    device: input.device,
    enrollmentId: null,
    expiresAt: null,
    id: input.id,
    lastSeenAt: null,
    localWorkspaces: 0,
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: input.name,
    ownership: "mine",
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    unlinkedLocalFolders: 0,
  };
}

function definition(
  identity: { readonly id: string; readonly name: string },
  platforms: readonly string[],
) {
  return {
    adapter: "computer",
    apiKey: null,
    authMethods: [{ id: "computer", kind: "computer", label: "This computer" }],
    computerApp: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessLevels: ["read", "read-write"],
      accessSummaries: {
        read: `Allows reading ${identity.name}.`,
        readWrite: `Allows reading and changing ${identity.name}.`,
      },
      operations: [
        { effect: "read", name: "list_calendars" },
        { effect: "read", name: "list_events" },
        { effect: "write", name: "create_event" },
      ],
      platforms,
    },
    description: `${identity.name} through an enrolled computer.`,
    id: identity.id,
    name: identity.name,
    provider: identity.id,
  };
}

function catalogEntry(summary: ReturnType<typeof definition>) {
  return { definition: summary, digest: "a".repeat(43), installationId: null };
}
