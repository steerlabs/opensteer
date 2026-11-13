import { expect, it } from "vitest";
import { statusFace } from "./status-words.js";
import type { AgentCardView, AgentStatusView, PersonView } from "./team-models.js";

const maya: PersonView = {
  avatarUri: null,
  handle: "maya",
  id: "maya",
  name: "Maya Chen",
  presence: null,
};
const states: readonly AgentStatusView[] = [
  { askedAt: "10:55", computer: "Maya's Mac", lastSeen: "8:10", state: "offline" },
  { ahead: 2, state: "queued" },
  { liveStep: "browsed", startedAt: 0, state: "working", stepCount: 3 },
  { ask: null, state: "needs-owner" },
  { cause: null, state: "failed" },
  { by: "Maya", state: "stopped", stepCount: 2 },
  { state: "blocked" },
];

it("gives only the owner a control or a way into the private task, in every state", () => {
  for (const status of states) {
    const card = (mine: boolean): AgentCardView => ({
      agent: { byline: mine ? "Your agent" : "Maya's agent", mine, owner: maya },
      id: "request",
      status,
      version: 1,
    });
    const others = statusFace(card(false), 120_000);
    expect(others.action, status.state).toBeNull();
    expect(others.opensTask, status.state).toBe(false);
    expect(statusFace(card(true), 120_000).opensTask, status.state).toBe(true);
  }
  // The team has no retry: a failed card opens its task instead.
  const failed = statusFace(
    {
      agent: { byline: "Your agent", mine: true, owner: maya },
      id: "r",
      status: states[4]!,
      version: 1,
    },
    120_000,
  );
  expect(failed.action).toBeNull();
  const working = statusFace(
    {
      agent: { byline: "Your agent", mine: true, owner: maya },
      id: "r",
      status: states[2]!,
      version: 1,
    },
    120_000,
  );
  expect(working.action?.kind).toBe("stop");
  expect(working.meta).toBe("3 steps · 2m");
});
