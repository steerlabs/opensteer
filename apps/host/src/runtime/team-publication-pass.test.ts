import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createId, type DeploymentId, type TeamAgentRequestId } from "@opensteer/core";
import type { PersonalTeamRequest } from "@opensteer/protocol";
import { DeadlineDrain, retryWithBackoff } from "./deadline-drain.js";
import { teamPublicationPass, type TeamPublicationPassOptions } from "./team-publication-pass.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const blockedTeam = createId("deployment");
const healthyTeam = createId("deployment");

function row(teamId: DeploymentId, index: number): PersonalTeamRequest {
  return {
    teamId,
    requestId: `tar_${String(index).padStart(8, "0")}` as TeamAgentRequestId,
  } as PersonalTeamRequest;
}

/** An in-memory stand-in for the owed query: sorted, filtered by team, keyset paged. */
function owedRows(rows: PersonalTeamRequest[]): TeamPublicationPassOptions["owed"] {
  return async ({ teamIds, after, limit }) =>
    rows
      .filter(({ teamId }) => teamIds.includes(teamId))
      .toSorted(
        (a, b) => a.teamId.localeCompare(b.teamId) || a.requestId.localeCompare(b.requestId),
      )
      .filter(
        (candidate) =>
          !after ||
          candidate.teamId > after.teamId ||
          (candidate.teamId === after.teamId && candidate.requestId > after.requestId),
      )
      .slice(0, limit);
}

describe("team publication pass", () => {
  it("publishes a deliverable row behind 150 that cannot be published this pass", async () => {
    // Blocked rows sort first: their own link is up but every attempt fails.
    const [early, late] = [blockedTeam, healthyTeam].toSorted();
    const rows = [...Array.from({ length: 150 }, (_, i) => row(early!, i)), row(late!, 0)];
    const recorded: PersonalTeamRequest[] = [];
    const outcome = await teamPublicationPass({
      readyTeams: () => [early!, late!],
      owed: owedRows(rows),
      reconcile: async (request) => {
        if (request.teamId === early) throw new Error("timeout");
        recorded.push(request);
        return true;
      },
      report: () => undefined,
    });
    expect(recorded).toEqual([row(late!, 0)]);
    // The blocked rows still owe a retry.
    expect(outcome).toBe(retryWithBackoff);
  });

  it("does not read rows whose link cannot publish now", async () => {
    const reconcile = vi.fn(async () => true);
    expect(
      await teamPublicationPass({
        readyTeams: () => [healthyTeam],
        owed: owedRows([
          ...Array.from({ length: 150 }, (_, i) => row(blockedTeam, i)),
          row(healthyTeam, 0),
        ]),
        reconcile,
        report: () => undefined,
      }),
    ).toBeNull();
    expect(reconcile.mock.calls).toEqual([[row(healthyTeam, 0)]]);
  });

  it.each([
    ["the read of owed work throws", "read"],
    ["recording throws", "reconcile"],
    ["recording is not finished", "pending"],
  ] as const)("re-arms with backoff when %s", async (_, failure) => {
    let failing = true;
    const reconcile = vi.fn(async () => {
      if (failing && failure === "reconcile") throw new Error("timeout");
      return !(failing && failure === "pending");
    });
    const owed = vi.fn(async () => {
      if (failing && failure === "read") throw new Error("database down");
      return [row(healthyTeam, 0)];
    });
    const drain = new DeadlineDrain({
      onError: () => undefined,
      drain: () =>
        teamPublicationPass({
          readyTeams: () => [healthyTeam],
          owed,
          reconcile,
          report: () => undefined,
        }),
    });
    drain.start();
    await drain.settled();
    expect(vi.getTimerCount()).toBe(1);
    failing = false;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(owed).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(owed).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await drain.close();
  });
});
