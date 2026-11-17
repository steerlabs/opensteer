import type { ClientConnectionState } from "@opensteer/client/connections";
import { expect, it, vi } from "vitest";

vi.mock("../ui/connection-pill.js", () => ({}));
const { teamPillNotice } = await import("./team-connection-pill.js");

const base: ClientConnectionState = {
  phase: "recovering",
  network: "online",
  visibility: "foreground",
  scope: null,
  epoch: 1,
  readyRevision: 1,
  showInterruption: true,
  issue: { code: "connection", reason: "unreachable" },
  trying: false,
  pathRevision: 0,
  lastConnectedAt: null,
  name: "team.example.com",
  target: "team",
  route: null,
};
const actions = { retry: vi.fn(), signIn: vi.fn() };

it("speaks for the foreground team by its name, and only while its content is shown", () => {
  const notice = teamPillNotice({ name: "Acme", state: "live" }, base, true, actions);
  expect(notice?.label).toBe("Can't reach Acme");
  notice?.action?.onPress();
  expect(actions.retry).toHaveBeenCalledOnce();
  // Inside the hold, recovered, or behind the team's gate: nothing.
  expect(
    teamPillNotice(
      { name: "Acme", state: "live" },
      { ...base, showInterruption: false },
      true,
      actions,
    ),
  ).toBeNull();
  expect(teamPillNotice({ name: "Acme", state: "live" }, base, false, actions)).toBeNull();
  expect(teamPillNotice({ name: "Acme", state: "removed" }, base, true, actions)).toBeNull();
  expect(
    teamPillNotice(
      { name: "Acme", state: "live" },
      { ...base, phase: "blocked", issue: { code: "update-server" } },
      true,
      actions,
    )?.label,
  ).toBe("Acme's server needs an update");
});
