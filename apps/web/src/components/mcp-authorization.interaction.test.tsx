// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { mockConnectedAgents } from "@opensteer/client/mock";
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
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("signed-in MCP connection consent", () => {
  it.each([390, 1440])(
    "keeps an unverified claim separate and grants eligible Chrome at %d px",
    async (width) => {
      const sourceId = createId("browserSource");
      host = new MockHostClient({
        latencyMs: 0,
        connectionConsent: {
          requestId: "r".repeat(43),
          // The preview, as the Home, cleans the name where the client registers it.
          clientName: "Grok\u202e\nVerified",
          redirectUri: "https://example.agent/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          chromeTabs: [{ sourceId, computerName: "Work Mac", paired: true }],
          chromeTabsNeedPairing: true,
          chromeTabsRepairNames: ["Home Mac"],
        },
      });
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
      const container = document.body.appendChild(document.createElement("div"));
      container.style.width = `${width}px`;
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <MemoryRouter>
            <McpAuthorization client={host!} requestId={"r".repeat(43)} />
          </MemoryRouter>,
        ),
      );
      expect(container.querySelector("h1, h2")?.textContent).toBe("An agent wants to connect");
      expect(container.querySelector(".agent-mark")).toBeNull();
      expect(container.querySelector(".agent-who__claim")?.textContent).toBe(
        "It calls itself: “Grok Verified”",
      );
      expect(
        container.querySelector<HTMLInputElement>('input[placeholder="Connection name"]')?.value,
      ).toBe("Grok Verified");
      expect(container.textContent).toContain(
        "To share tabs from Chrome on Home Mac, pair it again.",
      );
      expect(
        container.querySelector('[aria-label="Tabs you share from Chrome on Home Mac"]'),
      ).toBeNull();
      const chrome = container.querySelector<HTMLInputElement>(
        '[aria-label="Tabs you share from Chrome on Work Mac"]',
      )!;
      await act(async () => chrome.click());
      expect(chrome.checked).toBe(true);
      expect(container.textContent).toContain("only while you share it from Chrome’s toolbar");
    },
  );

  it.each([390, 1440])(
    "shows both verified origins and a quiet pairing hint at %d px",
    async (width) => {
      const { identity, identityAtConsent } = mockConnectedAgents("seeded").connections.find(
        ({ label }) => label === "Errand",
      )!;
      host = new MockHostClient({
        latencyMs: 0,
        connectionConsent: {
          requestId: "r".repeat(43),
          clientName: "Untrusted name",
          redirectUri: "https://agentpay.example/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...(identity ? { identity } : {}),
          ...(identityAtConsent ? { identityAtConsent } : {}),
          chromeTabs: [],
          chromeTabsNeedPairing: true,
        },
      });
      vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
      const container = document.body.appendChild(document.createElement("div"));
      container.style.width = `${width}px`;
      root = createRoot(container);
      await act(async () =>
        root!.render(
          <MemoryRouter>
            <McpAuthorization client={host!} requestId={"r".repeat(43)} />
          </MemoryRouter>,
        ),
      );
      expect(container.querySelector("h1, h2")?.textContent).toBe("AgentPay");
      expect(container.querySelector(".agent-mark")).not.toBeNull();
      expect(container.textContent).not.toContain("Asked for this");
      expect(container.textContent).toContain(
        "Holds the access: “AgentPay” · https://agentpay.example",
      );
      expect(container.textContent).not.toContain("Untrusted name");
      // The verified name is the heading; the line under it says only that it is verified.
      expect(container.querySelector(".agent-who__name")?.textContent).toBe("Verified");
      expect(container.textContent).not.toContain("Access goes to");
      expect(container.textContent).toContain(
        "To share tabs with a connected agent, pair Chrome again.",
      );
      expect(container.querySelector('[aria-label^="Tabs you share from Chrome"]')).toBeNull();
    },
  );

  it("discards an old approval response after the window receives another request", async () => {
    host = new MockHostClient({ latencyMs: 0, grantsAvailable: false });
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async ({ requestId }: { requestId: string }) => ({
        ok: true,
        data: {
          requestId,
          clientName: "Example",
          redirectUri: "https://example.agent/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
  it("keeps the simple consent on a Home without grants, and defaults to an approval ceiling", async () => {
    host = new MockHostClient({ latencyMs: 0, grantsAvailable: false });
    Object.defineProperty(host.rpc, "connections.authorization.get", {
      value: vi.fn(async () => ({
        ok: true,
        data: {
          requestId: "r".repeat(43),
          clientName: "Example agent",
          redirectUri: "https://example.agent/callback",
          resource: "https://host.example/internal/v1/mcp",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
    expect(container.querySelector("h1, h2")?.textContent).toBe("An agent wants to connect");
    expect(container.textContent).toContain("It calls itself: “Example agent”");
    // Where access goes is said once, as the destination; not again as "Returns to".
    expect(container.textContent).not.toContain("Returns to");
    expect(container.textContent).toContain("Access goes to example.agent.");
    expect(container.textContent).not.toContain("What it can use");
    // The mode reads as it does for a connection: its work never runs with
    // the person's own engine settings.
    expect(container.textContent).not.toContain("a rule you set in the engine");
    expect(container.textContent).toContain("Asks you before anything that changes something.");
    expect(container.querySelector<HTMLInputElement>('input[type="radio"]:checked')!.value).toBe(
      "approval-required",
    );
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
        },
      }),
    );
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("approved");
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
