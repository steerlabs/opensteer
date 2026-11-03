// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createId } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpAuthorization, McpAuthorizationLaunch } from "./mcp-authorization.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
});

describe("signed-in MCP connection consent", () => {
  it("discards an old approval response after the window receives another request", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async ({ requestId }: { requestId: string }) => ({
        ok: true,
        data: {
          requestId,
          clientName: "Example",
          redirectUri: "https://example.agent/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          workspaces: [],
        },
      })),
      configurable: true,
    });
    let finish:
      ((output: { type: "connection.authorize"; completionPath: string }) => void) | undefined;
    vi.spyOn(host, "dispatch").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const openExternalUrl = vi.fn(async () => ({ opened: true as const }));
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <McpAuthorization
          client={host!}
          requestId={"r".repeat(43)}
          desktopBridge={{ openExternalUrl }}
          onClose={onClose}
        />,
      ),
    );
    await act(async () =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "Allow connection")!
        .click(),
    );
    expect(finish).toBeTypeOf("function");
    await act(async () =>
      root!.render(
        <McpAuthorization
          client={host!}
          requestId={"s".repeat(43)}
          desktopBridge={{ openExternalUrl }}
          onClose={onClose}
        />,
      ),
    );
    await act(async () =>
      finish!({
        type: "connection.authorize",
        completionPath: `/oauth/mcp/complete?request=${"r".repeat(43)}`,
      }),
    );
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
  it("resets the ceiling for a different request in the same client window", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async ({ requestId }: { requestId: string }) => ({
        ok: true,
        data: {
          requestId,
          clientName: requestId[0] === "r" ? "First agent" : "Second agent",
          redirectUri: "https://example.agent/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          workspaces: [],
        },
      })),
      configurable: true,
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<McpAuthorization client={host!} requestId={"r".repeat(43)} />),
    );
    const ceiling = container.querySelector("select")!;
    await act(async () => {
      ceiling.value = "full-access";
      ceiling.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ceiling.value).toBe("full-access");
    await act(async () =>
      root!.render(<McpAuthorization client={host!} requestId={"s".repeat(43)} />),
    );
    expect(container.textContent).toContain("Second agent");
    expect(container.querySelector("select")!.value).toBe("approval-required");
  });
  it("opens the installed client using request identifiers without granting access", async () => {
    const deploymentId = createId("deployment");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <McpAuthorizationLaunch requestId={"r".repeat(43)} deploymentId={deploymentId} />,
      ),
    );
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(2);
    expect(links[0]!.getAttribute("href")).toContain(`deploymentId=${deploymentId}`);
    expect(links[0]!.getAttribute("href")).not.toMatch(/token|code|verifier/);
    expect(container.querySelector("input")).toBeNull();
  });
  it("finishes desktop approval in the external browser without exporting a Host session", async () => {
    host = new MockHostClient({
      latencyMs: 0,
      connectionConsent: {
        requestId: "r".repeat(43),
        clientName: "Example",
        redirectUri: "http://127.0.0.1:4999/cb",
        resource: "http://127.0.0.1:4310/internal/v1/mcp",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        workspaces: [],
      },
    });
    const openExternalUrl = vi.fn(async () => ({ opened: true as const }));
    const onClose = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        <McpAuthorization
          client={host!}
          requestId={"r".repeat(43)}
          desktopBridge={{ openExternalUrl }}
          onClose={onClose}
        />,
      ),
    );
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow connection",
    )!;
    await act(async () => allow.click());
    expect(openExternalUrl).toHaveBeenCalledExactlyOnceWith({
      url: `http://127.0.0.1:4310/oauth/mcp/complete?request=${"r".repeat(43)}`,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("requires a deliberate approval and defaults to one Workspace with an approval ceiling", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    const workspaceId = createId("workspace");
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async () => ({
        ok: true,
        data: {
          requestId: "r".repeat(43),
          clientName: "Example agent",
          redirectUri: "https://example.agent/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          workspaces: [{ id: workspaceId, name: "Research" }],
        },
      })),
      configurable: true,
    });
    const dispatch = vi.spyOn(host, "dispatch").mockRejectedValue(new Error("refused"));
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(<McpAuthorization client={host!} requestId={"r".repeat(43)} />),
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(container.textContent).toContain("not verified");
    expect(container.textContent).toContain("https://example.agent");
    const selects = container.querySelectorAll("select");
    expect(selects[0]!.value).toBe("approval-required");
    expect(selects[1]!.value).toBe(workspaceId);
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow connection",
    )!;
    await act(async () => allow.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.authorize",
        decision: {
          kind: "approve",
          label: "Example agent",
          accessMode: "approval-required",
          reach: { kind: "workspace", workspaceId },
        },
      }),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "could not be approved",
    );
  });
  it("never approves an expired or unreadable request", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    const dispatch = vi.spyOn(host, "dispatch");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<McpAuthorization client={host!} requestId={null} />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("request is missing");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
