// @vitest-environment happy-dom

import type { HostClient, WorkspaceSummary } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import type {
  ComputerAppPresentation,
  IntegrationAccess,
  IntegrationGrant,
} from "@opensteer/integration-core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerAppWorkspaceAccess,
  type ComputerAppWorkspaceAccessProps,
} from "./computer-app-workspace-access.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const connectionA = "con_00000000-0000-4000-8000-000000000001";
const connectionB = "con_00000000-0000-4000-8000-000000000002";
const installationId = "ins_00000000-0000-4000-8000-000000000001";
const supportId = "wsp_00000000-0000-4000-8000-000000000002";
const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe("ComputerAppWorkspaceAccess", () => {
  it("keeps a read grant read when the computer ceiling rises until it is explicitly upgraded", async () => {
    const host = fakeHost([grant({ access: "read", connectionId: connectionA })]);
    const mounted = await mount({ access: "read", hostClient: host.client });
    await open(mounted.container);

    expect(select(mounted.container, "Support workspace access").value).toBe("read");
    expect(optionLabels(select(mounted.container, "Support workspace access"))).toEqual([
      "Off",
      "Read only",
    ]);

    await mounted.render({ access: "read-write" });
    const support = select(mounted.container, "Support workspace access");
    expect(support.value).toBe("read");
    expect(optionLabels(support)).toEqual(["Off", "Read only", "Read and send"]);
    expect(host.dispatch).not.toHaveBeenCalled();

    await choose(support, "read-write");

    expect(host.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          access: "read-write",
          connectionId: connectionA,
          installationId,
          workspaceId: supportId,
        }),
        type: "integration.grant.create",
      }),
    );
    expect(select(mounted.container, "Support workspace access").value).toBe("read-write");
  });

  it("shows the effective read level when a stored write grant is limited by the computer", async () => {
    const host = fakeHost([grant({ access: "read-write", connectionId: connectionA })]);
    const mounted = await mount({ access: "read-write", hostClient: host.client });
    await open(mounted.container);

    expect(select(mounted.container, "Support workspace access").value).toBe("read-write");
    await mounted.render({ access: "read" });

    const support = select(mounted.container, "Support workspace access");
    expect(support.value).toBe("read");
    expect(optionLabels(support)).toEqual(["Off", "Read only"]);
    expect(mounted.container.textContent).toContain(
      "Read and send is allowed for this Workspace, but the app currently limits access to read only.",
    );
    expect(host.dispatch).not.toHaveBeenCalled();
  });

  it("reads and revokes only the grant for this computer connection", async () => {
    const own = grant({ access: "read", connectionId: connectionA, idSuffix: "1" });
    const anotherMac = grant({ access: "read-write", connectionId: connectionB, idSuffix: "2" });
    const host = fakeHost([own, anotherMac]);
    const mounted = await mount({ access: "read-write", hostClient: host.client });
    await open(mounted.container);

    expect(select(mounted.container, "Support workspace access").value).toBe("read");
    await choose(select(mounted.container, "Support workspace access"), "off");

    expect(host.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        grantId: own.id,
        type: "integration.grant.revoke",
        workspaceId: supportId,
      }),
    );
    expect(host.grants()).toEqual([anotherMac]);
    expect(select(mounted.container, "Support workspace access").value).toBe("off");
  });

  it("does not let an old Host load replace the current connection", async () => {
    const oldLoad = Promise.withResolvers<readonly IntegrationGrant[]>();
    const previous = fakeHost([], { load: async () => await oldLoad.promise });
    const current = fakeHost([grant({ access: "read-write", connectionId: connectionB })]);
    const mounted = await mount({ hostClient: previous.client });
    await open(mounted.container);

    await mounted.render({ connectionId: connectionB, hostClient: current.client });
    expect(select(mounted.container, "Support workspace access").value).toBe("read-write");

    await act(async () => oldLoad.resolve([grant({ access: "read", connectionId: connectionA })]));
    expect(select(mounted.container, "Support workspace access").value).toBe("read-write");
  });

  it("finishes a pending save after the disclosure is collapsed and reopened", async () => {
    const save = Promise.withResolvers<unknown>();
    const host = fakeHost([grant({ access: "read", connectionId: connectionA })], {
      dispatch: async () => await save.promise,
    });
    const mounted = await mount({ access: "read-write", hostClient: host.client });
    await open(mounted.container);
    await choose(select(mounted.container, "Support workspace access"), "read-write");

    expect(select(mounted.container, "Support workspace access").disabled).toBe(true);
    await click(button(mounted.container, "Workspace access"));
    await click(button(mounted.container, "Workspace access"));
    expect(select(mounted.container, "Support workspace access").disabled).toBe(true);

    await act(async () => save.resolve({ type: "integration.grant.create" }));
    expect(select(mounted.container, "Support workspace access").disabled).toBe(false);
    expect(select(mounted.container, "Support workspace access").value).toBe("read");
  });

  it("finishes a pending save and applies the current ceiling after it changes", async () => {
    const save = Promise.withResolvers<unknown>();
    const host = fakeHost([grant({ access: "read", connectionId: connectionA })], {
      dispatch: async () => await save.promise,
    });
    const mounted = await mount({ access: "read-write", hostClient: host.client });
    await open(mounted.container);
    await choose(select(mounted.container, "Support workspace access"), "read-write");

    await mounted.render({ access: "read" });
    expect(select(mounted.container, "Support workspace access").disabled).toBe(true);
    await act(async () => save.resolve({ type: "integration.grant.create" }));

    const support = select(mounted.container, "Support workspace access");
    expect(support.disabled).toBe(false);
    expect(support.value).toBe("read");
    expect(optionLabels(support)).toEqual(["Off", "Read only"]);
  });

  it("reloads persisted access after a mutation error and lets the load be retried", async () => {
    const host = fakeHost([grant({ access: "read", connectionId: connectionA })], {
      dispatch: async () => {
        throw new Error("The Host refused this grant.");
      },
    });
    const mounted = await mount({ access: "read-write", hostClient: host.client });
    await open(mounted.container);
    await choose(select(mounted.container, "Support workspace access"), "read-write");

    expect(select(mounted.container, "Support workspace access").value).toBe("read");
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "The Host refused this grant.",
    );

    host.list.mockRejectedValueOnce(new Error("Workspace grants are unavailable."));
    await click(button(mounted.container, "Retry"));
    expect(mounted.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Workspace grants are unavailable.",
    );
    await click(button(mounted.container, "Retry"));
    expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
    expect(select(mounted.container, "Support workspace access").value).toBe("read");
  });

  it("shows inherited Main access only when Main is in the visible workspace list", async () => {
    const host = fakeHost([]);
    const mounted = await mount({ hostClient: host.client, workspaces: [supportWorkspace] });
    await open(mounted.container);

    expect(mounted.container.textContent).not.toContain("Automatically uses");
    expect(mounted.container.querySelector('[aria-label="Main workspace access"]')).toBeNull();

    await mounted.render({ workspaces: [mainWorkspace, supportWorkspace] });
    const main = select(mounted.container, "Main workspace access");
    expect(main.disabled).toBe(true);
    expect(main.value).toBe("read-write");
    expect(mounted.container.textContent).toContain(
      "Automatically uses read and send from the app setting above.",
    );
  });
});

const presentation: ComputerAppPresentation = {
  accessLabels: { read: "Read only", readWrite: "Read and send" },
  accessLevels: ["read", "read-write"],
  accessSummaries: { read: "Can read.", readWrite: "Can read and send." },
  operations: [
    { effect: "read", name: "list_conversations" },
    { effect: "write", name: "send_message" },
  ],
  platforms: ["darwin"],
};

const mainWorkspace = workspace("wsp_00000000-0000-4000-8000-000000000001", "main", "Main");
const supportWorkspace = workspace(supportId, "specialized", "Support");

function workspace(id: string, kind: WorkspaceSummary["kind"], name: string): WorkspaceSummary {
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
    runnerLabel: "This Mac",
    status: "ready",
    storageIssue: null,
    color: "blue",
    updatedAt: "2026-09-19T00:00:00.000Z",
  };
}

function grant(input: {
  readonly access: IntegrationAccess;
  readonly connectionId: string;
  readonly idSuffix?: string;
}): IntegrationGrant {
  return {
    access: input.access,
    alias: "Messages on Mac mini",
    connectionId: input.connectionId,
    createdAt: "2026-09-19T00:00:00.000Z",
    id: `igr_00000000-0000-4000-8000-00000000000${input.idSuffix ?? "1"}`,
    installationId,
    isDefault: true,
    ownerUserId: "usr_00000000-0000-4000-8000-000000000001",
    revokedAt: null,
    status: "active",
    workspaceId: supportId,
  } as IntegrationGrant;
}

function fakeHost(
  initial: readonly IntegrationGrant[],
  options: {
    readonly dispatch?: (command: Record<string, unknown>) => Promise<unknown>;
    readonly load?: (workspaceId: string) => Promise<readonly IntegrationGrant[]>;
  } = {},
) {
  let persisted = [...initial];
  const list = vi.fn(async ({ workspaceId }: { readonly workspaceId: string }) => ({
    data: {
      grants: options.load
        ? await options.load(workspaceId)
        : persisted.filter((candidate) => candidate.workspaceId === workspaceId),
    },
    ok: true as const,
  }));
  const dispatch = vi.fn(async (command: Record<string, unknown>) => {
    if (options.dispatch) return await options.dispatch(command);
    if (command.type === "integration.grant.revoke") {
      persisted = persisted.filter(
        (candidate) =>
          candidate.workspaceId !== command.workspaceId || candidate.id !== command.grantId,
      );
      return { type: command.type };
    }
    if (command.type === "integration.grant.create") {
      const input = command.input as {
        readonly access: IntegrationAccess;
        readonly alias: string;
        readonly connectionId: string;
        readonly installationId: string;
        readonly isDefault: boolean;
        readonly workspaceId: string;
      };
      const existing = persisted.find(
        (candidate) =>
          candidate.workspaceId === input.workspaceId &&
          candidate.installationId === input.installationId &&
          candidate.connectionId === input.connectionId,
      );
      const saved: IntegrationGrant = existing
        ? { ...existing, access: input.access, alias: input.alias, isDefault: input.isDefault }
        : grant({ access: input.access, connectionId: input.connectionId });
      persisted = [...persisted.filter((candidate) => candidate.id !== saved.id), saved];
      return { grant: saved, type: command.type };
    }
    throw new Error("Unexpected command.");
  });
  const client: HostClient = new MockHostClient({ latencyMs: 0 });
  Object.defineProperty(client, "dispatch", { configurable: true, value: dispatch });
  Object.defineProperty(client.rpc, "integration.grants.list", {
    configurable: true,
    value: list,
  });
  return { client, dispatch, grants: () => persisted, list };
}

type RenderInput = Pick<
  ComputerAppWorkspaceAccessProps,
  "access" | "connectionId" | "hostClient" | "workspaces"
>;

async function mount(input: Partial<RenderInput> & Pick<RenderInput, "hostClient">) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  let current: RenderInput = {
    access: input.access ?? "read-write",
    connectionId: input.connectionId ?? connectionA,
    hostClient: input.hostClient,
    workspaces: input.workspaces ?? [mainWorkspace, supportWorkspace],
  };

  async function render(changes: Partial<RenderInput> = {}): Promise<void> {
    current = { ...current, ...changes };
    await act(async () => {
      root.render(
        <ComputerAppWorkspaceAccess
          access={current.access}
          appName="Messages"
          connectionId={current.connectionId}
          hostClient={current.hostClient}
          installationId={installationId}
          machineName="Mac mini"
          presentation={presentation}
          workspaces={current.workspaces}
        />,
      );
    });
  }

  await render();
  return { container, render };
}

async function open(container: HTMLElement): Promise<void> {
  await click(button(container, "Workspace access"));
}

function select(container: HTMLElement, label: string): HTMLSelectElement {
  const found = container.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  if (!found) throw new Error(`Missing select: ${label}`);
  return found;
}

function optionLabels(element: HTMLSelectElement): string[] {
  return [...element.options].map((option) => option.textContent ?? "");
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => element.click());
}

async function choose(element: HTMLSelectElement, value: WorkspaceAccessLevel): Promise<void> {
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

type WorkspaceAccessLevel = "off" | IntegrationAccess;
