import { createId, type Workspace } from "@opensteer/core";
import {
  MachineSummarySchema,
  mintComputerUseSessionId,
  type ComputerUseSessionSummary,
  type MachineAppStatus,
  type MachineModuleSummary,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  projectMachines,
  type MachinePendingRunnerInput,
  type MachineRunnerInput,
} from "./machines.js";

const ready: MachineModuleSummary = { checkedAt: null, detail: null, readiness: "ready" };

function runner(overrides: Partial<MachineRunnerInput> = {}): MachineRunnerInput {
  return {
    deviceProfile: null,
    allowedModules: ["agents", "browser", "shell"],
    connected: true,
    device: null,
    enrollmentId: "ren_local",
    id: createId("runner"),
    kind: "local",
    lastSeenAt: new Date("2026-08-12T19:04:00.000Z"),
    modules: {
      agents: {
        environmentIds: [createId("environment")],
        harnessDrivers: [],
        localStorage: null,
        maxConcurrentRuns: 2,
        providerStateModes: ["isolated"],
        workspaceBackings: ["portablefs"],
        workspaceMounts: [],
      },
    },
    name: "Laptop",
    ownerKind: "user",
    ownerName: null,
    readiness: new Map([["agents", ready]]),
    revokedAt: null,
    runtimeVersion: "0.1.117",
    ...overrides,
  };
}

function agentsModule(): NonNullable<MachineRunnerInput["modules"]["agents"]> {
  const agents = runner().modules.agents;
  if (!agents) throw new Error("The test Runner advertises an agents module.");
  return agents;
}

describe("Machines projection", () => {
  it.each([undefined, true] as const)(
    "projects authenticated display encoder availability (%s)",
    (displayStream) => {
      const phone = runner({
        modules: {
          integrations: {
            platform: "android",
            protocolVersion: 4,
          },
        },
      });
      const [machine] = projectMachines({
        access: new Map(),
        apps: new Map([[phone.id, []]]),
        computerUseDisplayStreamSupported: new Map([[phone.id, displayStream === true]]),
        deploymentKind: "personal",
        localWorkspaces: [],
        pendingRunners: [],
        runners: [phone],
        threadsByEnvironment: new Map(),
      });
      expect(machine?.computerUse?.displayStreamSupported).toBe(displayStream === true);
    },
  );
  it("explains how to update a connected Mac with an incompatible approvals protocol", () => {
    const [machine] = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [],
      threadsByEnvironment: new Map(),
      runners: [
        runner({
          modules: { integrations: { computerAppApprovals: true, platform: "darwin" } },
          readiness: new Map([["integrations", ready]]),
        }),
      ],
    });
    expect(machine?.modules.integrations).toMatchObject({
      readiness: "unavailable",
      detail: expect.stringContaining("Update Opensteer"),
    });
  });

  it("projects full access for Macs and null for Linux, absent shell and pending machines", () => {
    const machines = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      threadsByEnvironment: new Map(),
      runners: [
        runner({
          modules: {
            shell: { platform: "darwin", hostPublicKey: "ssh-ed25519 AAAA", fullDiskAccess: false },
          },
        }),
        runner({
          modules: {
            shell: { platform: "darwin", hostPublicKey: "ssh-ed25519 AAAA", fullDiskAccess: true },
          },
        }),
        runner({ modules: { shell: { platform: "linux", hostPublicKey: "ssh-ed25519 AAAA" } } }),
        runner(),
      ],
      pendingRunners: [
        {
          deviceProfile: null,
          allowedModules: ["shell"],
          expiresAt: new Date(),
          id: "pending",
          name: "Pending Mac",
          ownerKind: "user",
        },
      ],
    });
    expect(machines.map((machine) => machine.fullDiskAccess)).toEqual([
      false,
      true,
      null,
      null,
      null,
    ]);
  });

  it("reports a module the computer offers but has not vouched for as unavailable", () => {
    const [machine] = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [],
      threadsByEnvironment: new Map(),
      runners: [
        runner({
          modules: {
            agents: runner().modules.agents,
            browser: { wireVersion: 2, runtimeId: "chromium" },
          },
          // The browser is advertised but has reported nothing: a person should
          // see that it exists and is not working, not that it was never there.
          readiness: new Map([["agents", ready]]),
        }),
      ],
    });

    expect(machine?.modules.browser).toEqual({
      checkedAt: null,
      detail: null,
      readiness: "unavailable",
    });
  });

  it("never shows a module as ready on a computer that is away", () => {
    const [machine] = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [],
      threadsByEnvironment: new Map(),
      runners: [runner({ connected: false, readiness: new Map([["agents", ready]]) })],
    });

    expect(machine?.status).toBe("offline");
    expect(machine?.modules.agents?.readiness).toBe("unavailable");
  });

  it("refuses to let a Personal Deployment retire the computer it runs on", () => {
    const machines = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "personal",
      localWorkspaces: [],
      pendingRunners: [],
      threadsByEnvironment: new Map(),
      runners: [runner({ kind: "main", ownerKind: "deployment" })],
    });

    expect(machines[0]).toMatchObject({
      detail: "Runs this deployment.",
      revocable: false,
    });
  });

  it("keeps a revoked computer out of the list entirely", () => {
    expect(
      projectMachines({
        apps: new Map(),
        access: new Map(),
        deploymentKind: "self-hosted",
        localWorkspaces: [],
        pendingRunners: [],
        threadsByEnvironment: new Map(),
        runners: [runner({ revokedAt: new Date() })],
      }),
    ).toEqual([]);
  });

  it("shows an unredeemed enrollment as the modules it will be allowed", () => {
    const pending: MachinePendingRunnerInput = {
      deviceProfile: null,
      allowedModules: ["agents", "browser"],
      expiresAt: new Date("2026-08-12T19:14:00.000Z"),
      id: "ren_pending",
      name: "New computer",
      ownerKind: "user",
    };

    const [machine] = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [pending],
      threadsByEnvironment: new Map(),
      runners: [],
    });

    expect(machine).toMatchObject({
      enrollmentId: "ren_pending",
      expiresAt: "2026-08-12T19:14:00.000Z",
      id: "ren_pending",
      revocable: false,
      status: "pending",
    });
    expect(Object.keys(machine?.modules ?? {})).toEqual(["agents", "browser"]);
  });

  it("exposes the grant on every row shape, whatever the computer advertises", () => {
    // The grant is what a computer may ever advertise, so it is not read off
    // the modules: a connected one advertising less than it was granted still
    // reports the whole grant, which is what the page's switches are about.
    const machines = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "personal",
      localWorkspaces: [],
      pendingRunners: [
        {
          deviceProfile: null,
          allowedModules: ["shell"],
          expiresAt: new Date("2026-08-12T19:14:00.000Z"),
          id: "ren_pending",
          name: "Reachable laptop",
          ownerKind: "user",
        },
      ],
      threadsByEnvironment: new Map(),
      runners: [
        runner({
          deviceProfile: null,
          allowedModules: ["agents", "browser", "shell"],
          id: createId("runner"),
          kind: "main",
          ownerKind: "deployment",
        }),
        runner({ allowedModules: ["shell"], connected: false, id: createId("runner") }),
      ],
    });

    expect(machines.map((machine) => [machine.status, machine.allowedModules])).toEqual([
      ["online", ["agents", "browser", "shell"]],
      ["offline", ["shell"]],
      ["pending", ["shell"]],
    ]);
  });

  it("counts what removing a computer would take away", () => {
    const environmentId = createId("environment");
    const otherEnvironmentId = createId("environment");
    const now = "2026-09-01T10:00:00.000Z";
    const localWorkspace = (ownerEnvironmentId: typeof environmentId): Workspace => ({
      backing: {
        bindingId: createId("workspaceBinding"),
        generation: 1,
        kind: "local-directory",
        ownerEnvironmentId,
        storageAuthorityId: createId("storageAuthority"),
      },
      capacityPolicy: { kind: "host-filesystem" },
      createdAt: now,
      createdBy: createId("user"),
      homeThreadId: null,
      icon: null,
      id: createId("workspace"),
      kind: "specialized",
      name: "Research",
      status: "ready",
      storageIssue: null,
      updatedAt: now,
    });

    const [machine] = projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [
        localWorkspace(environmentId),
        localWorkspace(environmentId),
        // Another computer's folder must not be counted against this one.
        localWorkspace(otherEnvironmentId),
      ],
      pendingRunners: [],
      threadsByEnvironment: new Map([
        [environmentId, 4],
        [otherEnvironmentId, 9],
      ]),
      runners: [
        runner({ modules: { agents: { ...agentsModule(), environmentIds: [environmentId] } } }),
      ],
    });

    expect(machine).toMatchObject({ localWorkspaces: 2, pinnedThreads: 4 });
  });

  it("shows the access section only to a viewer who manages that computer", () => {
    const managed = runner({ name: "Alex's Mac" });
    const someoneElses = runner({ name: "Build box" });
    const access = new Map([
      [
        managed.id,
        {
          activeSessions: [],
          ownerReachAvailable: true,
          policy: { commands: true, forwarding: false, reach: "owner" as const, shares: [] },
          revision: 7,
        },
      ],
    ]);

    const machines = projectMachines({
      access,
      apps: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [
        {
          deviceProfile: null,
          allowedModules: ["shell"],
          expiresAt: new Date(),
          id: "ren_pending",
          name: "New computer",
          ownerKind: "user",
        },
      ],
      threadsByEnvironment: new Map(),
      runners: [managed, someoneElses],
    });

    expect(machines.find((machine) => machine.id === managed.id)?.access).toEqual({
      activeSessions: [],
      ownerReachAvailable: true,
      policy: { commands: true, forwarding: false, reach: "owner", shares: [] },
      revision: 7,
    });
    // Reach is never disclosed beyond a person's own ability to connect, and a
    // computer that has not connected yet has no settings to show at all.
    expect(machines.find((machine) => machine.id === someoneElses.id)?.access).toBeNull();
    expect(machines.find((machine) => machine.status === "pending")?.access).toBeNull();
  });

  it("lists apps only for the computers whose apps this viewer may see", () => {
    const managed = runner({
      modules: { integrations: { platform: "darwin" } },
      name: "Alex's Mac",
    });
    const someoneElses = runner({
      modules: { integrations: { platform: "darwin" } },
      name: "Someone else's Mac",
    });
    const apps = [
      {
        definitionId: "apple-messages",
        operations: [
          { operation: "list_conversations", detail: null, remedy: null, state: "ready" as const },
          { operation: "read_messages", detail: null, remedy: null, state: "ready" as const },
          { operation: "send_message", detail: null, remedy: null, state: "ready" as const },
        ],
      },
    ];

    const machines = projectMachines({
      access: new Map(),
      // The caller populates this only for the computers it resolved as
      // managed, so an unmanaged one is absent exactly as it is from `access`.
      apps: new Map([[managed.id, apps]]),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [
        {
          deviceProfile: null,
          allowedModules: ["integrations", "shell"],
          expiresAt: new Date(),
          id: "ren_pending",
          name: "New computer",
          ownerKind: "user",
        },
      ],
      threadsByEnvironment: new Map(),
      runners: [managed, someoneElses],
    });

    expect(machines.find((machine) => machine.id === managed.id)?.apps).toEqual(apps);
    expect(machines.find((machine) => machine.id === someoneElses.id)?.apps).toBeNull();
    expect(machines.find((machine) => machine.id === "ren_pending")?.apps).toBeNull();
    expect(machines.find((machine) => machine.id === managed.id)?.modules.integrations).toEqual({
      checkedAt: null,
      detail: null,
      readiness: "unavailable",
    });
  });

  /*
   * A phone's row must say whether agents can use it and why not, in the
   * phone's own words, and never as a Mac missing its desktop app or its
   * macOS grants. It must carry its approval key and its whole-display session.
   */
  describe("computer use on a phone", () => {
    const phone = runner({
      device: { form: "phone", platform: "android" },
      modules: {
        integrations: { platform: "android", protocolVersion: 4 },
      },
    });

    function projectPhone(apps: readonly MachineAppStatus[] | null) {
      const session: ComputerUseSessionSummary = {
        actionCount: 2,
        actingAppKeys: [],
        apps: [],
        display: true,
        openedAt: "2026-10-11T10:00:00.000Z",
        runId: createId("run"),
        sessionId: mintComputerUseSessionId(),
        threadId: createId("thread"),
        threadTitle: "Text the driver",
      };
      const [machine] = projectMachines({
        access: new Map(),
        apps: apps === null ? new Map() : new Map([[phone.id, apps]]),
        computerUsePolicies: new Map([
          [phone.id, { appApproval: "ask", approvalKeyId: "sha256:phone" }],
        ]),
        computerUseSessions: new Map([[phone.id, [session]]]),
        deploymentKind: "self-hosted",
        localWorkspaces: [],
        pendingRunners: [],
        runners: [phone],
        threadsByEnvironment: new Map(),
      });
      return { computerUse: machine?.computerUse, session };
    }

    function phoneStatus(
      state: "ready" | "unavailable",
      detail: string | null = null,
    ): MachineAppStatus {
      return {
        definitionId: "android-phone",
        operations: ["observe", "act", "release"].map((operation) => ({
          detail,
          operation,
          remedy: null,
          state,
        })),
      };
    }

    it("carries the build its connection runs, which the phone's page offers to update", () => {
      const [machine] = projectMachines({
        access: new Map(),
        apps: new Map(),
        deploymentKind: "self-hosted",
        localWorkspaces: [],
        pendingRunners: [],
        runners: [phone, runner({ connected: false, runtimeVersion: null })],
        threadsByEnvironment: new Map(),
      });
      expect(machine?.runtimeVersion).toBe("0.1.117");
    });

    it("keeps Android update consent visible while the old phone app is connected", () => {
      const [machine] = projectMachines({
        access: new Map(),
        apps: new Map(),
        deploymentKind: "self-hosted",
        localWorkspaces: [],
        pendingRunners: [],
        runners: [{ ...phone, phoneUpdate: "awaiting-user" }],
        threadsByEnvironment: new Map(),
      });
      expect(machine?.status).toBe("update-pending");
      expect(machine?.detail).toBe(`Tap Update on ${phone.name}.`);
    });

    it("is ready without approval policy or key and carries its whole-display session", () => {
      const { computerUse, session } = projectPhone([phoneStatus("ready")]);
      expect(computerUse).toEqual({
        appApproval: null,
        approvalKeyId: null,

        displayStreamSupported: false,
        detail: null,
        permissions: null,
        sessions: [session],
        state: "ready",
      });
    });

    it("says it is paused in the phone's words", () => {
      expect(
        projectPhone([phoneStatus("unavailable", "Paused on the phone")]).computerUse,
      ).toMatchObject({ detail: "Paused on the phone", permissions: null, state: "unavailable" });
    });

    it("says the phone app is not running rather than that a Mac needs its desktop app", () => {
      expect(projectPhone(null).computerUse).toMatchObject({
        approvalKeyId: null,
        detail: "The Opensteer Agent Phone app is not running on this phone.",
        state: "unavailable",
      });
    });
  });

  describe("computer use", () => {
    const mac = runner({
      ownerKind: "deployment",
      modules: { integrations: { platform: "darwin" } },
    });

    function project(
      apps: readonly MachineAppStatus[] | null,
      session?: ComputerUseSessionSummary,
      appApproval?: "ask" | "automatic",
    ) {
      const [machine] = projectMachines({
        apps: apps === null ? new Map() : new Map([[mac.id, apps]]),
        access: new Map(),
        ...(session ? { computerUseSessions: new Map([[mac.id, [session]]]) } : {}),
        ...(appApproval
          ? {
              computerUsePolicies: new Map([
                [mac.id, { appApproval, approvalKeyId: "sha256:registered" }],
              ]),
            }
          : {}),
        deploymentKind: "personal",
        localWorkspaces: [],
        pendingRunners: [],
        threadsByEnvironment: new Map(),
        runners: [mac],
      });
      if (!machine) throw new Error("The projection returned no row.");
      return machine;
    }

    it("is null for a viewer this Host reports no apps to", () => {
      expect(project(null).computerUse).toBeNull();
    });

    it("keeps the owner's policy visible without a live app report", () => {
      expect(project(null, undefined, "automatic").computerUse).toEqual({
        displayStreamSupported: false,
        detail: "Computer use needs the Opensteer desktop app on this Mac.",
        permissions: null,
        sessions: [],
        appApproval: "automatic",
        approvalKeyId: "sha256:registered",
        state: "unavailable",
      });
    });

    it("says the desktop app is missing when the Mac reports no macos-app entry", () => {
      expect(project([]).computerUse).toEqual({
        displayStreamSupported: false,
        detail: "Computer use needs the Opensteer desktop app on this Mac.",
        permissions: null,
        sessions: [],
        appApproval: "ask",
        approvalKeyId: null,
        state: "unavailable",
      });
    });

    function macosApp(
      operations: readonly {
        readonly detail?: string | null;
        readonly operation: string;
        readonly remedy: MachineAppStatus["operations"][number]["remedy"];
        readonly state: MachineAppStatus["operations"][number]["state"];
      }[],
    ): MachineAppStatus {
      return {
        definitionId: "macos-app",
        operations: operations.map(({ detail, operation, remedy, state }) => ({
          detail: detail ?? null,
          operation,
          remedy,
          state,
        })),
      };
    }

    it.each([
      [
        "both granted",
        [
          { operation: "observe", remedy: null, state: "ready" as const },
          { operation: "act", remedy: null, state: "ready" as const },
        ],
        "ready" as const,
        { accessibility: "granted" as const, screenRecording: "granted" as const },
      ],
      [
        "only Screen Recording denied",
        [
          {
            operation: "observe",
            remedy: "screen-recording" as const,
            state: "permission-required" as const,
          },
          {
            operation: "act",
            remedy: "screen-recording" as const,
            state: "permission-required" as const,
          },
        ],
        "permission-required" as const,
        { accessibility: "granted" as const, screenRecording: "denied" as const },
      ],
      [
        "only Accessibility denied",
        [
          {
            operation: "observe",
            remedy: "accessibility" as const,
            state: "permission-required" as const,
          },
          {
            operation: "act",
            remedy: "accessibility" as const,
            state: "permission-required" as const,
          },
        ],
        "permission-required" as const,
        { accessibility: "denied" as const, screenRecording: "granted" as const },
      ],
      [
        // Each operation names the grant it is missing first, so both denied
        // shows up as two different remedies rather than one.
        "both denied",
        [
          {
            operation: "observe",
            remedy: "screen-recording" as const,
            state: "permission-required" as const,
          },
          {
            operation: "act",
            remedy: "accessibility" as const,
            state: "permission-required" as const,
          },
        ],
        "permission-required" as const,
        { accessibility: "denied" as const, screenRecording: "denied" as const },
      ],
    ])("reads %s from what the Mac reports", (_name, operations, state, permissions) => {
      const projected = project([macosApp(operations)]).computerUse;

      expect(projected).toMatchObject({ permissions, state });
    });

    it("says nothing about the grants when the helper is unavailable for another reason", () => {
      expect(
        project([
          macosApp([
            {
              detail: "Update Opensteer on this Mac.",
              operation: "observe",
              remedy: null,
              state: "unavailable",
            },
            { operation: "act", remedy: null, state: "unavailable" },
          ]),
        ]).computerUse,
      ).toEqual({
        displayStreamSupported: false,
        detail: "Update Opensteer on this Mac.",
        permissions: null,
        sessions: [],
        appApproval: "ask",
        approvalKeyId: null,
        state: "unavailable",
      });
    });

    it("derives the missing grant from the remedies on the operations", () => {
      expect(
        project([
          {
            definitionId: "macos-app",
            operations: [
              {
                detail: "Allow Screen Recording for Opensteer Computer Use",
                operation: "observe",
                remedy: "screen-recording",
                state: "permission-required",
              },
              {
                detail: "Allow Screen Recording for Opensteer Computer Use",
                operation: "act",
                remedy: "screen-recording",
                state: "permission-required",
              },
            ],
          },
        ]).computerUse,
      ).toEqual({
        displayStreamSupported: false,
        detail: "Allow Screen Recording for Opensteer Computer Use",
        permissions: { accessibility: "granted", screenRecording: "denied" },
        sessions: [],
        appApproval: "ask",
        approvalKeyId: null,
        state: "permission-required",
      });
    });

    it("marks both grants denied when both remedies are reported", () => {
      expect(
        project([
          {
            definitionId: "macos-app",
            operations: [
              {
                detail: null,
                operation: "observe",
                remedy: "screen-recording",
                state: "permission-required",
              },
              {
                detail: null,
                operation: "act",
                remedy: "accessibility",
                state: "permission-required",
              },
            ],
          },
        ]).computerUse?.permissions,
      ).toEqual({ accessibility: "denied", screenRecording: "denied" });
    });

    it("is ready with both grants and carries the live session", () => {
      const session: ComputerUseSessionSummary = {
        actionCount: 4,
        actingAppKeys: ["com.apple.notes"],
        apps: [{ bundleId: "com.apple.Notes", displayName: "Notes", teamId: null }],
        display: false,
        openedAt: "2026-09-21T10:00:00.000Z",
        runId: createId("run"),
        sessionId: mintComputerUseSessionId(),
        threadId: createId("thread"),
        threadTitle: "Tidy the notes",
      };
      const projected = project(
        [
          {
            definitionId: "macos-app",
            operations: [
              { detail: null, operation: "observe", remedy: null, state: "ready" },
              { detail: null, operation: "act", remedy: null, state: "ready" },
            ],
          },
        ],
        session,
      );

      expect(projected.computerUse).toEqual({
        displayStreamSupported: false,
        detail: null,
        permissions: { accessibility: "granted", screenRecording: "granted" },
        sessions: [session],
        appApproval: "ask",
        approvalKeyId: null,
        state: "ready",
      });
      expect(projected.ownership).toBe("deployment");
      expect(project(null, session).computerUse).toBeNull();
      expect(MachineSummarySchema.parse(projected)).toEqual(projected);
    });
  });

  it("emits rows the protocol schema accepts", () => {
    for (const machine of projectMachines({
      apps: new Map(),
      access: new Map(),
      deploymentKind: "self-hosted",
      localWorkspaces: [],
      pendingRunners: [
        {
          deviceProfile: null,
          allowedModules: ["messaging"],
          expiresAt: new Date(),
          id: "ren_pending",
          name: "Messaging service",
          ownerKind: "deployment",
        },
      ],
      threadsByEnvironment: new Map(),
      runners: [runner()],
    })) {
      expect(MachineSummarySchema.parse(machine)).toEqual(machine);
    }
  });
});
