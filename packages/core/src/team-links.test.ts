import { describe, expect, it } from "vitest";
import {
  KnowledgeTopicIdSchema,
  KnowledgeNoteIdSchema,
  TeamMessageIdSchema,
  TeamChannelIdSchema,
} from "./ids.js";
import { DeploymentIdSchema, TeamNoticeIdSchema } from "./ids.js";
import {
  parseTeamPageLink,
  teamPageUrl,
  parseTeamPageAppLink,
  teamPageAppLink,
  parseTeamNoticeAppLink,
  TeamOriginSchema,
  teamNoticeAppLink,
} from "./team-links.js";

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

it("round-trips thread and knowledge targets through public and native links", () => {
  const channelId = TeamChannelIdSchema.parse("tch_12345678-1234-4234-8234-123456789abc");
  const topicId = KnowledgeTopicIdSchema.parse("ktp_12345678-1234-4234-8234-123456789abc");
  const noteId = KnowledgeNoteIdSchema.parse("knt_12345678-1234-4234-8234-123456789abc");
  const root = TeamMessageIdSchema.parse("123"),
    reply = TeamMessageIdSchema.parse("124");
  for (const target of [
    { kind: "thread", channelId, threadRootId: root },
    { kind: "thread", channelId, threadRootId: root, messageId: reply },
    { kind: "knowledge-topic", topicId },
    { kind: "knowledge-note", topicId, noteId },
  ] as const) {
    const page = { origin: "https://team.example", target };
    expect(parseTeamPageLink(teamPageUrl(page))).toEqual(page);
    expect(parseTeamPageAppLink(teamPageAppLink(page, "desktop"), "desktop")).toEqual(page);
  }
  const note = teamPageUrl({
    origin: "https://team.example",
    target: { kind: "knowledge-note", topicId, noteId },
  });
  for (const invalid of [
    note + "&note=" + noteId,
    note + "&other=1",
    note + "#fragment",
    note.replace(noteId, "knt_invalid"),
    note.replace("https://", "https://user:secret@"),
    "https://team.example/c/" + channelId + "/t/0",
  ])
    expect(parseTeamPageLink(invalid)).toBeNull();
});
