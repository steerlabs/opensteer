// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { UserIdSchema } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import type { AgentConnection } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import type { SettingsView } from "../primitives.js";
import { ExternalAgentsSection } from "./external-agents.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
});

const view = {
  administrator: true,
  facts: { desktop: true, onThisComputer: true, remote: false },
} as unknown as SettingsView;

async function mount(client: MockHostClient) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = { hostClient: client, snapshot: client.getSnapshot() } as unknown as ShellContext;
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <ShellContext value={context}>
          <ExternalAgentsSection client={client} view={view} />
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  return container;
}

function button(label: string) {
  const found = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!found) throw new Error(`No ${label} button`);
  return found;
}

describe("External agents in web and desktop Settings", () => {
  it("lists a connection's scope and removes only that connection", async () => {
    const row: AgentConnection = {
      id: `mcn_${crypto.randomUUID()}`,
      userId: UserIdSchema.parse("usr_0192f4a1-0000-4000-8000-000000000001"),
      label: "Research agent",
      clientName: "Example",
      accessMode: "auto",
      reach: { kind: "user" },
      createdAt: "2026-11-01T00:00:00Z",
      expiresAt: "2026-12-01T00:00:00Z",
      lastUsedAt: null,
    };
    host = new MockHostClient({ latencyMs: 0, connections: [row] });
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Research agent"));
    expect(page.textContent).toContain("Auto, in Everything you can access. Not used yet.");
    await act(async () => button("Remove Research agent").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: row.id }),
    );
    expect(page.textContent).not.toContain("Research agent");
    expect(page.textContent).not.toContain("Connected");
  });

  it("asks for Remote access before cloud agents, and shows a connection approved while setting up", async () => {
    host = new MockHostClient({
      latencyMs: 0,
      connectionConsent: {
        requestId: "r".repeat(43),
        clientName: "Terminal agent",
        redirectUri: "http://127.0.0.1:4999/cb",
        resource: "http://127.0.0.1:4315/internal/v1/mcp",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        workspaces: [],
      },
    });
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Turn on Remote access first"));
    expect(button("Add ChatGPT").disabled).toBe(true);
    await act(async () => button("Add Another agent").click());
    const dialog = document.querySelector('[role="dialog"]')!;
    // A Personal Host reached on its own computer offers its loopback address.
    expect(dialog.textContent).toContain("http://127.0.0.1:4315/internal/v1/mcp");
    expect(dialog.textContent).toContain("Waiting for Another agent to connect.");
    await act(async () => {
      await host!.dispatch({
        type: "connection.authorize",
        requestId: "r".repeat(43),
        idempotencyKey: "consent",
        decision: {
          kind: "approve",
          label: "Terminal agent",
          accessMode: "approval-required",
          reach: { kind: "user" },
        },
      });
    });
    await vi.waitFor(() => expect(dialog.textContent).toContain("Terminal agent is connected."));
  });
});
