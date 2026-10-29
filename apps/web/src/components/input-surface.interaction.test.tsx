// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createId, type Request } from "@opensteer/core";
import { MemoryRouter } from "react-router";
import { InputSurface } from "./input-surface.js";

const noPlaces = vi.hoisted(() => ({ browserSessions: [], connection: "connected", machines: [] }));
const shell = vi.hoisted(() => ({
  desktopBridge: null,
  desktopDeployment: null,
  hostClient: {
    dispatch: vi.fn(async () => undefined),
    // The composer's place list reads the catalog; this conversation has none.
    getSnapshot: vi.fn(() => noPlaces),
    subscribe: vi.fn(() => () => undefined),
    loadEarlierWorkspaces: vi.fn(async () => undefined),
    rpc: {
      "integration.platform.get": vi.fn(async () => ({
        data: {
          authorizationSurface: "canonical",
          catalog: [],
          connections: [],
          installations: [],
        },
        ok: true,
      })),
      "integrations.get": vi.fn(async () => ({
        data: {
          applications: [],
          callbackUrls: {},
          connections: [],
          hostedOAuthDisclosure: "Disclosure",
          isAdministrator: true,
          providerAuthorizations: {},
          providers: [],
        },
        ok: true,
      })),
    },
  },
  snapshot: {
    deploymentId: "deployment",
    deploymentShape: { kind: "personal" },
    machines: [
      {
        allowedModules: ["integrations"],
        id: "rnr_00000000-0000-4000-8000-000000000009",
        name: "Studio",
        ownership: "mine",
      },
    ],
    browserSessions: [],
    threads: [{ id: "thread", workspaceId: "workspace" }],
    user: { id: "viewer", instanceRole: "administrator" },
    waitingRequests: [],
    workspaceWindow: { hasMore: false, itemCount: 1 },
    workspaces: [{ id: "workspace", kind: "main", name: "Main" }],
  },
  reportActionError: vi.fn(),
  localExecutionStatus: null,
}));
vi.mock("./app-shell.js", () => ({ useShell: () => shell }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  shell.hostClient.dispatch.mockClear();
});

function request(presentation: Request["presentation"]): Request {
  return {
    callId: "call",
    cancellationReason: null,
    createdAt: "2026-09-17T00:00:00Z",
    id: createId("request"),
    kind: "harness.input",
    mode: "live",
    originatingOccurrenceId: null,
    originatingRunId: createId("run"),
    originatingThreadId: createId("thread"),
    originatingWorkspaceId: createId("workspace"),
    payload: { kind: "harness.input" },
    presentation,
    requestedBy: createId("user"),
    requiredActor: "administrator",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: createId("workspace"),
  };
}

describe("request surface connectivity", () => {
  it("shows an agent's app request with its reason and where it is approved", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const approval = {
      ...request({
        detail: "Compare the two drafts. Preview on Studio — can see. Approve on that Mac.",
        kind: "external",
        subject: { id: "setup-request", kind: "computer-app-setup" },
        title: "Wants to use Preview on Studio",
      }),
      kind: "computer.app.access",
      mode: "durable",
      payload: {
        access: "read",
        app: { bundleId: "com.apple.Preview", displayName: "Preview", teamId: null },
        definitionId: "macos-app",
        kind: "computer.app.access",
        reason: "Compare the two drafts.",
        runnerId: "rnr_00000000-0000-4000-8000-000000000009",
        setupRequestId: "setup-request",
        workspaceId: createId("workspace"),
      },
      requiredActor: "workspace-owner",
    } as unknown as Request;

    await act(async () => {
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Reply…"
            requests={[approval]}
            running={false}
            threadId="thread"
          />
        </MemoryRouter>,
      );
    });

    expect(node.textContent).toContain("Wants to use Preview on Studio");
    expect(node.querySelector(".action-detail")?.textContent).toBe("Compare the two drafts.");
    // Approving happens in the window Opensteer opens on Studio itself.
    expect(node.textContent).toContain("Can see · Approve on Studio");
    expect([...node.querySelectorAll("button")].map(({ textContent }) => textContent)).toEqual(
      expect.arrayContaining(["Decline"]),
    );
    expect(
      [...node.querySelectorAll("button")].some(({ textContent }) =>
        textContent?.startsWith("Approve"),
      ),
    ).toBe(false);

    await act(async () => {
      [...node.querySelectorAll("button")]
        .find(({ textContent }) => textContent === "Decline")
        ?.click();
    });
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        response: { kind: "external", value: { decision: "declined" } },
        type: "request.respond",
      }),
    );
  });

  // Typing beside a docked approval must never answer it: declining it with the
  // typed words as guidance, then also sending them, made one Send do two things.
  it("sends typed words as an ordinary message and leaves a docked approval to its buttons", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    // A kept message is checked against its Thread, so this one is a real id.
    const threadId = createId("thread");
    const approval = {
      ...request({
        kind: "choice",
        options: [
          { hint: "allow-once", id: "allow", label: "Allow once" },
          { hint: "reject-once", id: "reject", label: "Not now" },
        ],
        risk: "medium",
        title: "Send email to Maya Chen?",
      }),
      kind: "harness.approval",
      payload: { kind: "harness.approval" },
    } as Request;
    await act(async () => {
      root.render(
        <MemoryRouter>
          <InputSurface
            disabled={false}
            placeholder="Ask anything…"
            requests={[approval]}
            running
            threadId={threadId}
            variant="conversation"
          />
        </MemoryRouter>,
      );
    });
    const field = node.querySelector<HTMLTextAreaElement>(".composer textarea")!;
    expect(field.placeholder).toBe("Ask anything…");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Make it friendlier",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      node.querySelector<HTMLButtonElement>('[aria-label="Send message"]')?.click();
    });
    expect(shell.hostClient.dispatch).toHaveBeenCalledOnce();
    expect(shell.hostClient.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ threadId, type: "thread.sendMessage" }),
    );
    expect(
      [...node.querySelectorAll(".action-rows .action-row__label")].map((item) => item.textContent),
    ).toEqual(["Allow once", "Not now"]);
  });

  it("disables all approval controls offline and restores them on reconnect", async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    const approval = request({
      kind: "choice",
      title: "Continue?",
      options: [{ id: "yes", label: "Continue", hint: "confirm" }],
    });
    const render = (disabled: boolean) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <InputSurface
              disabled={disabled}
              placeholder="Reply…"
              requests={[approval]}
              running={false}
              threadId="thread"
            />
          </MemoryRouter>,
        ),
      );
    render(true);
    expect(node.querySelector("fieldset")?.disabled).toBe(true);
    const button = node.querySelector<HTMLButtonElement>(".action-rows button")!;
    await act(async () => button.click());
    expect(shell.hostClient.dispatch).not.toHaveBeenCalled();
    render(false);
    expect(node.querySelector("fieldset")?.disabled).toBe(false);
    await act(async () => button.click());
    expect(shell.hostClient.dispatch).toHaveBeenCalledOnce();
  });

  it("retains a draft when a form request docks and then resolves", () => {
    const node = document.createElement("div");
    root = createRoot(node);
    const form = request({
      kind: "form",
      title: "Choose a name",
      fields: [{ id: "name", multiSelect: false, prompt: "Name", secret: false }],
    });
    const render = (requests: Request[]) =>
      act(() =>
        root.render(
          <MemoryRouter>
            <InputSurface
              disabled
              placeholder="Reply…"
              requests={requests}
              running={false}
              threadId="thread"
            />
          </MemoryRouter>,
        ),
      );
    render([]);
    const field = node.querySelector("textarea")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
        field,
        "Still my draft",
      );
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    render([form]);
    expect(field.closest("[hidden]")).not.toBeNull();
    expect(node.querySelector("fieldset")?.disabled).toBe(true);
    render([]);
    expect(node.querySelector("textarea")).toBe(field);
    expect(field.closest("[hidden]")).toBeNull();
    expect(field.value).toBe("Still my draft");
  });
});
