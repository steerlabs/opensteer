import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { unroutedShellControlStream } from "../shell/shell-control-stream.test-support.js";
import type { HostServerDependencies } from "../server.js";

export type HostServerTestOverrides = {
  readonly [Key in keyof HostServerDependencies]?: HostServerDependencies[Key];
};

function inert<Value>(): Value {
  return {} as Value;
}

export function hostServerTestDependencies(
  overrides: HostServerTestOverrides = {},
): HostServerDependencies {
  return {
    attachments: inert(),
    agentControl: inert(),
    agentControlTokens: inert(),
    agentTools: inert(),
    authenticator: inert(),
    browser: inert(),
    browserTabs: inert(),
    browserSources: inert(),
    signBrowserSourceInvitation: inert(),
    machineFullDiskAccess: inert(),
    browserAttachPublicKeys: [],
    browserRelay: inert(),
    channels: {
      relay: inert(),
      service: inert(),
    },
    // Not inert: the machines projection asks it what every computer this
    // viewer manages is reporting, and an empty hub is the honest answer for a
    // test with no computer attached.
    computerApps: new ComputerAppHub({
      knownDefinitionIds: () => new Set(),
      onChanged: () => undefined,
    }),
    placeContext: {
      assertIncludable: async (input) => {
        const pages = input.parts.filter((part) => part.type === "browser-page");
        if (pages.length) await overrides.browser!.assertPagesUsable({ ...input, pages });
        if (input.parts.some((part) => part.type === "computer-app" || part.type === "phone"))
          throw new Error("This fixture needs a native place boundary");
      },
    },
    credentials: inert(),
    discovery: inert(),
    egress: inert(),
    files: inert(),
    harnessAuthenticationCoordinator: inert(),
    liveRuns: { threadFrames: () => [] },
    integrations: {
      authAttempts: inert(),
      continuations: inert(),
      dashboard: inert(),
      mcpOauth: inert(),
      platform: {
        computerAppApprovals: {
          computerUsePolicy: async () => ({ appApproval: "ask", approvalKeyId: null }),
        },
      } as unknown as HostServerDependencies["integrations"]["platform"],
      service: inert(),
      skills: inert(),
      tools: inert(),
    },
    // Not inert: every command that touches a computer tells the connected
    // clients to read the list again, so a hub with nothing on it would fail
    // tests that are about something else entirely.
    realtime: { broadcast: () => undefined } as unknown as HostServerDependencies["realtime"],
    requestResponseVault: inert(),
    runnerAuthenticator: inert(),
    runners: inert(),
    securityEffects: inert(),
    shellControl: unroutedShellControlStream,
    store: inert(),
    triggers: {
      controlTokens: inert(),
      service: inert(),
      watchBrowserTokens: inert(),
      watchPrograms: inert(),
    },
    workspaceDeletion: inert(),
    workspaces: inert(),
    ...overrides,
    commands:
      overrides.commands && typeof overrides.commands.withInputAdmission === "function"
        ? overrides.commands
        : (Object.assign(
            {
              withInputAdmission: async <T>(
                _owner: string,
                _key: string,
                operation: () => Promise<T>,
              ) => operation(),
            },
            overrides.commands,
          ) as HostServerDependencies["commands"]),
  };
}
