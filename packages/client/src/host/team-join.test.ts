import { describe, expect, it } from "vitest";
import { HostClientRequestError } from "./client.js";
import { openTeamJoin } from "./team-join.js";

const selector = "mockTeamInviteSelector0000000001";
const verifier = "mockTeamInviteVerifier000000000000000000001";
const open = {
  state: "open",
  teamName: "Acme",
  inviterName: "Maya Chen",
  emailMasked: "n•••@acme.example",
  kind: "full",
  expiresAt: "2026-11-16T17:00:00.000Z",
  signIn: {},
} as const;

/** The Host as a browser sees it: the exchange sets an HttpOnly proof cookie it keeps. */
function host() {
  const calls: { name: string; input: unknown }[] = [];
  let proof = false;
  return {
    calls,
    team: {
      invitationExchange: async (input: unknown) => {
        calls.push({ name: "exchange", input });
        proof = true;
        return { preview: open };
      },
      invitationPreview: async (input: unknown) => {
        calls.push({ name: "preview", input });
        return open;
      },
      invitationAccept: async () => {
        calls.push({ name: "accept", input: {} });
        if (!proof)
          throw new HostClientRequestError({
            code: "conflict",
            message: "No proof.",
            reason: "invite-unavailable",
            status: 409,
          });
        return {} as never;
      },
    } as never,
  };
}

describe("the invite page across a sign-in round trip", () => {
  it("joins on the signed-in return without the erased verifier", async () => {
    const { calls, team } = host();
    expect(await openTeamJoin(team, { selector, verifier, authenticated: false })).toMatchObject({
      kind: "sign-in",
    });
    // Sign-in navigates away and back: the page remounts with no fragment.
    expect(await openTeamJoin(team, { selector, verifier: null, authenticated: true })).toEqual({
      kind: "joined",
    });
    expect(calls.map(({ name }) => name)).toEqual(["exchange", "preview", "accept"]);
    expect(JSON.stringify(calls.slice(1))).not.toContain(verifier);
  });

  it("says the link is incomplete when this browser holds no proof", async () => {
    const { team } = host();
    expect(
      await openTeamJoin(team, { selector, verifier: null, authenticated: true }),
    ).toMatchObject({ kind: "missing-link" });
    expect(
      await openTeamJoin(team, { selector, verifier: null, authenticated: false }),
    ).toMatchObject({ kind: "missing-link" });
  });
});
