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
        .find((button) => button.textContent === "Allow")!
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
    const ceiling = (mode: string) =>
      container.querySelector<HTMLInputElement>(`input[type="radio"][value="${mode}"]`)!;
    await act(async () => ceiling("full-access").click());
    expect(ceiling("full-access").checked).toBe(true);
    await act(async () =>
      root!.render(<McpAuthorization client={host!} requestId={"s".repeat(43)} />),
    );
    expect(container.textContent).toContain("Second agent");
    expect(ceiling("approval-required").checked).toBe(true);
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
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toMatch(/^com\.opensteer\.opensteer:/);
    expect(links[0]!.getAttribute("href")).toContain(`deploymentId=${deploymentId}`);
    expect(links[0]!.getAttribute("href")).not.toMatch(/token|code|verifier/);
    expect(container.querySelector("input")).toBeNull();
    // A phone or tablet hands the same request to the mobile app instead,
    // including iPad Safari, which presents itself as a Mac.
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
    );
    vi.spyOn(navigator, "maxTouchPoints", "get").mockReturnValue(5);
    await act(async () =>
      root!.render(
        <McpAuthorizationLaunch requestId={"s".repeat(43)} deploymentId={deploymentId} />,
      ),
    );
    expect(container.querySelector("a")!.getAttribute("href")).toMatch(/^com\.opensteer\.mobile:/);
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
      (button) => button.textContent === "Allow",
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
    expect(container.textContent).toContain("Access goes to example.agent.");
    expect(container.querySelector<HTMLInputElement>('input[type="radio"]:checked')!.value).toBe(
      "approval-required",
    );
    expect(container.querySelector("select")!.value).toBe(workspaceId);
    const allow = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Allow",
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
