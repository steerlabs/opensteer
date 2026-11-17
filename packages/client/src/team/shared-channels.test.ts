import { describe, expect, it } from "vitest";
import { OpensteerError, UserIdSchema } from "@opensteer/core";
import {
  mergeTeamPeople,
  teamPeopleDirectory,
  channelShareView,
  pendingSendView,
} from "./shared-channels.js";

const remoteId = UserIdSchema.parse("usr_00000000-0000-4000-8000-000000000099");
const remote = {
  name: "Maya",
  handle: "maya-partner",
  homeTeamName: "Acme",
  external: true as const,
};

describe("shared channel presentation", () => {
  it("merges response people by principal and excludes partner image URLs and member authority", () => {
    const unsafe = { ...remote, image: "https://tracker.example/photo" };
    const first = mergeTeamPeople({}, { [remoteId]: unsafe });
    expect(mergeTeamPeople(first, { [remoteId]: remote })).toBe(first);
    const changed = mergeTeamPeople(first, { [remoteId]: { ...remote, name: "Maya Chen" } });
    expect(Object.keys(changed)).toEqual([remoteId]);
    const person = teamPeopleDirectory([], changed).get(remoteId);
    expect(person).toEqual({
      userId: remoteId,
      displayName: "Maya Chen",
      handle: "maya-partner",
      image: null,
      externalTeam: "Acme",
    });
    expect(person).not.toHaveProperty("role");
    const local = { userId: remoteId, displayName: "Local Maya", handle: "maya", image: null };
    expect(
      teamPeopleDirectory([local], {}, { [remoteId]: "maya-on-this-share" }).get(remoteId)?.handle,
    ).toBe("maya-on-this-share");
    expect(local.handle).toBe("maya");
  });

  it("keeps an owner channel usable and explains a follower's archive", () => {
    const share = {
      teamId: "dep_00000000-0000-4000-8000-000000000099",
      teamName: "Acme",
      state: "disconnected" as const,
      role: "follower" as const,
    };
    expect(channelShareView(share)?.detail).toContain("read-only archive");
    expect(channelShareView({ ...share, role: "owner" })?.detail).toContain("continues");
    expect(channelShareView({ ...share, state: "shared" })?.label).toBe("Shared with Acme");
    expect(channelShareView(undefined)).toBeNull();
  });

  it("keeps uncommitted sends pending and names an unreachable partner", () => {
    expect(pendingSendView({ failure: null }, true, null)).toEqual({ kind: "sending" });
    expect(pendingSendView({ failure: null }, false, null)).toEqual({ kind: "queued" });
    expect(pendingSendView({ failure: "Access changed" }, true, null)).toEqual({
      kind: "failed",
      reason: "Access changed",
    });
    const error = new OpensteerError({
      code: "conflict",
      reason: "partner-unreachable",
      retryable: true,
      message: "Retry",
    });
    expect(pendingSendView({ failure: null }, true, { error, teamName: "Acme" })).toEqual({
      kind: "retryable",
      reason: "Can't reach Acme right now.",
    });
  });
});
