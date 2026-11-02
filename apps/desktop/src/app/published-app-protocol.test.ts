import { expect, it, vi } from "vitest";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";
import { createPublishedAppProtocolHandler } from "./published-app-protocol.js";
const path = `/v1/apps/app_11111111-1111-4111-8111-111111111111/content?token=${"a".repeat(43)}&theme=dark`;
const url = `opensteer-app://view${path}`;
it("adapts the same Host document through the selected transport and enforces the shared sandbox CSP", async () => {
  const request = vi.fn(async () => ({
    status: 200,
    headers: { contentType: "text/html" },
    body: "<!doctype html><h1>App</h1>",
  }));
  const handle = createPublishedAppProtocolHandler({ request });
  const response = await handle(new Request(url));
  expect(request).toHaveBeenCalledExactlyOnceWith({ method: "GET", headers: {}, path });
  expect(await response.text()).toContain("<h1>App");
  expect(response.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-popups",
  );
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  request.mockClear();
  for (const bad of [
    url.replace("//view", "//other"),
    "opensteer-app://view/v1/rpc/bootstrap.get",
    url.replace("?token=", "?other="),
  ])
    expect((await handle(new Request(bad))).status).toBe(404);
  expect(request).not.toHaveBeenCalled();
});
it("admits CDN presentation resources only inside an app frame and keeps UI and Host network boundaries", () => {
  const policy = new DesktopAppOriginPolicy();
  expect(policy.allowsNavigation(url)).toBe(false);
  expect(policy.allowsNetworkRequest(url)).toBe(true);
  expect(policy.allowsNetworkRequest(url + "#chart")).toBe(true);
  expect(policy.allowsNetworkRequest("https://cdn.test/chart.js")).toBe(false);
  expect(
    policy.allowsNetworkRequest("https://cdn.test/chart.js", { url, resourceType: "script" }),
  ).toBe(true);
  for (const resourceType of ["xhr", "webSocket", "subFrame"])
    expect(
      policy.allowsNetworkRequest("https://host.test/v1/rpc/bootstrap.get", { url, resourceType }),
    ).toBe(false);
  expect(
    policy.allowsNetworkRequest("https://cdn.test/chart.js", {
      url: "app://opensteer/",
      resourceType: "script",
    }),
  ).toBe(false);
});
