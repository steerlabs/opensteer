import { ModelPolicyEntrySchema } from "@opensteer/core";
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mutationIdempotencyKey,
  unwrapRpcResult,
  type HostClient,
  type HostSnapshot,
} from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import {
  BrowserProfileIdSchema,
  WorkspaceIdSchema,
  type SpecialistManifest,
} from "@opensteer/core";
import { rpcSuccess } from "@opensteer/protocol";
import { native } from "../../test-support/settings-screens.js";

// What a person could find broken: a specialist's choice that does not bind,
// missing access with no way to allow it, a removal or deletion with no
// confirmation, a plugin switch a member can move, or changes offered while
// Opensteer cannot be reached.

const harness = vi.hoisted(() => ({ client: null as HostClient | null }));
vi.mock(
  "react-native",
  async () => (await import("../../test-support/settings-screens.js")).reactNative,
);
vi.mock(
  "@react-navigation/native",
  async () => (await import("../../test-support/settings-screens.js")).navigation,
);
vi.mock(
  "../ui/primitives.js",
  async () => (await import("../../test-support/settings-screens.js")).primitives,
);
vi.mock(
  "../ui/choice-menu.js",
  async () => (await import("../../test-support/settings-screens.js")).choiceMenu,
);
vi.mock(
  "../ui/screen.js",
  async () => (await import("../../test-support/settings-screens.js")).screen,
);
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/workspace-mark.js", () => ({ WorkspaceMark: () => null }));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => harness.client,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

const { ProjectSettingsScreen } = await import("./project-settings.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const researcher: SpecialistManifest = {
  version: 1,
  models: [ModelPolicyEntrySchema.parse({ engine: "claude", model: "opus" })],
  fallback: "caller",
  access: [
    { type: "browser-profile", level: "read", reason: "Reads the sites you research in" },
    { type: "integration", service: "github", level: "read", reason: "Files what it finds" },
  ],
};

const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.client = null;
  native.reset();
});

/** Every section's read has answered: nothing on screen is still loading. */
async function answered(container: HTMLElement): Promise<void> {
  await vi.waitFor(
    () =>
      expect(
        container.querySelector('[role="progressbar"]'),
        "a section never finished reading",
      ).toBeNull(),
    { timeout: 2_000 },
  );
}

/**
 * A Project with two allowed browser profiles and the researcher specialist,
 * seen by its owner unless told otherwise.
 */
async function open(
  options: {
    readonly rebind?: boolean;
    readonly restoreAccess?: boolean;
    readonly member?: boolean;
    readonly offline?: boolean;
    readonly storageIssue?: NonNullable<HostSnapshot["workspaces"][number]["storageIssue"]>;
  } = {},
) {
  const host = new MockHostClient({
    automations: "absent",
    latencyMs: 0,
    specialistPlugins: [
      {
        id: "plg_researcher",
        name: "researcher",
        manifest: options.rebind
          ? { ...researcher, access: researcher.access!.slice(0, 1) }
          : researcher,
      },
    ],
  });
  clients.push(host);
  await host.load();
  const project = host.getSnapshot().workspaces.find(({ kind }) => kind === "project")!;
  const workspaceId = WorkspaceIdSchema.parse(project.id);
  for (const name of ["Work", "Personal"]) {
    const created = await host.dispatch({
      idempotencyKey: mutationIdempotencyKey("profile"),
      input: { name },
      type: "browser.profile.create",
    });
    if (created.type !== "browser.profile.create") throw new Error("Profile not created");
    await host.dispatch({
      idempotencyKey: mutationIdempotencyKey("grant"),
      profileId: BrowserProfileIdSchema.parse(created.profile.id),
      type: "browser.profile.grant",
      workspaceId,
    });
  }
  await host.dispatch({
    idempotencyKey: mutationIdempotencyKey("specialist"),
    pluginId: "plg_researcher",
    type: "specialist.add",
    workspaceId,
  });

  if (options.rebind) {
    const result = await host.rpc["specialist.list"]({ workspaceId });
    if (!result.ok) throw new Error("Specialists unavailable");
    const specialist = result.data.specialists[0]!;
    await host.dispatch({
      type: "specialist.bind",
      workspaceId,
      specialistId: specialist.id,
      requirement: 0,
      resourceId: specialist.access[0]!.candidates[0]!.resourceId,
      idempotencyKey: mutationIdempotencyKey("bind"),
    });
    for (const grant of host
      .getSnapshot()
      .browserProfileGrants.filter((g) => g.workspaceId === workspaceId)) {
      await host.dispatch({
        type: "browser.profileGrant.revoke",
        grantId: grant.id,
        idempotencyKey: mutationIdempotencyKey("revoke"),
      });
    }
    const revoked = await host.rpc["specialist.list"]({ workspaceId });
    expect(revoked).toMatchObject({
      data: { specialists: [{ access: [{ state: "rebind", candidates: [] }] }] },
    });
    if (options.restoreAccess !== false) {
      await host.dispatch({
        type: "browser.profile.grant",
        workspaceId,
        profileId: BrowserProfileIdSchema.parse(specialist.access[0]!.candidates[0]!.resourceId),
        idempotencyKey: mutationIdempotencyKey("restore"),
      });
    }
  }
  if (options.member === true || options.offline === true) {
    const read = host.getSnapshot.bind(host);
    const held = new WeakMap<HostSnapshot, HostSnapshot>();
    vi.spyOn(host, "getSnapshot").mockImplementation(() => {
      const snapshot = read();
      const view =
        held.get(snapshot) ??
        ({
          ...snapshot,
          ...(options.offline === true ? { connection: "offline" } : {}),
          ...(options.member === true && snapshot.user
            ? { user: { ...snapshot.user, instanceRole: "user" } }
            : {}),
        } as HostSnapshot);
      held.set(snapshot, view);
      return view;
    });
  }
  if (options.member === true) {
    const rpc = host.rpc;
    const members = rpc["workspace.members.list"].bind(rpc);
    Object.defineProperty(host, "rpc", {
      value: new Proxy(rpc, {
        get: (target, name) =>
          name === "workspace.members.list"
            ? async (input: Parameters<typeof members>[0]) =>
                rpcSuccess({
                  members: unwrapRpcResult(await members(input)).members.map((member) => ({
                    ...member,
                    role: "collaborator" as const,
                  })),
                })
            : Reflect.get(target, name),
      }),
    });
  }
  if (options.storageIssue !== undefined) {
    host.getSnapshot().workspaces.find(({ id }) => id === project.id)!.storageIssue =
      options.storageIssue;
  }
  harness.client = host;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <ProjectSettingsScreen
        route={{ params: { deploymentId: "deployment", workspaceId: project.id } }}
      />,
    ),
  );
  await vi.waitFor(
    () => expect(container.textContent, "the specialists never loaded").toContain("Runs on"),
    { timeout: 2_000 },
  );
  await answered(container);
  return { container, host, project };
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text || node.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

function heading(container: HTMLElement, text: string): boolean {
  return [...container.querySelectorAll("h2")].some((node) => node.textContent === text);
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

/** Waits, with a deadline well inside the test's, for what the last action should show. */
async function shows(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 2_000 });
}

async function answerAlert(text: string): Promise<void> {
  const choice = native.alert?.buttons.find((candidate) => candidate.text === text);
  if (!choice?.onPress) throw new Error(`No alert button ${text}`);
  await act(async () => choice.onPress!());
}

describe("a Project's settings on the phone", () => {
  it("offers access setup for revoked access with no remaining candidates", async () => {
    const { container } = await open({ rebind: true, restoreAccess: false });
    expect(button(container, "Allow a profile")).toBeTruthy();
    expect(container.querySelector('[aria-label="Which to use for A browser profile"]')).toBeNull();
  });

  it("offers an explicit choice after revoked access is restored and returns to ready", async () => {
    const { container, host } = await open({ rebind: true });
    const dispatch = vi.spyOn(host, "dispatch");
    const choice = container.querySelector('[aria-label="Which to use for A browser profile"]')!;
    expect(choice.getAttribute("data-menu")).toBe("Choose which account to use now");
    await press(button(choice, "Work"));
    await shows(() => expect(container.textContent).toContain("Uses Work"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "specialist.bind", requirement: 0 }),
    );
    expect(container.textContent).not.toContain("Needs setup");
  });

  it("refreshes a visible specialist after its browser access is revoked elsewhere", async () => {
    const { container, host, project } = await open({ rebind: true });
    const choice = container.querySelector('[aria-label="Which to use for A browser profile"]')!;
    await press(button(choice, "Work"));
    await shows(() => expect(container.textContent).toContain("Uses Work"));
    await act(async () => {
      for (const grant of host
        .getSnapshot()
        .browserProfileGrants.filter((g) => g.workspaceId === project.id)) {
        await host.dispatch({
          type: "browser.profileGrant.revoke",
          grantId: grant.id,
          idempotencyKey: mutationIdempotencyKey("revoke-visible"),
        });
      }
    });
    await shows(() =>
      expect(button(container, "Allow a profile"), "the revoked binding still showed").toBeTruthy(),
    );
  });

  it("binds a specialist's choice, allows its missing account, and removes it after confirming", async () => {
    const { container, host, project } = await open();
    expect(container.textContent).toContain("Needs setup");
    expect(container.textContent).toContain("Runs on Claude Code · opus");
    expect(container.textContent).toContain("Reads the sites you research in");

    const choice = container.querySelector('[aria-label="Which to use for A browser profile"]')!;
    await press(button(choice, "Work"));
    await shows(() =>
      expect(container.textContent, "the choice never bound").toContain("Uses Work"),
    );
    // GitHub is still not allowed here, so it is still not ready.
    expect(container.textContent).toContain("Needs setup");

    // GitHub is allowed from here with one of the person's own accounts, at
    // the level the specialist asked for, or by connecting another.
    const allowGitHub = '[aria-label="Allow GitHub for this project"]';
    await press(button(container.querySelector(allowGitHub)!, "Connect another account"));
    expect(native.navigate.at(-1)).toEqual({
      name: "ConnectedApps",
      params: { deploymentId: "deployment" },
    });
    const dispatch = vi.spyOn(host, "dispatch");
    await press(button(container.querySelector(allowGitHub)!, "Allow octocat"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "integration.grant.create",
        input: expect.objectContaining({ access: "read", workspaceId: project.id }),
      }),
    );
    // Its access is read again, so the row no longer asks for what it now has.
    await shows(() =>
      expect(container.querySelector(allowGitHub), "GitHub still asks for access").toBeNull(),
    );

    await press(button(container, "Remove"));
    expect(native.alert?.title).toBe("Remove researcher?");
    await answerAlert("Remove specialist");
    await shows(() =>
      expect(heading(container, "Specialists"), "the specialist was never removed").toBe(false),
    );
  });

  it("turns a plugin off here, and lists who is in the project", async () => {
    const { container, host, project } = await open();
    expect(heading(container, "People")).toBe(true);
    const me = host.getSnapshot().user!;
    expect(container.textContent).toContain(`${me.displayName} (you)`);
    const toggle = container.querySelector<HTMLInputElement>(
      `input[aria-label="researcher on in ${project.name}"]`,
    )!;
    expect(toggle.checked).toBe(true);
    await press(toggle);
    await shows(() =>
      expect(
        container.querySelector<HTMLInputElement>(
          `input[aria-label="researcher on in ${project.name}"]`,
        )!.checked,
        "the plugin never turned off",
      ).toBe(false),
    );
  });

  it("shares an invite link through the system share sheet", async () => {
    const { container } = await open();
    await press(button(container, "Invite to work in it"));
    await shows(() => expect(native.shared, "the share sheet never opened").toHaveLength(1));
    expect(container.querySelector('pre[aria-label="Invite link"]')?.textContent).toBe(
      native.shared[0],
    );
  });

  it("deletes the project only after confirming, then returns to Projects", async () => {
    const { container, host, project } = await open();
    await press(button(container, "Delete project…"));
    expect(native.alert?.title).toBe(`Delete ${project.name}?`);
    expect(host.getSnapshot().workspaces.find(({ id }) => id === project.id)?.status).toBe("ready");
    await answerAlert("Delete project");
    await shows(() =>
      expect(native.navigate.at(-1)?.name, "never returned to Projects").toBe("Projects"),
    );
    expect(native.navigate.at(-1)).toEqual({
      name: "Projects",
      params: { deploymentId: "deployment" },
    });
    expect(host.getSnapshot().workspaces.find(({ id }) => id === project.id)?.status).toBe(
      "deleting",
    );
    // The way back out is on the same screen, for the owner.
    await shows(() => expect(container.textContent).toContain("Scheduled for deletion"));
    await press(button(container, "Keep this project"));
    await shows(() =>
      expect(
        host.getSnapshot().workspaces.find(({ id }) => id === project.id)?.status,
        "the project was never kept",
      ).toBe("ready"),
    );
  });

  it("names the owner computer that is offline instead of a storage fault", async () => {
    const { container, project } = await open({
      storageIssue: {
        code: "local-authority-unavailable",
        message: "The owning computer is not connected",
        occurredAt: new Date().toISOString(),
        retryable: true,
      },
    });
    expect(container.textContent).toContain("Its computer is offline");
    expect(container.textContent).toContain(
      `${project.machineName ?? "The computer that holds its folder"} isn’t connected`,
    );
    expect(container.textContent).not.toContain("needs attention");
    expect(container.textContent).not.toContain("Try again");
  });

  it("is read-only for a member who is not an owner", async () => {
    const { container, project } = await open({ member: true });
    expect(container.textContent).toContain(
      "Only an owner of this project can turn plugins on or off.",
    );
    expect(
      container.querySelector<HTMLInputElement>(
        `input[aria-label="researcher on in ${project.name}"]`,
      )!.disabled,
    ).toBe(true);
    expect(container.textContent).not.toContain("Delete project…");
    expect(container.textContent).not.toContain("Invite someone");
  });

  it("says when Opensteer can't be reached and holds changes until it is", async () => {
    const { container, project } = await open({ offline: true });
    expect(container.textContent).toContain("Opensteer can’t be reached right now");
    expect(
      container.querySelector<HTMLInputElement>(
        `input[aria-label="researcher on in ${project.name}"]`,
      )!.disabled,
    ).toBe(true);
    expect(button(container, "Delete project…").disabled).toBe(true);
    expect(button(container, "Remove").disabled).toBe(true);
  });
});
