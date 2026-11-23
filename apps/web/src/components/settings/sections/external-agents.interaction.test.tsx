// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { MockHostClient } from "@opensteer/client/mock";
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

describe("Connected agents: adding an agent", () => {
  it("keeps a failed first load visible and recovers on an explicit retry", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(host.rpc["connections.list"]).mockRejectedValueOnce(new Error("offline")),
      configurable: true,
    });
    const page = await mount(host);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Couldn't load your connected agents."),
    );
    expect(button("Add Another agent").disabled).toBe(true);
    const retry = [...page.querySelectorAll("button")].find((b) => b.textContent === "Try again")!;
    await act(async () => retry.click());
    await vi.waitFor(() => expect(button("Add Another agent").disabled).toBe(false));
    expect(page.textContent).not.toContain("Couldn't load your connected agents.");
  });

  it("waits for the initial connection list before taking the setup baseline", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    let finish:
      | ((value: Awaited<ReturnType<NonNullable<typeof host>["rpc"]["connections.list"]>>) => void)
      | undefined;
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
      configurable: true,
    });
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Turn on Remote access first"));
    expect(button("Add Another agent").disabled).toBe(true);
    await act(async () => finish!({ ok: true, data: { connections: [] } }));
    expect(button("Add Another agent").disabled).toBe(false);
    await act(async () => button("Add Another agent").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Waiting for Another agent",
    );
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
      },
    });
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Turn on Remote access first"));
    expect(button("Add ChatGPT").disabled).toBe(true);
    expect(button("Add Perplexity").disabled).toBe(true);
    expect(button("Add Claude Code").disabled).toBe(false);
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
        },
      });
    });
    await vi.waitFor(() => expect(dialog.textContent).toContain("“Terminal agent” is connected."));
  });
});
