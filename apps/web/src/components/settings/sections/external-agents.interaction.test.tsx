// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { UserIdSchema } from "@opensteer/core";
import { MockHostClient } from "@opensteer/client/mock";
import type { AgentConnection } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedAgentsSection } from "./connected-agents.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
});
describe("Connected agents in web and desktop Settings", () => {
  it("shows consent scope and expiry and revokes the selected connection", async () => {
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
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ConnectedAgentsSection client={host!} />));
    expect(container.textContent).toContain("Research agent");
    expect(container.textContent).toContain("Everything you can access");
    expect(container.textContent).toContain("Never used");
    expect(container.textContent).toContain("Expires");
    const revoke = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Revoke Research agent",
    )!;
    await act(async () => revoke.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: row.id }),
    );
    expect(container.textContent).toContain("No connected agents.");
  });
  it("keeps a load error visible and offers an explicit refresh", async () => {
    host = new MockHostClient({ latencyMs: 0 });
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(host.rpc["connections.list"]).mockRejectedValueOnce(new Error("offline")),
      configurable: true,
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<ConnectedAgentsSection client={host!} />));
    expect(container.textContent).toContain("Connected agents could not be loaded.");
    expect(container.textContent).not.toContain("No connected agents.");
    const refresh = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Refresh connected agents",
    )!;
    await act(async () => refresh.click());
    expect(container.textContent).toContain("No connected agents.");
  });
});
