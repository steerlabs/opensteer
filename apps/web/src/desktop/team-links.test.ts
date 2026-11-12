import type { DesktopTeamLink, DesktopTeamLinkDelivery } from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { joinedTeamPath } from "../team/join-route.js";
import { receiveDesktopTeamLinks, teamLinkPath } from "./team-links.js";

/*
 * How a link the desktop opened could go wrong: a link main replays before
 * this window listens is lost; one is opened twice when main resends it; it is
 * never acknowledged, so it reopens on every launch; leaving keeps main
 * thinking this window is ready; a joined team's channel waits behind the join
 * form, or an unknown team's link is taken for a joined one's.
 */

const channelId = createId("teamChannel");
const invite =
  "https://chat.acme.example/invite/aaaaaaaaaaaaaaaaaaaaaaaa#bbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const channel = `https://chat.acme.example/c/${channelId}`;

function fakeBridge() {
  const calls: (DesktopTeamLinkDelivery | "subscribed" | "unsubscribed")[] = [];
  let listener: ((link: DesktopTeamLink) => void) | null = null;
  const bridge = {
    onTeamLink: (next: (link: DesktopTeamLink) => void) => {
      listener = next;
      calls.push("subscribed");
      return () => {
        listener = null;
        calls.push("unsubscribed");
      };
    },
    teamLinkDelivery: vi.fn(async (input: DesktopTeamLinkDelivery) => {
      calls.push(input);
    }),
  };
  return { bridge, calls, deliver: (link: DesktopTeamLink) => listener?.(link) };
}

describe("receiveDesktopTeamLinks", () => {
  it("listens before it is ready, opens each link once and acknowledges it", () => {
    const { bridge, calls, deliver } = fakeBridge();
    const opened: string[] = [];
    const stop = receiveDesktopTeamLinks(bridge, (url) => opened.push(url));
    expect(calls).toEqual(["subscribed", { ready: true }]);

    const link = { id: crypto.randomUUID(), url: invite };
    deliver(link);
    deliver(link);
    expect(opened).toEqual([invite]);
    expect(calls.slice(2)).toEqual([
      { ready: true, acknowledgedId: link.id },
      { ready: true, acknowledgedId: link.id },
    ]);

    stop();
    expect(calls.slice(-2)).toEqual(["unsubscribed", { ready: false }]);
    deliver({ id: crypto.randomUUID(), url: channel });
    expect(opened).toEqual([invite]);
  });

  it("does nothing on a desktop that delivers no team links", () => {
    expect(() => receiveDesktopTeamLinks({}, () => undefined)()).not.toThrow();
  });
});

describe("joining from a delivered link", () => {
  const teams = [{ origin: "https://chat.acme.example", teamId: "tdp_acme" }];

  it("opens a joined team's channel or message at once, and leaves invites to the form", () => {
    expect(teamLinkPath(invite)).toBe(`/join?link=${encodeURIComponent(invite)}`);
    expect(joinedTeamPath(channel, teams)).toBe(`/teams/tdp_acme/c/${channelId}`);
    expect(joinedTeamPath(`${channel}/m/42`, teams)).toBe(`/teams/tdp_acme/c/${channelId}/m/42`);
    expect(joinedTeamPath(invite, teams)).toBeNull();
    expect(joinedTeamPath(`https://chat.other.example/c/${channelId}`, teams)).toBeNull();
  });
});
