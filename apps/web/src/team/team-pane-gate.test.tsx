// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import {
  MockTeamHost,
  TeamSessionClient,
  createMemoryTeamPersistence,
} from "@opensteer/client/team";
import { TeamsProvider } from "./team-attachments.js";
import { TeamPaneGate } from "./team-pane-gate.js";
import { TeamRoutes } from "./team-routes.js";
import { MemoryRouter, Route, Routes } from "react-router";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
it("lets personal-web routes render their external-link fallback", async () => {
  const host = new MockTeamHost();
  const hostClient = {
    rpc: { "teams.links.list": async () => ({ ok: true, data: { links: [] } }) },
  } as unknown as HostClient;
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <TeamsProvider
          accountTeams={[{ teamDeploymentId: host.teamId, origin: host.origin, name: "Team" }]}
          surface={{ kind: "personal-web", hostClient }}
        >
          <TeamPaneGate teamId={host.teamId}>
            <a href={host.origin}>Open Team</a>
          </TeamPaneGate>
        </TeamsProvider>,
      ),
    );
    expect(node.querySelector("a")?.href).toBe(host.origin + "/");
    expect(node.textContent).not.toContain("Opening team");
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
it("re-enters team-web authentication from its recovery action", async () => {
  const host = new MockTeamHost();
  const session = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
  });
  const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <TeamsProvider
          surface={{
            kind: "team-web",
            attachment: {
              teamId: host.teamId,
              name: "Team",
              origin: host.origin,
              client: session,
              link: null,
              failure: "sign-in",
            },
          }}
        >
          <TeamPaneGate teamId={host.teamId}>
            <span>Team content</span>
          </TeamPaneGate>
        </TeamsProvider>,
      ),
    );
    await act(async () => session.remove("sign-in"));
    const signIn = [...node.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign in",
    )!;
    expect(signIn).toBeTruthy();
    await act(async () => signIn.click());
    expect(reload).toHaveBeenCalledOnce();
  } finally {
    act(() => root.unmount());
    session.dispose();
    host.dispose();
    reload.mockRestore();
  }
});
it("offers a personal-web team's own address from its landing route", async () => {
  const host = new MockTeamHost();
  const hostClient = {
    rpc: { "teams.links.list": async () => ({ ok: true, data: { links: [] } }) },
  } as unknown as HostClient;
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <TeamsProvider
          accountTeams={[{ teamDeploymentId: host.teamId, origin: host.origin, name: "Team" }]}
          surface={{ kind: "personal-web", hostClient }}
        >
          <MemoryRouter initialEntries={[`/teams/${host.teamId}`]}>
            <Routes>
              <Route path="teams/:teamId/*" element={<TeamRoutes />} />
            </Routes>
          </MemoryRouter>
        </TeamsProvider>,
      ),
    );
    expect(node.querySelector("a")?.href).toBe(host.origin + "/");
  } finally {
    act(() => root.unmount());
    host.dispose();
  }
});
it("gives a removed team-web reader invite guidance instead of a bare sign-in", async () => {
  const host = new MockTeamHost();
  const session = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
  });
  const node = document.createElement("div"),
    root = createRoot(node);
  try {
    await act(async () =>
      root.render(
        <TeamsProvider
          surface={{
            kind: "team-web",
            attachment: {
              teamId: host.teamId,
              name: "Team",
              origin: host.origin,
              client: session,
              link: null,
            },
          }}
        >
          <TeamPaneGate teamId={host.teamId}>{null}</TeamPaneGate>
        </TeamsProvider>,
      ),
    );
    await act(async () => session.remove("removed"));
    expect(node.textContent).toContain("Ask a team member for a new invite.");
    expect(node.textContent).not.toContain("Remove from this computer");
    expect([...node.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Retry",
    ]);
  } finally {
    act(() => root.unmount());
    session.dispose();
    host.dispose();
  }
});
