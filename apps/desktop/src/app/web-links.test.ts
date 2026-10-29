import { createId } from "@opensteer/core";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopWebLinks, routeDesktopUrl } from "./web-links.js";
import { OAuthDeepLinkBroker } from "@opensteer/client/auth";

afterEach(() => vi.useRealTimers());
it("validates web URLs before queueing and retains cold-launch links until acknowledged", () => {
  const links = new DesktopWebLinks(vi.fn());
  for (const url of [
    "file:///tmp/a",
    "https://viewer:secret@example.com/",
    `https://example.com/${"é".repeat(4090)}`,
    "javascript:alert(1)",
    "data:text/plain,a",
    "bad",
    "https://",
    `https://example.com/${"a".repeat(8192)}`,
  ])
    expect(links.accept(url)).toBe(false);
  expect(links.accept("https://example.com/a")).toBe(true);
  expect(links.accept("http://example.com/b")).toBe(true);
  const receive = vi.fn();
  const detach = links.attach(receive);
  expect(receive).toHaveBeenCalledTimes(1);
  const first = receive.mock.calls[0]![0];
  detach();
  links.attach(receive);
  expect(receive.mock.calls[1]![0]).toEqual(first);
  links.acknowledge("wrong");
  expect(receive).toHaveBeenCalledTimes(2);
  links.acknowledge(first.id);
  expect(receive.mock.calls[2]![0].url).toBe("http://example.com/b");
  links.acknowledge(receive.mock.calls[2]![0].id);
  links.dispose();
});
it("collapses duplicates for one second, caps pending links and reports overflow and waiting", () => {
  vi.useFakeTimers();
  const notice = vi.fn();
  const links = new DesktopWebLinks(notice);
  links.accept("https://example.com/0");
  links.accept("https://example.com/0");
  vi.advanceTimersByTime(1001);
  for (let i = 1; i < 21; i++) links.accept(`https://example.com/${i}`);
  expect(notice).toHaveBeenCalledWith(expect.stringContaining("20"));
  vi.advanceTimersByTime(15000);
  expect(notice).toHaveBeenCalledWith(expect.stringContaining("Personal"));
  const receive = vi.fn();
  links.attach(receive);
  for (let i = 0; i < 20; i++) {
    expect(receive.mock.calls[i]![0].url).toBe(`https://example.com/${i}`);
    links.acknowledge(receive.mock.calls[i]![0].id);
  }
  expect(receive).toHaveBeenCalledTimes(20);
  links.dispose();
});
it("leaves OAuth callbacks with the existing OAuth broker", async () => {
  const oauth = new OAuthDeepLinkBroker({
    application: "desktop",
    clientId: "opensteer-desktop",
    accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
    hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
  });
  const handle = vi.fn(async () => true);
  oauth.attach(handle);
  const links = new DesktopWebLinks(vi.fn());
  const url = "com.opensteer.opensteer:/oauth/account-callback?code=fixture&state=fixture";
  expect(routeDesktopUrl(url, oauth, links)).toBe(true);
  await oauth.settled();
  expect(handle).toHaveBeenCalledWith(url);
  const web = vi.fn();
  links.attach(web);
  expect(web).not.toHaveBeenCalled();
  links.dispose();
});
it("accepts the same destination again after the duplicate window", () => {
  vi.useFakeTimers();
  const links = new DesktopWebLinks(vi.fn());
  const receive = vi.fn();
  links.attach(receive);
  links.accept("https://example.com/");
  const first = receive.mock.calls[0]![0];
  links.acknowledge(first.id);
  links.accept("https://example.com/");
  expect(receive).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1001);
  links.accept("https://example.com/");
  expect(receive).toHaveBeenCalledTimes(2);
  expect(receive.mock.calls[1]![0].id).not.toBe(first.id);
  links.dispose();
});
it("keeps the first bound request across renderer reloads and rejects a different user scope", () => {
  const links = new DesktopWebLinks(vi.fn());
  links.accept("https://example.com/replay");
  const receive = vi.fn();
  const detach = links.attach(receive);
  const first = receive.mock.calls[0]![0];
  const original = {
    deploymentId: createId("deployment"),
    userId: createId("user"),
    identity: { kind: "guest" },
  } as const;
  expect(links.bind(first.id, original)?.request).toEqual(original);
  detach();
  links.attach(receive);
  expect(receive.mock.calls[1]![0].request).toEqual(original);
  expect(
    links.bind(first.id, {
      ...original,
      identity: { kind: "profile", profileId: createId("browserProfile") },
    })?.request,
  ).toEqual(original);
  expect(links.bind(first.id, { ...original, userId: createId("user") })).toBeNull();
  links.dispose();
});
