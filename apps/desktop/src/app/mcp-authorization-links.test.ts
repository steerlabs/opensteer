import { createId } from "@opensteer/core";
import { agentConnectionDeepLink } from "@opensteer/protocol";
import { desktopExternalUrlAllowed } from "@opensteer/protocol/desktop";
import { describe, expect, it, vi } from "vitest";
import { McpAuthorizationLinks } from "./mcp-authorization-links.js";

const target = { deploymentId: createId("deployment"), requestId: "r".repeat(43) };
const scheme = "com.opensteer.opensteer";
describe("MCP consent navigation", () => {
  it("queues only a request target until the signed-in desktop surface is ready", () => {
    const links = new McpAuthorizationLinks(scheme);
    expect(links.accept(agentConnectionDeepLink(scheme, target))).toBe(true);
    const consume = vi.fn();
    const stop = links.attach(consume);
    expect(consume).toHaveBeenCalledExactlyOnceWith(target);
    stop();
    links.clear(target.requestId);
    expect(links.pending).toBe(false);
    links.accept(agentConnectionDeepLink(scheme, target));
    expect(consume).toHaveBeenCalledTimes(1);
  });
  it("refuses foreign schemes, repeated fields, Host URLs and credential-bearing links", () => {
    const links = new McpAuthorizationLinks(scheme);
    const good = agentConnectionDeepLink(scheme, target);
    for (const value of [
      agentConnectionDeepLink("com.steerlabs.opensteer.beta", target),
      good + "&requestId=" + target.requestId,
      good + "&url=https://evil.example",
      good + "#credential",
      good.replace(":/", "://evil.example/"),
    ])
      expect(links.accept(value)).toBe(false);
    expect(links.pending).toBe(false);
  });
  it("does not retain a navigation target past consent expiry", () => {
    let now = 0;
    const links = new McpAuthorizationLinks(scheme, () => now);
    links.accept(agentConnectionDeepLink(scheme, target));
    now = 10 * 60_000 + 1;
    const consume = vi.fn();
    links.attach(consume);
    expect(consume).not.toHaveBeenCalled();
    expect(links.pending).toBe(false);
  });
  it("opens only the request-bound MCP finish path on loopback", () => {
    const finish = `http://127.0.0.1:4310/oauth/mcp/complete?request=${target.requestId}`;
    expect(desktopExternalUrlAllowed(finish)).toBe(true);
    for (const value of [
      finish + "&url=https://evil.example",
      finish + "#extra",
      finish.replace("127.0.0.1", "private.example"),
      finish.replace("complete", "token"),
      finish.replace(target.requestId, "short"),
    ])
      expect(desktopExternalUrlAllowed(value)).toBe(false);
  });
});
