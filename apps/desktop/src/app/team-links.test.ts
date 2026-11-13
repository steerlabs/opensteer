import { createId, parseTeamPageLink, teamPageAppLink } from "@opensteer/core";
import { OAuthDeepLinkBroker } from "@opensteer/client/auth";
import type { DesktopTeamLink } from "@opensteer/protocol/desktop";
import { expect, it, vi } from "vitest";
import { DesktopTeamLinks } from "./team-links.js";
import { DesktopWebLinks, routeDesktopUrl } from "./web-links.js";

const scheme = "com.opensteer.opensteer";
function appLink(page: string): string {
  return teamPageAppLink(parseTeamPageLink(page)!, "desktop");
}

it("retains a first-join invite and its verifier fragment through a cold launch and renderer reload", () => {
  const page = `https://new-team.example/invite/${"s".repeat(24)}#${"v".repeat(32)}`;
  const links = new DesktopTeamLinks();
  expect(links.accept(appLink(page))).toBe(true);
  const received: DesktopTeamLink[] = [];
  const detach = links.attach((link) => received.push(link));
  expect(received[0]!.url).toBe(page);
  detach();
  links.attach((link) => received.push(link));
  expect(received[1]).toEqual(received[0]);
  links.acknowledge("wrong");
  links.acknowledge(received[0]!.id);
  links.attach((link) => received.push(link));
  expect(received).toHaveLength(2);
});

it("hands unknown-team channel and message/thread targets to the renderer without a catalog lookup", () => {
  const channel = createId("teamChannel");
  const pages = [
    `https://unknown.example/c/${channel}`,
    `https://unknown.example/c/${channel}/m/42`,
  ];
  const links = new DesktopTeamLinks();
  const received: DesktopTeamLink[] = [];
  links.attach((link) => received.push(link));
  for (const page of pages) expect(links.accept(appLink(page))).toBe(true);
  expect(received[0]!.url).toBe(pages[0]);
  links.acknowledge(received[0]!.id);
  expect(received[1]!.url).toBe(pages[1]);
});

it("rejects the wrong scheme, credentials, non-HTTPS pages and malformed targets", () => {
  const channel = createId("teamChannel");
  const links = new DesktopTeamLinks();
  for (const raw of [
    appLink(`https://team.example/c/${channel}`).replace(scheme, "another.app"),
    `${scheme}:/team?url=${encodeURIComponent(`http://team.example/c/${channel}`)}`,
    `${scheme}:/team?url=${encodeURIComponent(`https://user:secret@team.example/c/${channel}`)}`,
    `${scheme}:/team?url=${encodeURIComponent("https://team.example/invite/missing-verifier")}`,
    `${scheme}://team?url=${encodeURIComponent(`https://team.example/c/${channel}`)}`,
  ])
    expect(links.accept(raw)).toBe(false);
});

it("keeps OAuth callbacks separate from team handoffs", async () => {
  const teams = new DesktopTeamLinks();
  const oauth = new OAuthDeepLinkBroker({
    application: "desktop",
    clientId: "opensteer-desktop",
    accountCallback: `${scheme}:/oauth/account-callback`,
    hostCallback: `${scheme}:/oauth/host-callback`,
  });
  const handle = vi.fn(async () => true);
  oauth.attach(handle);
  const web = new DesktopWebLinks(vi.fn());
  const callback = `${scheme}:/oauth/host-callback?code=fixture&state=fixture`;
  try {
    expect(teams.accept(callback)).toBe(false);
    expect(routeDesktopUrl(callback, oauth, web, teams)).toBe(true);
    await oauth.settled();
    expect(handle).toHaveBeenCalledExactlyOnceWith(callback);
    const receive = vi.fn();
    teams.attach(receive);
    const page = `https://team.example/c/${createId("teamChannel")}/m/100`;
    expect(routeDesktopUrl(appLink(page), oauth, web, teams)).toBe(true);
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ url: page }));
    expect(handle).toHaveBeenCalledTimes(1);
  } finally {
    web.dispose();
  }
});
