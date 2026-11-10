import { expect, it, vi } from "vitest";
import { AgentCallerResolver } from "./agent-caller.js";

it("refuses Project capability families before trying any human authenticator or store", async () => {
  const authenticate = vi.fn(async () => {
    throw new Error("Human authenticator must not be tried");
  });
  const getThreadForOwner = vi.fn(async () => {
    throw new Error("Private state must not be read");
  });
  const workspaceMembershipForUser = vi.fn(async () => {
    throw new Error("Memberships must not be read");
  });
  const resolver = new AgentCallerResolver({
    store: { getThreadForOwner, workspaceMembershipForUser },
    runs: { authenticate },
    triggers: { authenticate },
    watches: { authenticate },
    connections: { authenticate },
  });
  for (const claims of [
    { aud: "opensteer-project-run-tools" },
    { aud: "opensteer-project-run-attachments" },
    { aud: "opensteer-project-egress" },
    { aud: "opensteer-project-run-tools", authority: null },
    {
      aud: "opensteer-run-tools",
      authority: { principal: { kind: "project" } },
      requestedBy: "a-human-root-is-not-the-executor",
    },
  ]) {
    const token = `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    await expect(resolver.authenticate(token)).rejects.toMatchObject({ code: "forbidden" });
  }
  expect(authenticate).not.toHaveBeenCalled();
  expect(getThreadForOwner).not.toHaveBeenCalled();
  expect(workspaceMembershipForUser).not.toHaveBeenCalled();
});
