import { HarnessAuthenticationCoordinator } from "../identity/harness-authentication-coordinator.js";
import { RealtimeHub } from "@opensteer/orchestration";
import { ComputerAppHub } from "../computer-apps/computer-app-hub.js";
import { ResourceRevisions } from "../runtime/personal-resource-revisions.js";
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
    apps: {
      list: async () => [],
      onRevoked: () => () => undefined,
    } as unknown as HostServerDependencies["apps"],
    appOriginSigningKey: Buffer.alloc(32, 1),
    appRealOrigins: true,
    attachments: inert(),
    runFiles: inert(),
    runToolTokens: inert(),
    authenticator: inert(),
    browser: inert(),
    tabs: {
      bootstrap: async () => ({ tabs: [], layout: { revision: 0, items: [] }, complete: true }),
    } as unknown as HostServerDependencies["tabs"],
    toolActivity: inert(),
    browserSources: inert(),
    passwordSignIns: inert(),
    signBrowserSourceInvitation: inert(),
    deviceAccess: inert(),
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
    resourceRevisions: new ResourceRevisions(() => undefined),
    egress: inert(),
    execution: inert(),
    harnessAuthenticationCoordinator: new HarnessAuthenticationCoordinator({
      harnesses: { getHarnessInstance: async () => null },
      runners: {
        isAvailable: () => false,
        manageHarnessAuthentication: async () => {
          throw new Error("No Runner is connected in this fixture");
        },
      },
    }),
    integrations: {
      access: inert(),
      authAttempts: inert(),
      continuations: inert(),
      definitions: [],
      devices: {
        deviceConnections: async () => [],
        computerAppApprovals: {
          computerUsePolicy: async () => ({ appApproval: "ask", approvalKeyId: null }),
        },
      } as unknown as HostServerDependencies["integrations"]["devices"],
      listConnections: async () => [],
      localServers: inert(),
      localServerRegistry: inert(),
      skills: inert(),
    },
    // Not inert: every command that touches a computer tells the connected
    // clients to read the list again, so a hub with nothing on it would fail
    // tests that are about something else entirely.
    requestResponseVault: inert(),
    runnerAuthenticator: inert(),
    runners: inert(),
    shellControl: unroutedShellControlStream,
    store: inert(),
    triggers: {
      controlTokens: inert(),
      watchBrowserTokens: inert(),
      watchScripts: inert(),
      service: inert(),
    },
    ...overrides,
    agentTools: Object.assign(
      {
        options: {
          callers: {
            authenticate: async () => {
              throw new Error("Unexpected agent call");
            },
          },
        },
      },
      overrides.agentTools,
    ) as HostServerDependencies["agentTools"],
    realtime:
      overrides.realtime instanceof RealtimeHub
        ? overrides.realtime
        : (Object.assign(
            {
              observe: () => () => undefined,
              observeScopes: () => () => false,
              guardRead: () => ({ current: () => true, release: () => false }),
              broadcast: () => undefined,
              sendToUsers: () => undefined,
              publishConnectionsChanged: () => undefined,
              refreshObservedBrowserUsage: () => undefined,
            },
            overrides.realtime,
          ) as HostServerDependencies["realtime"]),
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
