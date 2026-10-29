// @vitest-environment happy-dom

import type { HostClient, WorkspaceSummary } from "@opensteer/client/host";
import type {
  ComputerAppSetupRequest,
  IntegrationConnectionSummary,
  IntegrationDefinitionSummary,
  IntegrationPlatformDashboard,
} from "@opensteer/integration-core";
import { RunnerIdSchema } from "@opensteer/core";
import type { HostApiCommandInput, MachineSummary } from "@opensteer/protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerAppsSection,
  type ComputerAppLocalApproval,
  type ComputerAppRequestInput,
} from "./computer-apps-section.js";

const macMini = "rnr_11111111-1111-4111-8111-111111111111";
const mainWorkspace = "wsp_00000000-0000-4000-8000-000000000001";
const homeProjects = "wsp_00000000-0000-4000-8000-000000000002";
const mountedRoots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("ComputerAppsSection", () => {
  it("requests wider access remotely instead of dispatching a set command", async () => {
    const dispatch = dispatcher(async () => ({ type: "integration.computer.setup.set" }));
    const onRequestSetup = vi.fn(async (_input: ComputerAppRequestInput) => undefined);
    const { container } = await mount({
      connections: [connection("read")],
      dispatch,
      machine: machine({ apps: [ready()] }),
      onRequestSetup,
    });

    await click(button(container, "Manage"));
    await click(button(container, "Request sending access"));

    expect(onRequestSetup).toHaveBeenCalledWith({
      access: "read-write",
      appName: "Messages",
      definitionId: "apple-messages",
      runnerId: macMini,
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("allows an owner to reduce access remotely", async () => {
    const dispatch = dispatcher(async () => ({ type: "integration.computer.setup.set" }));
    const { container } = await mount({
      connections: [connection("read-write")],
      dispatch,
      machine: machine({ apps: [ready()] }),
    });

    await click(button(container, "Manage"));
    await click(button(container, "Use read only"));

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          access: "read",
          app: null,
          definitionId: "apple-messages",
          kind: "app",
          runnerId: macMini,
        },
        type: "integration.computer.setup.set",
      }),
    );
  });

  it("turns access off only after stating the consequence", async () => {
    const dispatch = dispatcher(async () => ({ type: "integration.disconnect" }));
    const { container } = await mount({
      connections: [connection("read")],
      dispatch,
      machine: machine({ apps: [ready()] }),
    });

    await click(button(container, "Manage"));
    await click(button(container, "Turn off Messages"));
    expect(container.textContent).toContain("removes agents' access in every Workspace");
    expect(dispatch).not.toHaveBeenCalled();

    await click(button(container, "Turn off"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: connection("read").id,
        type: "integration.disconnect",
      }),
    );
  });

  it("shows and cancels a durable remote setup request", async () => {
    const onCancelSetupRequest = vi.fn(async (_request: ComputerAppSetupRequest) => undefined);
    const request = setupRequest("read-write");
    const { container } = await mount({
      connections: [connection("read")],
      machine: machine({ apps: [ready()] }),
      onCancelSetupRequest,
      setupRequests: [request],
    });

    expect(rowStatus(container)).toBe("Can read · Sending setup requested");
    expect(container.textContent).toContain("Open Opensteer on Mac mini to continue.");
    expect(button(container, "Manage access")).not.toBeNull();
    await click(button(container, "Cancel request"));
    expect(onCancelSetupRequest).toHaveBeenCalledWith(request);
  });

  // Failure: elsewhere, an app with access whose macOS grant is missing offers
  // an access request, which re-approves the same access and grants nothing.
  // Failure: elsewhere, that row does not say which grant is missing or where
  // it is given, so nobody knows what is left to do.
  // Failure: the same happens when reading works and only sending is missing.
  // Failure: an app that is off loses the request that turns it on elsewhere.
  it("says where a missing macOS grant is given instead of asking for access again", async () => {
    const onRequestSetup = vi.fn(async (_input: ComputerAppRequestInput) => undefined);
    const { container } = await mount({
      connections: [connection("read")],
      machine: machine({ apps: [readPermissionRequired()] }),
      onRequestSetup,
    });

    expect(rowStatus(container)).toBe("Setup unfinished");
    expect(buttonTexts(container)).not.toContain("Send setup request");
    expect(rowNote(container)).toBe(
      "Messages needs Full Disk Access. Complete setup on Mac mini. In the Opensteer desktop app there, open Settings → Computers → Mac mini.",
    );
    expect(button(container, "Manage")).not.toBeNull();
    expect(onRequestSetup).not.toHaveBeenCalled();
  });

  it("says where sending is set up when reading already works", async () => {
    const { container } = await mount({
      connections: [connection("read-write")],
      machine: machine({ apps: [sendPermissionRequired()] }),
      onRequestSetup: async () => undefined,
    });

    expect(rowStatus(container)).toBe("Can read · Sending needs setup");
    expect(buttonTexts(container)).not.toContain("Send setup request");
    expect(rowNote(container)).toBe(
      "Messages needs Automation permission. Complete setup on Mac mini. In the Opensteer desktop app there, open Settings → Computers → Mac mini.",
    );
  });

  it("asks the Mac to turn an app on from elsewhere", async () => {
    const onRequestSetup = vi.fn(async (_input: ComputerAppRequestInput) => undefined);
    const { container } = await mount({
      connections: [],
      machine: machine({ apps: [readPermissionRequired()] }),
      onRequestSetup,
    });

    expect(rowStatus(container)).toBe("Off");
    expect(rowNote(container)).toBeNull();
    await click(button(container, "Send setup request"));
    expect(onRequestSetup).toHaveBeenCalledWith({
      access: "read",
      appName: "Messages",
      definitionId: "apple-messages",
      runnerId: macMini,
    });
  });

  it("keeps an incoming request visible on its target while the Mac is offline", async () => {
    const { container } = await mount({
      connections: [],
      localApproval: localApproval(),
      machine: machine({ apps: null, status: "offline" }),
      setupRequests: [setupRequest("read")],
    });

    expect(rowStatus(container)).toBe("Off · Setup requested");
    expect(button(container, "Review request").disabled).toBe(true);
  });

  it("reviews a request through target-computer approval", async () => {
    const approveAccess = vi.fn(async () => true);
    const request = setupRequest("read-write");
    const { container } = await mount({
      connections: [connection("read")],
      localApproval: localApproval({ approveAccess }),
      machine: machine({ apps: [ready()] }),
      setupRequests: [request],
    });

    await click(button(container, "Review request"));
    expect(labelledInput(container, "Read and send").checked).toBe(true);
    await click(button(container, "Allow and continue"));

    expect(approveAccess).toHaveBeenCalledWith({
      access: "read-write",
      definitionId: "apple-messages",
      request,
      runnerId: macMini,
    });
  });

  it("requires approval for a pending request at the current access and permits retry", async () => {
    const approveAccess = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const request = setupRequest("read-write");
    const { container } = await mount({
      connections: [connection("read-write")],
      localApproval: localApproval({ approveAccess }),
      machine: machine({ apps: [ready()] }),
      setupRequests: [request],
    });

    await click(button(container, "Finish setup"));
    expect(container.textContent).not.toContain("is ready");
    await click(button(container, "Allow and continue"));
    expect(button(container, "Allow and continue")).not.toBeNull();
    await click(button(container, "Allow and continue"));
    expect(approveAccess).toHaveBeenCalledTimes(2);
    expect(approveAccess).toHaveBeenLastCalledWith({
      access: "read-write",
      definitionId: "apple-messages",
      request,
      runnerId: macMini,
    });
  });

  it.each(["read", "read-write"] as const)(
    "still reviews a %s request after the page is reopened",
    async (access) => {
      const approveAccess = vi.fn(async () => true);
      const request = setupRequest(access);
      const { container } = await mount({
        connections: [connection(access)],
        localApproval: localApproval({ approveAccess }),
        machine: machine({ apps: [ready()] }),
        setupRequests: [request],
      });

      await click(button(container, "Finish setup"));
      await click(button(container, "Allow and continue"));
      expect(approveAccess).toHaveBeenCalledWith(
        expect.objectContaining({ access, request, runnerId: macMini }),
      );
    },
  );

  it("shows a setup blocker when a pending request has no live readiness", async () => {
    const { container } = await mount({
      connections: [connection("read")],
      localApproval: localApproval(),
      machine: machine({ apps: [] }),
      setupRequests: [setupRequest("read")],
    });

    await click(button(container, "Finish setup"));
    await click(button(container, "Allow and continue"));
    expect(container.textContent).toContain("Checking setup…");
    expect(container.textContent).not.toContain("is ready");
  });

  it("shows sending permission after approving a same-access request with ready reading", async () => {
    const { container } = await mount({
      connections: [connection("read-write")],
      localApproval: localApproval(),
      machine: machine({ apps: [sendPermissionRequired()] }),
      setupRequests: [setupRequest("read-write")],
    });

    await click(button(container, "Finish setup"));
    await click(button(container, "Allow and continue"));
    expect(container.textContent).toContain("Allow Messages on this Mac");
    expect(container.textContent).not.toContain("is ready");
  });

  it("shows unavailable setup without claiming the app is ready", async () => {
    const unavailable = appStatus({
      detail: "Messages is unavailable.",
      operation: "list_conversations",
      remedy: null,
      state: "unavailable",
    });
    const { container } = await mount({
      connections: [connection("read")],
      localApproval: localApproval(),
      machine: machine({ apps: [unavailable] }),
      setupRequests: [setupRequest("read")],
    });

    await click(button(container, "Finish setup"));
    await click(button(container, "Allow and continue"));
    expect(container.textContent).toContain("Setup is unavailable");
    expect(container.textContent).not.toContain("is ready");
  });

  it("ignores a setup request addressed to another computer", async () => {
    const otherRequest = {
      ...setupRequest("read-write"),
      runnerId: "rnr_22222222-2222-4222-8222-222222222222",
    } as ComputerAppSetupRequest;
    const { container } = await mount({
      connections: [connection("read")],
      localApproval: localApproval(),
      machine: machine({ apps: [ready()] }),
      setupRequests: [otherRequest],
    });

    expect(rowStatus(container)).toBe("Read only");
    expect(button(container, "Manage")).not.toBeNull();
  });

  it("requires fresh approval when a pending request is replaced while setup is open", async () => {
    const request = setupRequest("read");
    const input: MountInput = {
      connections: [connection("read")],
      localApproval: localApproval(),
      machine: machine({ apps: [ready()] }),
      setupRequests: [request],
    };
    const { container, render } = await mount(input);
    await click(button(container, "Finish setup"));
    await click(button(container, "Allow and continue"));
    expect(container.textContent).toContain("is ready");

    await render({
      ...input,
      setupRequests: [{ ...request, id: "00000000-0000-4000-8000-000000000005" }],
    });
    expect(button(container, "Allow and continue")).not.toBeNull();
    expect(container.textContent).not.toContain("is ready");
  });

  it.each(["read", null] as const)(
    "requires fresh approval after current access changes to %s",
    async (access) => {
      const request = setupRequest("read-write");
      const input: MountInput = {
        connections: [connection("read-write")],
        localApproval: localApproval(),
        machine: machine({ apps: [ready()] }),
        setupRequests: [request],
      };
      const { container, render } = await mount(input);
      await click(button(container, "Finish setup"));
      await click(button(container, "Allow and continue"));
      expect(container.textContent).toContain("is ready");

      await render({ ...input, connections: access ? [connection(access)] : [] });
      expect(button(container, "Allow and continue")).not.toBeNull();
      expect(container.textContent).not.toContain("is ready");
    },
  );

  it("keeps a failed approval available for retry", async () => {
    const approveAccess = vi.fn().mockRejectedValueOnce(new Error("Approval failed"));
    const { container } = await mount({
      connections: [connection("read")],
      localApproval: localApproval({ approveAccess }),
      machine: machine({ apps: [ready()] }),
      setupRequests: [setupRequest("read")],
    });

    await click(button(container, "Finish setup"));
    await click(button(container, "Allow and continue"));
    expect(container.textContent).toContain("Approval failed");
    expect(button(container, "Allow and continue").disabled).toBe(false);
  });

  it("opens this Mac's setup at the reading step, disclosing what Full Disk Access opens", async () => {
    const reviewPermission = vi.fn(async () => undefined);
    const { container } = await mount({
      connections: [connection("read")],
      localApproval: localApproval({ reviewPermission }),
      machine: machine({ apps: [readPermissionRequired()] }),
    });

    expect(rowStatus(container)).toBe("Setup unfinished");
    await click(button(container, "Finish setup"));
    expect(container.textContent).toContain("Allow Messages on this Mac");
    // Full Disk Access is the helper's, and it opens more than Messages.
    expect(button(container, "Set up").title).toBe(
      "Turns on Full Disk Access for Opensteer Computer Use, which opens protected files on Mac mini and reads only Messages for the agents you approve.",
    );
    await click(button(container, "Set up"));
    expect(reviewPermission).toHaveBeenCalledWith({
      access: "read",
      definitionId: "apple-messages",
      remedy: "full-disk-access",
    });
  });

  it("moves from ready reading to the Automation permission step for sending", async () => {
    const reviewPermission = vi.fn(async () => undefined);
    const { container } = await mount({
      connections: [connection("read-write")],
      localApproval: localApproval({ reviewPermission }),
      machine: machine({ apps: [sendPermissionRequired()] }),
    });

    expect(rowStatus(container)).toBe("Can read · Sending needs setup");
    await click(button(container, "Finish setup"));
    expect(container.textContent).toContain("Allow Messages on this Mac");
    await click(button(container, "Set up"));
    expect(reviewPermission).toHaveBeenCalledWith({
      access: "read-write",
      definitionId: "apple-messages",
      remedy: "automation",
    });
  });

  it("asks macOS for an app's own grant at the Contacts permission step", async () => {
    const reviewPermission = vi.fn(async () => undefined);
    const { container } = await mount({
      connections: [{ ...connection("read"), definitionId: "apple-contacts" }],
      definition: contacts(),
      localApproval: localApproval({ reviewPermission }),
      machine: machine({
        apps: [
          {
            definitionId: "apple-contacts",
            operations: [
              {
                detail: "Reading Contacts needs macOS access to Contacts.",
                operation: "search_contacts",
                remedy: "contacts",
                state: "permission-required",
              },
            ],
          },
        ],
      }),
    });

    expect(rowStatus(container)).toBe("Setup unfinished");
    await click(button(container, "Finish setup"));
    expect(container.textContent).toContain("Allow Contacts on this Mac");
    await click(button(container, "Set up"));
    expect(reviewPermission).toHaveBeenCalledWith({
      access: "read",
      definitionId: "apple-contacts",
      remedy: "contacts",
    });
  });

  it("allows offline revocation while blocking local increases", async () => {
    const dispatch = dispatcher(async () => ({ type: "integration.disconnect" }));
    const { container } = await mount({
      connections: [connection("read")],
      dispatch,
      localApproval: localApproval(),
      machine: machine({ apps: null, status: "offline" }),
    });

    expect(rowStatus(container)).toBe("Unavailable · Mac mini offline");
    await click(button(container, "Manage"));
    expect(button(container, "Request sending access").disabled).toBe(true);
    await click(button(container, "Turn off Messages"));
    expect(container.textContent).toContain("applies the revocation when it reconnects");
  });

  it("does not reveal another owner's app block", async () => {
    const { container } = await mount({
      connections: [connection("read-write")],
      machine: machine({ apps: [ready()], ownership: "other" }),
      owned: false,
    });

    expect(container.querySelector(".computers-section")).toBeNull();
  });
});

/*
 * An iPhone's apps, read from another device. The iPhone itself turns its apps
 * on and answers every request for new or wider access, so this page must not:
 * - direct anyone to macOS, the desktop app or Opensteer Computer Use;
 * - offer to turn an app on, or to widen it, from here;
 * - call its pending request "Waiting for Mac", or its away state "Mac offline";
 * - show a macOS permissions panel for a phone that has none;
 * - hide the access an app has behind a request for more, read as on while
 *   the iPhone is away, or lose Manage (lower, turn off) while a request waits.
 * Lowering access and turning an app off stay here, as on a Mac.
 */
describe("ComputerAppsSection on an iPhone seen from another device", () => {
  it("sends a missing iPhone Settings access to the iPhone, not to macOS", async () => {
    const detail = "Calendar needs full access for Opensteer in iPhone Settings.";
    const { container } = await mount({
      connections: [iphoneConnection("read")],
      definition: calendar(),
      machine: iphone({
        apps: [
          iphoneCalendarStatus({
            detail,
            operation: "list_events",
            remedy: "calendars",
            state: "permission-required",
          }),
        ],
      }),
    });

    expect(container.textContent).toContain(
      `${detail} Allow it in iPhone Settings on Alex's iPhone. It does not change the agent access selected for this app.`,
    );
    expect(container.textContent).not.toContain("desktop app");
    expect(container.textContent).not.toContain("macOS");
  });

  it("offers lowering and turning off, never widening or macOS permissions", async () => {
    const dispatch = dispatcher(async () => ({ type: "integration.computer.setup.set" }));
    const { container } = await mount({
      connections: [iphoneConnection("read-write")],
      definition: calendar(),
      dispatch,
      machine: iphone({ apps: [iphoneCalendarReady()] }),
    });

    expect(rowStatus(container)).toBe("On · Can read and change");
    await click(button(container, "Manage"));
    expect(container.textContent).not.toContain("macOS");
    expect(buttonTexts(container).some((text) => text.startsWith("Request"))).toBe(false);
    await click(button(container, "Use can read"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ access: "read", runnerId: iphoneId }),
        type: "integration.computer.setup.set",
      }),
    );

    const off = await mount({
      connections: [iphoneConnection("read")],
      definition: calendar(),
      machine: iphone({ apps: [iphoneCalendarReady()] }),
    });
    await click(button(off.container, "Manage"));
    expect(buttonTexts(off.container).some((text) => text.startsWith("Allow"))).toBe(false);
    expect(buttonTexts(off.container).some((text) => text.startsWith("Request"))).toBe(false);
    expect(buttonTexts(off.container)).toContain("Turn off Calendar");
  });

  it("says an app that is off is turned on on the iPhone itself", async () => {
    const onRequestSetup = vi.fn(async (_input: ComputerAppRequestInput) => undefined);
    const { container } = await mount({
      connections: [],
      definition: calendar(),
      machine: iphone({ apps: [iphoneCalendarReady()] }),
      onRequestSetup,
    });

    expect(rowStatus(container)).toBe("Off · Turn it on in Opensteer on Alex's iPhone");
    expect(buttonTexts(container).some((text) => text.includes("setup request"))).toBe(false);
    expect(onRequestSetup).not.toHaveBeenCalled();
  });

  it("waits for the iPhone's answer to a request, and can decline it", async () => {
    const onCancelSetupRequest = vi.fn(async (_request: ComputerAppSetupRequest) => undefined);
    const request = { ...setupRequest("read"), definitionId: "apple-calendar", runnerId: iphoneId };
    const { container } = await mount({
      connections: [],
      definition: calendar(),
      machine: iphone({ apps: [iphoneCalendarReady()], status: "offline" }),
      onCancelSetupRequest,
      setupRequests: [request],
    });

    expect(rowStatus(container)).toBe("Off · Waiting for approval on Alex's iPhone");
    expect(container.textContent).not.toContain("Mac");
    await click(button(container, "Decline"));
    expect(onCancelSetupRequest).toHaveBeenCalledWith(request);
  });

  it("keeps the current access, and Manage, while a wider request waits on an away iPhone", async () => {
    const request = {
      ...setupRequest("read-write"),
      definitionId: "apple-calendar",
      runnerId: iphoneId,
    };
    const { container } = await mount({
      connections: [iphoneConnection("read")],
      definition: calendar(),
      machine: iphone({ apps: [iphoneCalendarReady()], status: "offline" }),
      setupRequests: [request],
    });

    expect(rowStatus(container)).toBe(
      "Paused · Can read · Alex's iPhone is offline · More access waiting for approval",
    );
    expect(buttonTexts(container)).toEqual(expect.arrayContaining(["Decline", "Manage"]));
    await click(button(container, "Manage"));
    expect(buttonTexts(container)).toContain("Turn off Calendar");
  });
});

const iphoneId = RunnerIdSchema.parse("rnr_22222222-2222-4222-8222-222222222222");

/** An iPhone as a newer Host lists it: apps only, no shell and no Mac grants. */
function iphone(overrides: Partial<MachineSummary> = {}): MachineSummary {
  return machine({
    allowedModules: ["integrations"],
    device: { form: "phone", platform: "ios" },
    fullDiskAccess: null,
    id: iphoneId,
    name: "Alex's iPhone",
    ...overrides,
  });
}

function calendar(): IntegrationDefinitionSummary {
  return {
    ...messages(),
    computerApp: {
      accessLabels: { read: "Can read", readWrite: "Can read and change" },
      accessLevels: ["read", "read-write"],
      accessSummaries: {
        read: "Allows reading calendars and events.",
        readWrite: "Allows reading calendars and events, and changing events.",
      },
      operations: [
        { effect: "read", name: "list_events" },
        { effect: "write", name: "create_event" },
      ],
      platforms: ["darwin"],
    },
    description: "Read and change Calendar.",
    id: "apple-calendar",
    name: "Calendar",
    provider: "apple-calendar",
  } as unknown as IntegrationDefinitionSummary;
}

function iphoneCalendarStatus(
  ...operations: NonNullable<MachineSummary["apps"]>[number]["operations"]
): NonNullable<MachineSummary["apps"]>[number] {
  return { definitionId: "apple-calendar", operations };
}

function iphoneCalendarReady(): NonNullable<MachineSummary["apps"]>[number] {
  return iphoneCalendarStatus(readyOperation("list_events"), readyOperation("create_event"));
}

function iphoneConnection(access: "read" | "read-write"): IntegrationConnectionSummary {
  const base = connection(access);
  return {
    ...base,
    computer: { ...base.computer!, runnerId: iphoneId },
    definitionId: "apple-calendar",
    displayName: "Alex's iPhone",
    provider: "apple-calendar",
  };
}

interface MountInput {
  readonly connections: readonly IntegrationConnectionSummary[];
  /** The one app the section lists; Messages unless a test names another. */
  readonly definition?: IntegrationDefinitionSummary;
  readonly dispatch?: HostClient["dispatch"];
  readonly localApproval?: ComputerAppLocalApproval | null;
  readonly machine: MachineSummary;
  readonly onCancelSetupRequest?: (request: ComputerAppSetupRequest) => Promise<void>;
  readonly onRequestSetup?: (input: ComputerAppRequestInput) => Promise<void>;
  readonly owned?: boolean;
  readonly setupRequests?: readonly ComputerAppSetupRequest[];
}

async function mount(input: MountInput) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const hostClient = {
    dispatch: input.dispatch ?? (async () => ({ type: "integration.computer.setup.set" })),
    rpc: {
      "integration.grants.list": async () => ({ data: { grants: [] }, ok: true }),
    },
  } as unknown as HostClient;

  const render = async (next: MountInput) =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <ComputerAppsSection
            connections={next.connections}
            definitions={[next.definition ?? messages()]}
            hostClient={hostClient}
            hostConnected
            localApproval={next.localApproval ?? null}
            machine={next.machine}
            onCancelSetupRequest={next.onCancelSetupRequest ?? null}
            onChanged={async () => undefined}
            onRequestSetup={next.onRequestSetup ?? null}
            owned={next.owned ?? true}
            platform={platform()}
            setupRequests={next.setupRequests ?? []}
            workspaces={[
              workspace(mainWorkspace, "main", "Main"),
              workspace(homeProjects, "specialized", "Home projects"),
            ]}
          />
        </MemoryRouter>,
      );
    });
  await render(input);
  return { container, render };
}

function localApproval(
  overrides: Partial<ComputerAppLocalApproval> = {},
): ComputerAppLocalApproval {
  return {
    approveAccess: async () => true,
    reviewPermission: async () => undefined,
    ...overrides,
  };
}

function platform(): IntegrationPlatformDashboard {
  return {
    authorizationSurface: "canonical",
    catalog: [],
    connections: [],
    installations: [],
  } as unknown as IntegrationPlatformDashboard;
}

function messages(): IntegrationDefinitionSummary {
  return {
    adapter: "computer",
    authMethods: [{ id: "computer", kind: "computer", label: "This Mac" }],
    computerApp: {
      accessLabels: { read: "Read only", readWrite: "Read and send" },
      accessLevels: ["read", "read-write"],
      accessSummaries: {
        read: "Agents can read Messages.",
        readWrite: "Agents can read Messages and send messages as you.",
      },
      operations: [
        { effect: "read", name: "list_conversations" },
        { effect: "write", name: "send_message" },
      ],
      platforms: ["darwin"],
    },
    description: "Messages through an enrolled Mac.",
    id: "apple-messages",
    name: "Messages",
    provider: "apple-messages",
  } as unknown as IntegrationDefinitionSummary;
}

/** An app the Mac's helper serves, which reads only and needs one grant. */
function contacts(): IntegrationDefinitionSummary {
  return {
    ...messages(),
    computerApp: {
      accessLabels: { read: "Can read", readWrite: "Can read" },
      accessLevels: ["read"],
      accessSummaries: {
        read: "Allows finding and reading contacts.",
        readWrite: "Allows finding and reading contacts.",
      },
      operations: [{ effect: "read", name: "search_contacts" }],
      platforms: ["darwin"],
    },
    description: "Find and read Contacts through an enrolled Mac.",
    id: "apple-contacts",
    name: "Contacts",
    provider: "apple-contacts",
  } as unknown as IntegrationDefinitionSummary;
}

function ready(): NonNullable<MachineSummary["apps"]>[number] {
  return appStatus(readyOperation(), readyOperation("send_message"));
}

function readPermissionRequired(): NonNullable<MachineSummary["apps"]>[number] {
  return appStatus({
    detail: "Messages needs Full Disk Access.",
    operation: "list_conversations",
    remedy: "full-disk-access",
    state: "permission-required",
  });
}

function sendPermissionRequired(): NonNullable<MachineSummary["apps"]>[number] {
  return appStatus(readyOperation(), {
    detail: "Messages needs Automation permission.",
    operation: "send_message",
    remedy: "automation",
    state: "permission-required",
  });
}

function appStatus(
  ...operations: NonNullable<MachineSummary["apps"]>[number]["operations"]
): NonNullable<MachineSummary["apps"]>[number] {
  return { definitionId: "apple-messages", operations };
}

function readyOperation(operation = "list_conversations") {
  return { detail: null, operation, remedy: null, state: "ready" as const };
}

function connection(access: "read" | "read-write"): IntegrationConnectionSummary {
  return {
    accountIdentifier: null,
    applicationSource: null,
    authMethodId: "computer",
    authorizationDigest: null,
    computer: { access, app: null, blockedAt: null, policyRevision: null, runnerId: macMini },
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

function setupRequest(access: "read" | "read-write"): ComputerAppSetupRequest {
  return {
    access,
    createdAt: "2026-09-19T00:00:00.000Z",
    definitionDigest: "d".repeat(43),
    definitionId: "apple-messages",
    deploymentId: "dep_00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-09-20T00:00:00.000Z",
    id: "00000000-0000-4000-8000-000000000004",
    ownerUserId: "usr_00000000-0000-4000-8000-000000000001",
    runnerId: macMini,
  } as ComputerAppSetupRequest;
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
    modules: { integrations: { checkedAt: null, detail: null, readiness: "ready" } },
    name: "Mac mini",
    ownership: "mine",
    pinnedThreads: 0,
    revocable: true,
    status: "online",
    unlinkedLocalFolders: 0,
    ...overrides,
  } as MachineSummary;
}

function workspace(id: string, kind: "main" | "specialized", name: string): WorkspaceSummary {
  return {
    description: "",
    fileCount: 0,
    homeThreadId: null,
    harnessLabel: "Codex",
    icon: null,
    id,
    kind,
    machineName: null,
    name,
    runnerLabel: "Mac mini",
    status: "ready",
    storageIssue: null,
    color: "blue",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function dispatcher(
  handler: (command: HostApiCommandInput) => Promise<unknown>,
): HostClient["dispatch"] {
  return vi.fn(handler) as unknown as HostClient["dispatch"];
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    (candidate.textContent ?? "").startsWith(label),
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

function buttonTexts(container: HTMLElement): readonly string[] {
  return [...container.querySelectorAll("button")].map((candidate) => candidate.textContent ?? "");
}

/** What the row says under its line, or null when it says nothing more. */
function rowNote(container: HTMLElement): string | null {
  return container.querySelector(".computer-apps__row-note > span")?.textContent ?? null;
}

function labelledInput(container: HTMLElement, label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")]
    .find((candidate) => candidate.textContent?.startsWith(label))
    ?.querySelector("input");
  if (!(found instanceof HTMLInputElement)) throw new Error(`Missing input: ${label}`);
  return found;
}

function rowStatus(container: HTMLElement): string {
  return (
    container.querySelector(".computer-apps__status--line > span:last-child")?.textContent ?? ""
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}
