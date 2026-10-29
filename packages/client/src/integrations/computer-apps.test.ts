import type {
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
} from "@opensteer/integration-core";
import type { MachineSummary } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  computerAppConnectionLabel,
  computerAppPermissionNotice,
  computerAppPlatformName,
  computerAppPlatformRequirementLabel,
  computerAppPlatformTargetLabel,
  computerAppRows,
  computerAppStateLabel,
  computerAppTargets,
  computerConnectionState,
  computerOfflineLabel,
  iphoneAppStatus,
  ownsComputerApps,
} from "./computer-apps.js";

const macMini = "rnr_11111111-1111-4111-8111-111111111111";
const macBook = "rnr_33333333-3333-4333-8333-333333333333";

it("shows an iPhone provider's first-prompt guidance instead of directing it to Settings", () => {
  const detail = "iPhone hasn't asked yet. Turn on Location from Opensteer on this iPhone.";
  expect(
    iphoneAppStatus({
      machineName: "Alex's iPhone",
      request: null,
      row: {
        access: "read",
        presentation: messages().computerApp!,
        state: { kind: "permission-required", remedy: null, detail },
      },
    }).text,
  ).toBe(`Blocked · Read only · ${detail}`);
});

describe("computerAppRows", () => {
  it("offers an app that is off only while the computer reports it", () => {
    expect(
      computerAppRows({
        connections: [],
        definitions: [messages()],
        machine: machine({ apps: [appStatus()] }),
      }).map(({ access, state }) => [access, state.kind]),
    ).toEqual([[null, "off"]]);
    expect(
      computerAppRows({
        connections: [],
        definitions: [messages()],
        machine: machine({ apps: null, status: "offline" }),
      }),
    ).toEqual([]);
  });

  it("keeps a connected app while its computer is away", () => {
    const [row] = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({ apps: null, status: "offline" }),
    });
    expect(row).toMatchObject({ access: "read", state: { kind: "offline" } });
    expect(computerOfflineLabel("Mac mini")).toBe("Mac mini is offline");
  });

  it("never reads another computer's connection", () => {
    const rows = computerAppRows({
      connections: [connection("read-write", macBook)],
      definitions: [messages()],
      machine: machine({ apps: [appStatus()], id: macMini }),
    });
    expect(rows.map(({ access }) => access)).toEqual([null]);
  });

  it("carries permission detail and supplies an app-only fallback", () => {
    const [reported] = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({
        apps: [
          {
            definitionId: "apple-messages",
            operations: [
              {
                operation: "list_conversations",
                detail: "Messages needs Full access.",
                remedy: "full-disk-access",
                state: "permission-required",
              },
              {
                operation: "read_messages",
                detail: "Messages needs Full access.",
                remedy: "full-disk-access",
                state: "permission-required",
              },
              {
                operation: "send_message",
                detail: "Messages needs Full access.",
                remedy: "full-disk-access",
                state: "permission-required",
              },
            ],
          },
        ],
      }),
    });
    const [fallback] = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({
        apps: [
          {
            definitionId: "apple-messages",
            operations: [
              {
                operation: "list_conversations",
                detail: null,
                remedy: "full-disk-access",
                state: "permission-required",
              },
              {
                operation: "read_messages",
                detail: null,
                remedy: "full-disk-access",
                state: "permission-required",
              },
              {
                operation: "send_message",
                detail: null,
                remedy: "full-disk-access",
                state: "permission-required",
              },
            ],
          },
        ],
      }),
    });
    const [unknownPermissionFallback] = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({
        apps: [
          {
            definitionId: "apple-messages",
            operations: [
              {
                operation: "list_conversations",
                detail: null,
                remedy: null,
                state: "permission-required",
              },
              {
                operation: "read_messages",
                detail: null,
                remedy: null,
                state: "permission-required",
              },
              {
                operation: "send_message",
                detail: null,
                remedy: null,
                state: "permission-required",
              },
            ],
          },
        ],
      }),
    });
    expect(reported?.state).toEqual({
      detail: "Messages needs Full access.",
      kind: "permission-required",
      remedy: "full-disk-access",
    });
    expect(fallback?.state).toEqual({
      detail: "Protected data access for Messages needs permission.",
      kind: "permission-required",
      remedy: "full-disk-access",
    });
    expect(unknownPermissionFallback?.state).toEqual({
      detail: "Messages needs permission.",
      kind: "permission-required",
      remedy: null,
    });
  });

  it("distinguishes an attached computer awaiting status from an unavailable app", () => {
    const [checking] = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({
        apps: null,
        modules: {
          integrations: { checkedAt: null, detail: null, readiness: "ready" },
        },
      }),
    });
    const [unavailable] = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({
        apps: [
          {
            definitionId: "apple-messages",
            operations: [
              {
                operation: "list_conversations",
                detail: "Messages is not set up.",
                remedy: null,
                state: "unavailable",
              },
              {
                operation: "read_messages",
                detail: "Messages is not set up.",
                remedy: null,
                state: "unavailable",
              },
              {
                operation: "send_message",
                detail: "Messages is not set up.",
                remedy: null,
                state: "unavailable",
              },
            ],
          },
        ],
      }),
    });
    expect(checking?.state).toEqual({ kind: "checking" });
    expect(unavailable?.state).toEqual({
      detail: "Messages is not set up.",
      kind: "unavailable",
    });
  });

  it("calls a missing provider unavailable once the machine disproves initial checking", () => {
    const withoutModule = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({ apps: null }),
    });
    const afterAnotherAppReports = computerAppRows({
      connections: [connection("read")],
      definitions: [messages()],
      machine: machine({
        apps: [{ ...appStatus(), definitionId: "apple-notes" }],
        modules: {
          integrations: { checkedAt: null, detail: null, readiness: "ready" },
        },
      }),
    });

    expect(withoutModule[0]?.state).toEqual({
      detail: "Messages is not available.",
      kind: "unavailable",
    });
    expect(afterAnotherAppReports[0]?.state).toEqual({
      detail: "Messages is not available.",
      kind: "unavailable",
    });
  });

  it("ignores unknown reports and ordinary account connections", () => {
    expect(
      computerAppRows({
        connections: [{ ...connection("read"), computer: null, definitionId: "github" }],
        definitions: [messages()],
        machine: machine({ apps: [{ ...appStatus(), definitionId: "apple-notes" }] }),
      }),
    ).toEqual([]);
  });
});

describe("computer app labels", () => {
  it("explains Full Disk Access only from its explicit remedy", () => {
    expect(
      computerAppPermissionNotice({
        appName: "Apple Messages",
        machineName: "Mac mini",
        state: {
          detail: "The provider supplied another description.",
          kind: "permission-required",
          remedy: "full-disk-access",
        },
      }),
    ).toEqual({
      detail:
        "The provider supplied another description. Switching on Opensteer Computer Use in Full Disk Access lets it read Apple Messages on Mac mini for the agents you approve. It does not change the agent access selected for this app.",
      title: "Reading Apple Messages needs macOS Full Disk Access",
    });
    expect(
      computerAppPermissionNotice({
        appName: "Apple Messages",
        machineName: "Mac mini",
        state: {
          detail: "Full Disk Access is mentioned only in provider prose.",
          kind: "permission-required",
          remedy: null,
        },
      }),
    ).toBeNull();
    expect(
      computerAppPermissionNotice({
        appName: "Apple Messages",
        machineName: "Mac mini",
        state: { kind: "ready" },
      }),
    ).toBeNull();
  });
});

describe("computer app visibility", () => {
  it("requires effective ownership and positive app evidence", () => {
    expect(
      ownsComputerApps({
        connections: [],
        hostsDeployment: false,
        machine: machine({ apps: [appStatus()] }),
      }),
    ).toBe(true);
    expect(
      ownsComputerApps({
        connections: [connection("read")],
        hostsDeployment: false,
        machine: machine({ apps: null, status: "offline" }),
      }),
    ).toBe(true);
    expect(
      ownsComputerApps({ connections: [], hostsDeployment: false, machine: machine({ apps: [] }) }),
    ).toBe(false);
    expect(
      ownsComputerApps({
        connections: [],
        hostsDeployment: false,
        machine: machine({ apps: [appStatus()], ownership: "deployment" }),
      }),
    ).toBe(false);
    expect(
      ownsComputerApps({
        connections: [],
        hostsDeployment: true,
        machine: machine({ apps: [appStatus()], ownership: "deployment" }),
      }),
    ).toBe(true);
  });
});

describe("computer app targets", () => {
  it("offers only online computers reporting the exact app", () => {
    const targets = computerAppTargets({
      connections: [connection("read")],
      definition: messages(),
      machines: [
        machine({ apps: [appStatus()], id: macMini }),
        machine({ apps: [appStatus()], id: macBook, name: "Alex's MacBook Pro" }),
        machine({ apps: null, id: "rnr_offline", status: "offline" }),
        machine({ apps: [], id: "rnr_no-app" }),
      ],
    });
    expect(
      targets.map(({ connection: existing, machine: target }) => [target.id, existing !== null]),
    ).toEqual([
      [macMini, true],
      [macBook, false],
    ]);
  });

  it("projects existing connection state from the target machine", () => {
    expect(
      computerConnectionState({
        connection: connection("read"),
        definition: messages(),
        machines: [],
      }),
    ).toEqual({ kind: "offline" });
    expect(
      computerConnectionState({
        connection: connection("read"),
        definition: messages(),
        machines: [machine({ apps: [appStatus()] })],
      }),
    ).toEqual({ kind: "ready" });
  });
});

/*
 * An Android phone among computer apps fails when its whole-screen definition
 * becomes a generic on/off app row, when it is named "a Android phone", when
 * its connection is named as an app on itself, and when a permission it
 * reports sends the person to macOS settings it does not have.
 */
describe("an Android phone among computer apps", () => {
  const pixelId = "rnr_22222222-2222-4222-8222-222222222222";
  const pixel = machine({
    allowedModules: ["integrations"],
    apps: [
      {
        definitionId: "android-phone",
        operations: [
          {
            operation: "observe",
            detail: null,
            remedy: "accessibility",
            state: "permission-required",
          },
          { operation: "act", detail: null, remedy: "accessibility", state: "permission-required" },
          { operation: "release", detail: null, remedy: null, state: "ready" },
        ],
      },
    ],
    device: { form: "phone", platform: "android" },
    id: pixelId,
    name: "Pixel",
  });
  const screen = {
    ...connection("read-write", pixelId),
    computer: {
      access: "read-write",
      app: null,
      blockedAt: null,
      policyRevision: null,
      runnerId: pixelId,
    },
    definitionId: "android-phone",
    displayName: "Android phone on Pixel",
  } as unknown as IntegrationConnectionSummary;

  it("is not one of the generic app rows", () => {
    expect(
      computerAppRows({ connections: [screen], definitions: [display()], machine: pixel }),
    ).toEqual([]);
  });

  it("is named as a phone, with its article", () => {
    expect(computerAppPlatformName("android")).toBe("Android phone");
    expect(computerAppPlatformTargetLabel(["android"])).toBe("an Android phone");
    expect(computerAppPlatformTargetLabel(["darwin", "android"])).toBe("a Mac or an Android phone");
    expect(computerAppPlatformRequirementLabel(display())).toBe("Requires an Android phone");
  });

  it("names its connection by the phone, which is the whole of it", () => {
    expect(
      computerAppConnectionLabel({ connection: screen, definition: display(), machines: [pixel] }),
    ).toBe("Pixel");
    expect(
      computerAppConnectionLabel({ connection: screen, definition: display(), machines: [] }),
    ).toBe("Android phone on Pixel");
  });

  it("asks for the phone's own Accessibility setting, never a macOS one", () => {
    const state = computerConnectionState({
      connection: screen,
      definition: display(),
      machines: [pixel],
    });
    expect(state).toEqual({
      detail: "Turn on Opensteer Agent Phone in the phone’s Accessibility settings.",
      kind: "permission-required",
      remedy: null,
    });
    expect(computerAppStateLabel(state)).toBe(
      "Turn on Opensteer Agent Phone in the phone’s Accessibility settings.",
    );
    expect(
      computerAppPermissionNotice({ appName: "Android phone", machineName: "Pixel", state }),
    ).toBeNull();
  });
});

function display(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This phone" }],
    computerApp: {
      accessLabels: { read: "Can see", readWrite: "Can see and control" },
      accessLevels: ["read", "read-write"],
      accessSummaries: { read: "Sees the phone.", readWrite: "Sees and operates the phone." },
      kind: "display",
      operations: [
        { name: "observe", effect: "read" },
        { name: "act", effect: "write" },
        { name: "release", effect: "read" },
      ],
      platforms: ["android"],
    },
    description: "See and operate the whole screen of an Android phone dedicated to agents.",
    id: "android-phone",
    name: "Android phone",
    provider: "android-phone",
  } as unknown as IntegrationDefinitionSummary;
}

function messages(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessLevels: ["read", "read-write"],
      operations: [
        { name: "list_conversations", effect: "read" },
        { name: "read_messages", effect: "read" },
        { name: "send_message", effect: "write" },
      ],
      accessSummaries: {
        read: "Agents can search and read your conversations.",
        readWrite: "Agents can search and read your conversations, and send messages as you.",
      },
      platforms: ["darwin"],
    },
    description: "Search, read, and send Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Messages",
    provider: "apple-messages",
  } as unknown as IntegrationDefinitionSummary;
}

function appStatus(): NonNullable<MachineSummary["apps"]>[number] {
  return {
    definitionId: "apple-messages",
    operations: [
      { operation: "list_conversations", detail: null, remedy: null, state: "ready" },
      { operation: "read_messages", detail: null, remedy: null, state: "ready" },
      { operation: "send_message", detail: null, remedy: null, state: "ready" },
    ],
  };
}

function connection(
  access: "read" | "read-write",
  runnerId: string = macMini,
): IntegrationConnectionSummary {
  return {
    accountIdentifier: null,
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: { access, runnerId },
    connectionMethod: "computer",
    createdAt: "2026-09-02T10:20:00.000Z",
    definitionId: "apple-messages",
    displayName: "Mac mini",
    externalIdentityId: null,
    externalTenantId: null,
    grantedScopes: [],
    id: "con_00000000-0000-4000-8000-000000000009",
    provider: "apple-messages",
    providerApplicationId: null,
    status: "connected",
    statusDetail: null,
    updatedAt: "2026-09-02T10:20:00.000Z",
  } as unknown as IntegrationConnectionSummary;
}

function machine(overrides: Partial<MachineSummary> = {}): MachineSummary {
  return {
    access: null,
    allowedModules: ["integrations", "shell"],
    apps: null,
    detail: null,
    enrollmentId: null,
    expiresAt: null,
    fullDiskAccess: false,
    id: macMini,
    lastSeenAt: null,
    localWorkspaces: 0,
    modules: {},
    name: "Mac mini",
    ownership: "mine",
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    unlinkedLocalFolders: 0,
    ...overrides,
  } as MachineSummary;
}
