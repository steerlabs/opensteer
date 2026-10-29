// @vitest-environment happy-dom

import type { HostClient } from "@opensteer/client/host";
import type { ComputerUseView } from "@opensteer/client/integrations";
import type { IntegrationDefinitionSummary } from "@opensteer/integration-core";
import type { ComputerUseSessionSummary, MachineSummary } from "@opensteer/protocol";
import type { DesktopOpenComputerUsePermissionsPanelResult } from "@opensteer/protocol/desktop";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerUseBlock,
  type ComputerUseApprovalKeySetup,
  type ComputerUseLocalActions,
} from "./computer-use-section.js";

const mac = "rnr_11111111-1111-4111-8111-111111111111";
const setupRequestId = "00000000-0000-4000-8000-000000000007";
const notes = { bundleId: "com.apple.Notes", displayName: "Notes", teamId: "APPLECOMP1" };
const preview = { bundleId: "com.apple.Preview", displayName: "Preview", teamId: "APPLECOMP1" };
const safari = { bundleId: "com.apple.Safari", displayName: "Safari", teamId: "APPLECOMP1" };
const mountedRoots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  for (const root of mountedRoots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("ComputerUseBlock", () => {
  it("prioritizes an offline Mac over approval-key setup", async () => {
    const { container } = await mount({
      local: null,
      view: view({ approvalKeyId: null, state: { kind: "offline" } }),
    });
    expect(container.textContent).toContain("Studio is offline.");
    expect(container.textContent).not.toContain("App approvals need setup.");
  });

  it("waits for the desktop key to match the Host before offering local approvals", async () => {
    const { container } = await mount({
      approvalKeySetup: { error: null, ready: false, retry: vi.fn() },
      view: view({ approvalKeyId: `sha256:${"a".repeat(43)}` }),
    });
    expect(button(container, "Add app")).toBeNull();
    expect(radio(container, "automatic").disabled).toBe(true);
  });

  it("points a remote viewer at the Mac instead of offering the panel", async () => {
    const { container } = await mount({
      local: null,
      view: view({
        state: {
          kind: "permission-required",
          missing: ["accessibility"],
          permissions: { accessibility: "denied", screenRecording: "granted" },
        },
      }),
    });
    expect(container.querySelectorAll(".computer-use__grant--done")).toHaveLength(1);
    expect(button(container, "Set up on this Mac")).toBeNull();
    expect(container.textContent).toContain(
      "Set up from Studio. In the Opensteer desktop app there, open Settings → Computers → Studio.",
    );
  });

  it("says why a build that is not Developer ID signed cannot set up computer use", async () => {
    const { container } = await mount({
      local: localActions({
        openPermissions: async () => ({ opened: false, reason: "unsigned-build" }),
      }),
      view: view({
        state: {
          kind: "permission-required",
          missing: ["accessibility"],
          permissions: { accessibility: "denied", screenRecording: "granted" },
        },
      }),
    });
    await click(button(container, "Set up on this Mac"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "This build isn’t signed with a Developer ID, so it can’t set up computer use. See SIGNING.md.",
    );
  });

  it("shows why the setup panel did not open", async () => {
    const { container } = await mount({
      local: localActions({
        openPermissions: async () => {
          throw new Error(
            "The Computer use permissions panel could not load the bundled application.",
          );
        },
      }),
      view: view({
        state: {
          kind: "permission-required",
          missing: ["accessibility"],
          permissions: { accessibility: "denied", screenRecording: "granted" },
        },
      }),
    });
    await click(button(container, "Set up on this Mac"));
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "The Computer use permissions panel could not load the bundled application.",
    );
  });

  it("keeps the latest setup attempt's answer when an earlier one settles last", async () => {
    const first = deferred<DesktopOpenComputerUsePermissionsPanelResult>();
    const second = deferred<DesktopOpenComputerUsePermissionsPanelResult>();
    const attempts = [first, second];
    const { container } = await mount({
      local: localActions({
        openPermissions: () => {
          const attempt = attempts.shift();
          if (!attempt) throw new Error("unexpected setup attempt");
          return attempt.promise;
        },
      }),
      view: view({
        state: {
          kind: "permission-required",
          missing: ["accessibility"],
          permissions: { accessibility: "denied", screenRecording: "granted" },
        },
      }),
    });
    await click(button(container, "Set up on this Mac"));
    await click(button(container, "Set up on this Mac"));
    await act(async () => second.resolve({ opened: true }));
    await act(async () => first.reject(new Error("The first panel could not open.")));
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("confirms automatic approval in this Mac's own window", async () => {
    const reviewSetup = vi.fn(async () => true);
    const refresh = vi.fn(async () => undefined);
    const dispatch = vi.fn(async (command: { type: string }) => ({
      request: { id: setupRequestId },
      type: command.type,
    }));
    const { container } = await mount({
      dispatch,
      local: localActions({ reviewSetup }),
      refresh,
      view: view({ apps: [row(notes)] }),
    });
    expect(container.querySelector("legend")?.textContent).toBe("App approvals");

    await click(radio(container, "automatic"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { appApproval: "automatic", kind: "policy", runnerId: mac },
        type: "integration.computer.setup.request",
      }),
    );
    expect(reviewSetup).toHaveBeenCalledWith(setupRequestId);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("offers automatic approval elsewhere only as where to turn it on", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({ type: command.type }));
    const { container } = await mount({ dispatch, local: null, view: view({}) });
    expect(radio(container, "automatic").disabled).toBe(true);
    expect(container.textContent).toContain("Turn this on from Studio.");
    expect(button(container, "Add app")).toBeNull();
    await click(radio(container, "automatic"));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("turns automatic off from anywhere, at once", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({
      appApproval: "ask",
      type: command.type,
    }));
    const refresh = vi.fn(async () => undefined);
    const { container } = await mount({
      dispatch,
      local: null,
      refresh,
      view: view({ appApproval: "automatic", apps: [row(notes)] }),
    });
    expect(container.textContent).toContain(
      "Apps appear below as agents use them. Block one to keep agents out of it.",
    );
    expect(radio(container, "ask").disabled).toBe(false);

    await click(radio(container, "ask"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { appApproval: "ask", runnerId: mac },
        type: "integration.computer.policy.set",
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("removes an app under Ask for each app in one click, busy until the Host answers", async () => {
    const answer = deferred<{ type: string }>();
    const dispatch = vi.fn(async () => answer.promise);
    const onChanged = vi.fn(async () => undefined);
    const { container } = await mount({
      dispatch,
      onChanged,
      view: view({ apps: [row(notes), row(preview)] }),
    });
    expect(container.textContent).toContain("Can see and control");
    expect(button(container, "Block Notes")).toBeNull();

    await click(button(container, "Remove Notes"));
    expect(document.querySelector(".dialog")).toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "con_notes", type: "integration.disconnect" }),
    );
    const removing = button(container, "Remove Notes");
    expect(removing?.textContent).toBe("Removing…");
    expect(removing?.disabled).toBe(true);
    expect(button(container, "Remove Preview")?.disabled).toBe(true);

    await act(async () => answer.resolve({ type: "integration.disconnect" }));
    expect(onChanged).toHaveBeenCalledOnce();
    expect(button(container, "Remove Notes")?.textContent).toBe("Remove");
  });

  it("blocks an app under automatic approval and shows it blocked with a way back", async () => {
    const dispatch = vi.fn(async (command: { type: string }) => ({
      request: { id: setupRequestId },
      type: command.type,
    }));
    const reviewSetup = vi.fn(async () => true);
    const { container } = await mount({
      dispatch,
      local: localActions({ reviewSetup }),
      view: view({
        appApproval: "automatic",
        apps: [row(notes), { ...row(safari, "read"), blocked: true }],
      }),
    });
    const blocked = container.querySelector(".computer-use__app--blocked");
    expect(blocked?.textContent).toContain("Safari");
    expect(blocked?.querySelector(".chip")?.textContent).toBe("Blocked");
    expect(button(container, "Remove Notes")).toBeNull();

    await click(button(container, "Block Notes"));
    expect(document.querySelector(".dialog")).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "con_notes",
        type: "integration.computer.app.block",
      }),
    );

    await click(button(container, "Unblock on this Mac"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          access: "read",
          app: safari,
          definitionId: "macos-app",
          kind: "app",
          runnerId: mac,
        },
        type: "integration.computer.setup.request",
      }),
    );
    expect(reviewSetup).toHaveBeenCalledWith(setupRequestId);
  });

  it("says where a blocked app is unblocked when viewed from elsewhere", async () => {
    const { container } = await mount({
      local: null,
      view: view({ apps: [{ ...row(safari), blocked: true }] }),
    });
    expect(button(container, "Unblock on this Mac")).toBeNull();
    expect(container.textContent).toContain("Unblock on Studio");
  });

  it("adds an app in one choice: the access on its row opens the native approval directly", async () => {
    const reviewSetup = vi.fn(async () => true);
    const onChanged = vi.fn(async () => undefined);
    const dispatch = vi.fn(async (command: { type: string }) => ({
      request: { id: setupRequestId },
      type: command.type,
    }));
    const installed = vi.fn(async () => ({
      data: {
        apps: [notes, preview].map((identity) => ({ identity, running: false })),
        total: 2,
      },
      ok: true,
    }));
    const { container } = await mount({
      dispatch,
      local: localActions({ reviewSetup }),
      onChanged,
      rpc: { "integration.computer.apps.installed": installed },
      view: view({ apps: [row(notes, "read")] }),
    });

    await click(button(container, "Add app"));
    await settle();
    expect(installed).toHaveBeenCalledWith({
      icons: true,
      limit: 50,
      offset: 0,
      query: "",
      runnerId: mac,
    });
    const candidates = [...dialog().querySelectorAll<HTMLElement>(".computer-use__list > li")];
    // Notes is already approved, so it is listed as such and offers no choice.
    expect(
      candidates.map((element) => [
        element.textContent,
        [...element.querySelectorAll("button")].map((choice) => choice.textContent),
      ]),
    ).toEqual([
      [expect.stringContaining("Approved · Can see"), []],
      [expect.stringContaining("Preview"), ["Can see", "Can see and control"]],
    ]);
    expect(candidates[1]?.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Add Preview",
    );

    await click(button(candidates[1] ?? dialog(), "Can see"));
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          access: "read",
          app: preview,
          definitionId: "macos-app",
          kind: "app",
          runnerId: mac,
        },
        type: "integration.computer.setup.request",
      }),
    );
    expect(reviewSetup).toHaveBeenCalledOnce();
    expect(reviewSetup).toHaveBeenCalledWith(setupRequestId);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(document.querySelector(".dialog")).toBeNull();
  });

  it("keeps the picker open, busy while this Mac asks, and says in the row when it fails", async () => {
    const review = deferred<boolean>();
    const reviewSetup = vi.fn(async () => review.promise);
    const dispatch = vi.fn(async (command: { type: string }) => ({
      request: { id: setupRequestId },
      type: command.type,
    }));
    const installed = vi.fn(async () => ({
      data: {
        apps: [notes, preview].map((identity) => ({ identity, running: false })),
        total: 2,
      },
      ok: true,
    }));
    const { container } = await mount({
      dispatch,
      local: localActions({ reviewSetup }),
      rpc: { "integration.computer.apps.installed": installed },
      view: view({}),
    });
    await click(button(container, "Add app"));
    await settle();
    const [notesRow, previewRow] = [
      ...dialog().querySelectorAll<HTMLElement>(".computer-use__list > li"),
    ];
    if (!notesRow || !previewRow) throw new Error("rows missing");

    await click(button(previewRow, "Can see and control"));
    expect(previewRow.getAttribute("aria-busy")).toBe("true");
    expect(button(previewRow, "Confirming…")?.disabled).toBe(true);
    expect(button(notesRow, "Can see")?.disabled).toBe(true);

    await act(async () => review.reject(new Error("Opensteer on Studio did not answer.")));
    expect(previewRow.querySelector('[role="alert"]')?.textContent).toBe(
      "Opensteer on Studio did not answer.",
    );
    expect(notesRow.querySelector('[role="alert"]')).toBeNull();
    expect(button(previewRow, "Can see and control")?.disabled).toBe(false);
    expect(document.querySelector(".dialog")).not.toBeNull();
  });

  it("searches and pages on the Mac rather than in the page", async () => {
    vi.useFakeTimers();
    const installed = vi.fn(async (input: unknown) => {
      const { offset, query } = input as { offset: number; query: string };
      return {
        data: {
          apps: [offset === 0 ? notes : preview].map((identity) => ({ identity, running: false })),
          total: query ? 1 : 2,
        },
        ok: true,
      };
    });
    const { container } = await mount({
      rpc: { "integration.computer.apps.installed": installed },
      view: view({}),
    });
    await click(button(container, "Add app"));
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    await click(button(container, "Show more"));
    expect(installed).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1, query: "" }));
    expect(container.querySelectorAll(".computer-use__list > li")).toHaveLength(2);

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error("search missing");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(search, "not");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(installed).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, query: "not" }),
    );
    expect(button(container, "Show more")).toBeNull();
  });

  it("names the task that asked for a pending app and declines it, as on the thread's card", async () => {
    const answer = deferred<{ type: string }>();
    const dispatch = vi.fn(async () => answer.promise);
    const request = {
      id: setupRequestId,
      threadId: "thr_00000000-0000-4000-8000-000000000001",
      threadTitle: "Plan the week",
    } as ComputerUseView["pending"][number]["request"];
    const { container } = await mount({
      dispatch,
      local: null,
      view: view({ pending: [{ access: "read-write", identity: preview, request }] }),
    });
    const pendingRow = container.querySelector(".computer-use__app--pending");
    expect(pendingRow?.textContent).toContain("Asked in Plan the week");
    expect(pendingRow?.querySelector("a")?.getAttribute("href")).toBe(
      "/threads/thr_00000000-0000-4000-8000-000000000001",
    );
    expect(button(container, "Cancel Preview")).toBeNull();

    await click(button(container, "Decline Preview"));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: setupRequestId,
        type: "integration.computer.setup.cancel",
      }),
    );
    expect(button(container, "Decline Preview")?.textContent).toBe("Declining…");
    await act(async () => answer.reject(new Error("Studio did not answer.")));
    expect(pendingRow?.querySelector('[role="alert"]')?.textContent).toBe("Studio did not answer.");
    expect(container.querySelector(".notice--error")).toBeNull();
  });

  it("says where to confirm automatic approval while this Mac asks, and why it did not change", async () => {
    const review = deferred<boolean>();
    const dispatch = vi.fn(async (command: { type: string }) => ({
      request: { id: setupRequestId },
      type: command.type,
    }));
    const { container } = await mount({
      dispatch,
      local: localActions({ reviewSetup: () => review.promise }),
      view: view({ apps: [row(notes)] }),
    });

    await click(radio(container, "automatic"));
    expect(container.textContent).toContain("Confirm in the Opensteer window on this Mac.");
    expect(radio(container, "automatic").checked).toBe(false);

    await act(async () => review.reject(new Error("That approval is no longer open.")));
    expect(container.textContent).not.toContain("Confirm in the Opensteer window");
    expect(container.querySelector(".notice--error")?.textContent).toBe(
      "That approval is no longer open.",
    );
  });

  it("shows Stop busy and says in the session's row why it did not stop", async () => {
    const answer = deferred<unknown>();
    const stop = vi.fn(async () => answer.promise);
    const { container } = await mount({
      rpc: { "integration.computer.session.stop": stop },
      view: view({
        sessions: [session("cus_00000000-0000-4000-8000-000000000001", [notes], "Plan")],
      }),
    });
    const sessionRow = container.querySelector(".computer-use__session");
    await click(sessionRow?.querySelector("button") ?? null);
    expect(sessionRow?.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Stop Using Notes on Studio",
    );
    expect(sessionRow?.querySelector("button")?.textContent).toBe("Stopping…");
    await act(async () => {
      sessionRow?.querySelector("button")?.click();
      sessionRow?.querySelector("button")?.click();
    });
    expect(stop).toHaveBeenCalledTimes(1);

    await act(async () => answer.reject(new Error("Studio is offline.")));
    expect(sessionRow?.querySelector('[role="alert"]')?.textContent).toBe("Studio is offline.");
    expect(sessionRow?.querySelector("button")?.textContent).toBe("Stop");
    expect(container.querySelector(".notice--error")).toBeNull();
  });
});

interface MountInput {
  readonly approvalKeySetup?: ComputerUseApprovalKeySetup;
  readonly dispatch?: (command: { type: string }) => Promise<unknown>;
  readonly local?: ComputerUseLocalActions | null;
  readonly onChanged?: () => Promise<void>;
  readonly refresh?: () => Promise<void>;
  readonly rpc?: Record<string, (input: unknown) => Promise<unknown>>;
  readonly view: ComputerUseView;
}

async function mount(input: MountInput) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  const hostClient = {
    dispatch: input.dispatch ?? (async (command: { type: string }) => ({ type: command.type })),
    // Stop outcomes are kept per signed-in person on one deployment.
    getSnapshot: () => ({
      deploymentId: "dep_00000000-0000-4000-8000-000000000001",
      session: "authenticated",
      user: { id: "usr_00000000-0000-4000-8000-000000000001" },
    }),
    refresh: input.refresh ?? (async () => undefined),
    rpc: input.rpc ?? {},
    subscribe: () => () => undefined,
  } as unknown as HostClient;
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ComputerUseBlock
          approvalKeySetup={input.approvalKeySetup ?? null}
          hostClient={hostClient}
          local={input.local === undefined ? localActions({}) : input.local}
          machine={{ id: mac, name: "Studio", status: "online" } as MachineSummary}
          onChanged={input.onChanged ?? (async () => undefined)}
          owned
          view={input.view}
        />
      </MemoryRouter>,
    );
  });
  return { container };
}

function localActions(overrides: Partial<ComputerUseLocalActions>): ComputerUseLocalActions {
  return {
    openPermissions: async () => ({ opened: true }),
    reviewSetup: async () => true,
    ...overrides,
  };
}

function view(overrides: Partial<ComputerUseView>): ComputerUseView {
  return {
    appApproval: "ask",
    approvalKeyId: `sha256:${"A".repeat(43)}`,
    apps: [],
    definition: { id: "macos-app", name: "Computer use" } as IntegrationDefinitionSummary,
    pending: [],
    sessions: [],
    state: { kind: "ready" },
    ...overrides,
  };
}

function row(
  identity: typeof notes,
  access: "read" | "read-write" = "read-write",
): ComputerUseView["apps"][number] {
  return {
    access,
    blocked: false,
    connectionId: `con_${identity.displayName.toLowerCase()}`,
    identity,
    inUse: false,
  };
}

function session(
  sessionId: string,
  apps: readonly (typeof notes)[],
  threadTitle: string | null,
): ComputerUseSessionSummary {
  return {
    actionCount: 4,
    apps,
    openedAt: "2026-09-21T00:00:00.000Z",
    runId: "run_00000000-0000-4000-8000-000000000001",
    sessionId,
    threadId: "thr_00000000-0000-4000-8000-000000000001",
    threadTitle,
  } as unknown as ComputerUseSessionSummary;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, reject, resolve };
}

function radio(container: HTMLElement, value: string): HTMLInputElement {
  const element = container.querySelector<HTMLInputElement>(
    `input[type="radio"][value="${value}"]`,
  );
  if (!element) throw new Error(`radio ${value} missing`);
  return element;
}

function dialog(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".dialog");
  if (!element) throw new Error("dialog missing");
  return element;
}

function button(container: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll("button")].find(
      (element) =>
        element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
    ) ?? null
  );
}

async function click(element: HTMLElement | null): Promise<void> {
  if (!element) throw new Error("element missing");
  await act(async () => {
    element.click();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
