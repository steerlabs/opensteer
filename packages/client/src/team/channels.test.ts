import { createId, TeamChannelIdSchema, UserIdSchema } from "@opensteer/core";
import { TeamCommandSchema, teamChannelNameTakenReason } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import {
  browsableChannels,
  channelNamed,
  isChannelNameTaken,
  newChannelCommand,
  pickablePeople,
} from "./channels.js";

const channel = (name: string, kind = "public", archived = false) => ({
  name,
  kind: kind as "public" | "private" | "dm" | "group_dm",
  archivedAt: archived ? "2026-01-01T00:00:00.000Z" : null,
});
const person = (displayName: string, state: "active" | "removed" = "active") => ({
  userId: createId("user"),
  displayName,
  handle: displayName.split(" ")[0]!.toLowerCase(),
  state,
});

describe("a new channel's name", () => {
  it("matches a live channel the way the team keeps names unique", () => {
    const channels = [channel("Général"), channel("old", "public", true)];
    expect(channelNamed(channels, "  #GÉNÉRAL ")).toBe(channels[0]);
    expect(channelNamed(channels, "old")).toBeNull();
    expect(channelNamed(channels, "#")).toBeNull();
  });

  it("recognises the team's refusal of a taken name and nothing else", () => {
    expect(isChannelNameTaken({ code: "conflict", reason: teamChannelNameTakenReason })).toBe(true);
    expect(isChannelNameTaken({ code: "conflict", reason: "knowledge-note-changed" })).toBe(false);
    expect(isChannelNameTaken(new Error("conflict"))).toBe(false);
  });
});

describe("the create a new channel form sends", () => {
  const id = TeamChannelIdSchema.parse(createId("teamChannel"));
  const ana = UserIdSchema.parse(createId("user"));

  it("starts a private channel with the people chosen, and a public one open", () => {
    const made = newChannelCommand({
      id,
      name: " #launch ",
      isPrivate: true,
      peopleOnly: true,
      people: [ana],
    });
    expect(TeamCommandSchema.parse(made)).toEqual({
      type: "team.channel.create",
      id,
      kind: "private",
      name: "launch",
      peopleOnly: true,
      access: [{ subject: { kind: "person", userId: ana }, level: "post", manage: false }],
    });
    expect(
      newChannelCommand({ id, name: "launch", isPrivate: false, peopleOnly: false, people: [ana] }),
    ).toMatchObject({ kind: "public", access: [] });
  });
});

describe("browsing channels", () => {
  it("leaves out direct messages and puts names that start with the search first", () => {
    const shown = browsableChannels(
      [
        channel("design-ops"),
        channel("ops", "private"),
        channel("dm", "dm"),
        channel("ops-archive", "public", true),
        channel("Alpha"),
      ],
      "#OPS",
    );
    expect(shown.map((row) => row.name)).toEqual(["ops", "design-ops", "ops-archive"]);
    expect(browsableChannels([channel("b"), channel("A")], "").map((row) => row.name)).toEqual([
      "A",
      "b",
    ]);
  });
});

describe("picking people", () => {
  it("offers active people other than the reader, by name or @handle", () => {
    const me = person("Ana Me");
    const people = [me, person("Ivan Petrov"), person("Ana Park"), person("Andy Gone", "removed")];
    const names = (query: string) =>
      pickablePeople(people, me.userId, query).map((row) => row.displayName);
    expect(names("an")).toEqual(["Ana Park", "Ivan Petrov"]);
    expect(names("@ivan")).toEqual(["Ivan Petrov"]);
  });
});
