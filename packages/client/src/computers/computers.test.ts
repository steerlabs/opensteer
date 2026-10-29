import type { MachineSummary } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computerGlyph,
  computerRole,
  computersOverview,
  computerStatus,
  computerUses,
  computerUsesPhrase,
  isServiceMachine,
  type ComputerAppsData,
} from "./computers.js";

afterEach(() => {
  vi.useRealTimers();
});

const macId = "rnr_11111111-1111-4111-8111-111111111111";

function machine(overrides: Partial<MachineSummary> = {}): MachineSummary {
  return {
    access: null,
    allowedModules: ["integrations", "shell"],
    apps: null,
    computerUse: null,
    detail: null,
    device: null,
    enrollmentId: "ren_fixture",
    expiresAt: null,
    fullDiskAccess: null,
    id: macId,
    lastSeenAt: null,
    localWorkspaces: 0,
    modules: {},
    name: "Mac",
    ownerName: null,
    ownership: "mine",
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    runtimeVersion: null,
    unlinkedLocalFolders: 0,
    ...overrides,
  };
}

/** One folder open to the owner's agents. */
function reachable(commands = false): NonNullable<MachineSummary["access"]> {
  return {
    activeSessions: [],
    ownerReachAvailable: true,
    policy: {
      commands,
      forwarding: false,
      reach: "owner",
      shares: [{ mode: "read", path: "/Users/person/Projects" }],
    },
    revision: 1,
  };
}

describe("isServiceMachine", () => {
  it("is a machine the Deployment owns that runs no agents, whatever its grant", () => {
    const defaults = ["integrations", "messaging", "shell"] as const;
    const deployment = { ownership: "deployment" } as const;
    expect(isServiceMachine(machine({ allowedModules: [...defaults], ...deployment }))).toBe(true);
    expect(
      isServiceMachine(
        machine({ allowedModules: ["browser", "integrations", "shell"], ...deployment }),
      ),
    ).toBe(true);
    // Every computer a person adds carries messaging, for the conversations its
    // own apps can carry; it is still that person's computer.
    expect(isServiceMachine(machine({ allowedModules: [...defaults] }))).toBe(false);
    expect(isServiceMachine(machine({ allowedModules: [...defaults], ownership: "other" }))).toBe(
      false,
    );
    // The Mac a Personal Opensteer runs on belongs to the Deployment and runs its agents.
    expect(
      isServiceMachine(
        machine({ allowedModules: ["agents", "browser", "integrations", "shell"], ...deployment }),
      ),
    ).toBe(false);
  });
});

describe("computersOverview", () => {
  const home = machine({
    allowedModules: ["agents", "browser", "integrations", "shell"],
    id: "rnr_home",
    name: "Mac mini",
    ownership: "deployment",
  });
  const service = machine({
    allowedModules: ["integrations", "messaging", "shell"],
    id: "rnr_slack",
    ownership: "deployment",
  });

  it("puts the Mac a Personal Opensteer runs on at the top, never among the others", () => {
    const overview = computersOverview({
      cloud: false,
      deploymentKind: "personal",
      deploymentName: "Mac mini",
      hereId: null,
      machines: [machine({ id: "rnr_laptop" }), home, service],
      publicOrigin: null,
    });

    expect(overview.home).toEqual({ kind: "mac", machine: home, name: "Mac mini" });
    expect(overview.groups.map(({ id, machines }) => [id, machines.map(({ id: m }) => m)])).toEqual(
      [["others", ["rnr_laptop"]]],
    );
    expect(overview.services).toEqual([service]);
  });

  it("names a Personal Opensteer whose Mac has not connected by the Opensteer's name", () => {
    expect(
      computersOverview({
        cloud: false,
        deploymentKind: "personal",
        deploymentName: "Studio",
        hereId: null,
        machines: [],
        publicOrigin: null,
      }).home,
    ).toEqual({ kind: "mac", machine: null, name: "Studio" });
  });

  it("groups a server's computers by whose they are, and says where it runs", () => {
    const shared = machine({
      allowedModules: ["agents", "shell"],
      id: "rnr_shared",
      ownership: "deployment",
    });
    const theirs = machine({ id: "rnr_theirs", ownerName: "Sam", ownership: "other" });
    const overview = computersOverview({
      cloud: false,
      deploymentKind: "server",
      deploymentName: "Acme",
      hereId: null,
      machines: [theirs, machine({ id: "rnr_mine" }), shared, service],
      publicOrigin: "https://acme.example.com",
    });

    expect(overview.home).toEqual({ address: "acme.example.com", kind: "server" });
    expect(overview.addTo).toBe("yours");
    expect(overview.groups.map(({ id, machines }) => [id, machines.map(({ id: m }) => m)])).toEqual(
      [
        ["shared", ["rnr_shared"]],
        ["yours", ["rnr_mine"]],
        ["teammates", ["rnr_theirs"]],
      ],
    );
    expect(
      computersOverview({
        cloud: true,
        deploymentKind: "server",
        deploymentName: "Acme",
        hereId: null,
        machines: [],
        publicOrigin: "https://acme.opensteer.cloud",
      }).home,
    ).toEqual({ kind: "cloud" });
  });
});

describe("what agents can use on a computer", () => {
  const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "APPLECOMP1" };
  const safari = { bundleId: "com.apple.Safari", displayName: "Safari", teamId: "APPLECOMP1" };
  const definitions = [
    {
      computerApp: {
        accessLabels: { read: "Read only", readWrite: "Read and send" },
        accessLevels: ["read", "read-write"],
        accessSummaries: { read: "Reads.", readWrite: "Reads and sends." },
        operations: [{ effect: "read", name: "list_conversations" }],
        platforms: ["darwin"],
      },
      id: "apple-messages",
      name: "Apple Messages",
    },
    {
      computerApp: {
        accessLabels: { read: "Can see", readWrite: "Can see and control" },
        accessLevels: ["read", "read-write"],
        accessSummaries: { read: "Sees.", readWrite: "Sees and controls." },
        kind: "gui",
        operations: [{ effect: "read", name: "observe" }],
        platforms: ["darwin"],
      },
      id: "macos-app",
      name: "Computer use",
    },
  ] as unknown as ComputerAppsData["definitions"];
  const connection = (
    id: string,
    definitionId: string,
    app: typeof notes | null,
    blockedAt: string | null = null,
  ) =>
    ({
      computer: { access: "read", app, blockedAt, policyRevision: null, runnerId: macId },
      definitionId,
      id,
      status: blockedAt ? "paused" : "connected",
    }) as unknown as ComputerAppsData["connections"][number];
  const apps: ComputerAppsData = {
    connections: [
      connection("con_1", "apple-messages", null),
      connection("con_2", "macos-app", notes),
      connection("con_3", "macos-app", safari, "2026-09-21T00:00:00.000Z"),
    ],
    definitions,
  };

  it("names apps that are on, apps agents may operate but not blocked ones, then folders and commands", () => {
    const uses = computerUses(machine({ access: reachable(true) }), apps);

    expect(uses).toEqual([
      { definitionId: "apple-messages", kind: "app", name: "Apple Messages" },
      { kind: "screen-app", name: "Notes" },
      { count: 1, kind: "folders" },
      { kind: "commands" },
    ]);
    expect(computerUsesPhrase(uses)).toBe("Apple Messages, Notes and 2 more");
    expect(computerUsesPhrase(uses.slice(1))).toBe("Notes, 1 folder and commands");
  });

  it("counts folders only while other computers may reach it", () => {
    const closed = reachable();
    expect(
      computerUses(
        machine({ access: { ...closed, policy: { ...closed.policy, reach: "nobody" } } }),
        null,
      ),
    ).toEqual([]);
  });

  it("says what a computer does for agents, and nothing it cannot know", () => {
    expect(computerRole(machine({ status: "pending" }), [], true)).toBe("waiting");
    expect(
      computerRole(
        machine({ modules: { agents: { checkedAt: null, detail: null, readiness: "ready" } } }),
        [],
        true,
      ),
    ).toBe("works");
    expect(computerRole(machine(), [{ kind: "commands" }], true)).toBe("uses");
    expect(computerRole(machine(), [], true)).toBe("idle");
    // Its apps have not loaded: saying "nothing shared" would be a guess.
    expect(computerRole(machine(), [], false)).toBeNull();
    // A teammate's sharing is theirs, and nobody else is told it.
    expect(computerRole(machine({ ownership: "other" }), [], true)).toBeNull();
  });
});

/*
 * A phone in the list fails when it is drawn as a plain computer, when the
 * screen it lends reads as "Nothing shared yet", or when a phone that has
 * lent nothing claims to be used.
 */
describe("an Android phone in the list", () => {
  const pixelId = "rnr_22222222-2222-4222-8222-222222222222";
  const pixel = machine({
    allowedModules: ["integrations"],
    device: { form: "phone", platform: "android" },
    id: pixelId,
    name: "Pixel",
  });
  const display = {
    computerApp: {
      accessLabels: { read: "Can see", readWrite: "Can see and control" },
      accessLevels: ["read", "read-write"],
      accessSummaries: { read: "Sees.", readWrite: "Sees and operates." },
      kind: "display",
      operations: [{ effect: "read", name: "observe" }],
      platforms: ["android"],
    },
    id: "android-phone",
    name: "Android phone",
  } as unknown as ComputerAppsData["definitions"][number];
  const screen = (status: "connected" | "revoked") =>
    ({
      computer: {
        access: "read-write",
        app: null,
        blockedAt: null,
        policyRevision: null,
        runnerId: pixelId,
      },
      definitionId: "android-phone",
      id: "con_phone",
      status,
    }) as unknown as ComputerAppsData["connections"][number];

  it("is drawn as a phone", () => {
    expect(computerGlyph(pixel)).toBe("phone");
  });

  it("lends agents its screen once access is approved, and nothing before", () => {
    const uses = computerUses(pixel, {
      connections: [screen("connected")],
      definitions: [display],
    });
    expect(uses).toEqual([{ kind: "screen" }]);
    expect(computerUsesPhrase(uses)).toBe("its screen");
    expect(computerRole(pixel, uses, true)).toBe("uses");

    const none = computerUses(pixel, { connections: [screen("revoked")], definitions: [display] });
    expect(none).toEqual([]);
    expect(computerRole(pixel, none, true)).toBe("idle");
  });
});

describe("computerStatus", () => {
  it("counts down a pending computer's code, and dates an absent one", () => {
    const now = new Date("2026-09-13T12:00:00.000Z");

    expect(
      computerStatus(machine({ expiresAt: "2026-09-13T12:07:00.000Z", status: "pending" }), now),
    ).toEqual({
      label: "Code expires in 7 min",
      tone: "waiting",
    });
    expect(
      computerStatus(machine({ expiresAt: "2026-09-13T11:59:00.000Z", status: "pending" }), now)
        .label,
    ).toBe("Code expired");
    expect(
      computerStatus(machine({ lastSeenAt: "2026-09-13T09:00:00.000Z", status: "offline" }), now),
    ).toEqual({
      label: "Offline · seen 3h",
      tone: "offline",
    });
    expect(computerStatus(machine(), now)).toEqual({ label: "Online", tone: "online" });
  });
});
