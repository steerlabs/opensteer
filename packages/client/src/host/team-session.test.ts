import { describe, expect, it, vi } from "vitest";
import type { HostClient, HostSnapshot } from "./client.js";
import { TeamSession } from "./team-session.js";

const deploymentA = "dep_00000000-0000-4000-8000-0000000000e1";
const deploymentB = "dep_00000000-0000-4000-8000-0000000000e2";

function summary(name: string, project: string) {
  return {
    revision: `rev-${name}`,
    accessRevision: 1,
    team: { id: deploymentA, name: "Acme" },
    me: { id: name, kind: "full", state: "active", administrator: true },
    projects: [{ id: project, name: project }],
    needsYou: 0,
    can: {},
  };
}

/** A Host client whose signed-in viewer can be replaced in place, as the real one allows. */
function fakeHost() {
  let snapshot = {
    teamAdministrationAvailable: true,
    session: "authenticated",
    deploymentId: deploymentA,
    sessionId: "session-a",
    user: { id: "viewer-a" },
  } as unknown as HostSnapshot;
  const listeners = new Set<() => void>();
  const requests: { viewer: string; resolve: () => void }[] = [];
  const host = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch: async () => {
      throw new Error("not used");
    },
    rpc: {
      "team.summary.get": () => {
        const viewer = snapshot.user!.id;
        return new Promise((resolve) =>
          requests.push({
            viewer,
            resolve: () =>
              resolve({
                ok: true,
                data: summary(viewer, viewer === "viewer-a" ? "A's secret project" : "B's project"),
              }),
          }),
        );
      },
    },
  } as unknown as HostClient;
  const set = (patch: Partial<HostSnapshot>) => {
    snapshot = { ...snapshot, ...patch } as HostSnapshot;
    for (const listener of listeners) listener();
  };
  return { host, requests, set };
}

const deadline = { timeout: 2000 };

describe("team data follows who is signed in", () => {
  it("never shows viewer A's team to viewer B on the same client, and reads B's afresh", async () => {
    const { host, requests, set } = fakeHost();
    const session = new TeamSession(host);
    const seen: (string | undefined)[] = [];
    session.subscribe(() => seen.push(session.getState().summary?.me.id));
    session.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1), deadline);
    requests.shift()!.resolve();
    await vi.waitFor(
      () => expect(session.getState().summary?.projects[0]?.name).toBe("A's secret project"),
      deadline,
    );
    session.holdLink("invite-a", "https://acme.example/join/a#secret");

    set({ session: "authentication-required", user: null });
    expect(session.getState()).toMatchObject({ summary: null, team: null, links: new Map() });

    seen.length = 0;
    set({ session: "authenticated", user: { id: "viewer-b" } as never, sessionId: "session-b" });
    expect(session.getState().summary).toBeNull();
    expect(session.getState().links.size).toBe(0);
    await vi.waitFor(
      () => expect(requests.map(({ viewer }) => viewer)).toEqual(["viewer-b"]),
      deadline,
    );
    requests.shift()!.resolve();
    await vi.waitFor(
      () => expect(session.getState().summary?.projects[0]?.name).toBe("B's project"),
      deadline,
    );
    expect(seen).not.toContain("viewer-a");
  });

  it("ignores a read still in flight for the previous viewer or Deployment", async () => {
    const { host, requests, set } = fakeHost();
    const session = new TeamSession(host);
    const seen: (string | undefined)[] = [];
    session.subscribe(() => seen.push(session.getState().summary?.me.id));
    session.start();
    await vi.waitFor(() => expect(requests).toHaveLength(1), deadline);
    const late = requests.shift()!;
    set({ deploymentId: deploymentB, user: { id: "viewer-b" } as never });
    await vi.waitFor(() => expect(requests).toHaveLength(1), deadline);
    late.resolve();
    requests.shift()!.resolve();
    await vi.waitFor(() => expect(session.getState().summary?.me.id).toBe("viewer-b"), deadline);
    expect(seen).not.toContain("viewer-a");
  });
});
