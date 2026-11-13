import { describe, expect, it } from "vitest";
import { DeploymentIdSchema, TeamNoticeIdSchema } from "./ids.js";
import { parseTeamNoticeAppLink, TeamOriginSchema, teamNoticeAppLink } from "./team-links.js";

const scheme = "com.opensteer.mobile";
const notice = {
  origin: "https://team.example.com",
  teamId: DeploymentIdSchema.parse("dep_00000000-0000-4000-8000-000000000001"),
  noticeId: TeamNoticeIdSchema.parse("tnt_00000000-0000-4000-8000-000000000001"),
};

describe("team notice app links", () => {
  it("round-trips the exact notice and registered application", () => {
    expect(parseTeamNoticeAppLink(teamNoticeAppLink(notice, scheme), scheme)).toEqual(notice);
    expect(
      parseTeamNoticeAppLink(teamNoticeAppLink(notice, scheme), "com.opensteer.opensteer"),
    ).toBeNull();
  });

  it.each([
    "&origin=https%3A%2F%2Fevil.example.com",
    "&teamId=dep_00000000-0000-4000-8000-000000000002",
    "&noticeId=tnt_00000000-0000-4000-8000-000000000002",
    "&extra=value",
    "#fragment",
    "#",
  ])("refuses ambiguous or extended targets: %s", (suffix) => {
    expect(parseTeamNoticeAppLink(teamNoticeAppLink(notice, scheme) + suffix, scheme)).toBeNull();
  });

  it.each([
    { ...notice, origin: "http://team.example.com" },
    { ...notice, origin: "https://team.example.com/path" },
    { ...notice, origin: "https://reader@team.example.com" },
    { ...notice, teamId: "invalid" },
    { ...notice, noticeId: "invalid" },
  ])("refuses an invalid notice target: %j", (input) => {
    const value = `${scheme}:/team-notice?${new URLSearchParams(input)}`;
    expect(parseTeamNoticeAppLink(value, scheme)).toBeNull();
  });

  it("refuses a network authority or malformed URL", () => {
    expect(
      parseTeamNoticeAppLink(teamNoticeAppLink(notice, scheme).replace(":/", "://host/"), scheme),
    ).toBeNull();
    expect(parseTeamNoticeAppLink("invalid", scheme)).toBeNull();
  });
});

describe("team origins", () => {
  it("fails a value that is not a URL instead of throwing", () => {
    expect(TeamOriginSchema.safeParse("not a url").success).toBe(false);
    expect(TeamOriginSchema.safeParse("https://team.example.com").success).toBe(true);
  });
});
