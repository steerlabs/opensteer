import { expect, it, vi } from "vitest";
import { DesktopAppOriginPolicy } from "./navigation-policy.js";
import { createPublishedAppProtocolHandler } from "./published-app-protocol.js";
const path = `/v1/apps/app_11111111-1111-4111-8111-111111111111/dark/${"a".repeat(43)}/`;
const url = `opensteer-app://view${path}`;
it("adapts the same Host document through the selected transport and enforces the shared sandbox CSP", async () => {
  const streamApp = vi.fn(
    async () =>
      new Response("<!doctype html><h1>App</h1>", { headers: { "content-type": "text/html" } }),
  );
  const handle = createPublishedAppProtocolHandler({ streamApp });
  const response = await handle(new Request(url));
  expect(streamApp).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ method: "GET", headers: {}, path, signal: expect.any(AbortSignal) }),
  );
  expect(await response.text()).toContain("<h1>App");
  expect(response.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-popups",
  );
  expect(response.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  streamApp.mockClear();
  for (const bad of [
    url.replace("//view", "//other"),
    "opensteer-app://view/v1/rpc/bootstrap.get",
    url.replace("/dark/", "/wrong/"),
  ])
    expect((await handle(new Request(bad))).status).toBe(404);
  expect(streamApp).not.toHaveBeenCalled();
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

it("streams POST bodies and SSE without buffering, forwards HEAD and OPTIONS and refuses encoded path escapes", async () => {
  let received:
    | Parameters<import("../connections/host-transport.js").DesktopHostTransport["streamApp"]>[0]
    | undefined;
  const streamApp = vi.fn(
    async (
      input: Parameters<
        import("../connections/host-transport.js").DesktopHostTransport["streamApp"]
      >[0],
    ) => {
      received = input;
      return new Response(
        input.method === "HEAD"
          ? null
          : new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("data: first\n\n"));
              },
            }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream", "access-control-allow-origin": "*" },
        },
      );
    },
  );
  const handle = createPublishedAppProtocolHandler({ streamApp });
  const response = await handle(
    new Request(url + "api/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "secret",
        authorization: "Bearer secret",
      },
      body: '{"x":1}',
    }),
  );
  expect(received?.method).toBe("POST");
  expect(received?.headers).toEqual({ "content-type": "application/json" });
  expect(await new Response(received?.body).text()).toBe('{"x":1}');
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
  await reader.cancel();
  for (const method of ["HEAD", "OPTIONS"]) {
    const result = await handle(new Request(url, { method }));
    expect(result.status).toBe(200);
    expect(received?.method).toBe(method);
    await result.body?.cancel();
  }
  for (const rest of ["api/%2fsecret", "api/%5csecret", "api/%00secret", "api/%zz"])
    expect((await handle(new Request(url + rest))).status).toBe(404);
  expect(new DesktopAppOriginPolicy().allowsNavigation(url + "settings", url)).toBe(true);
  expect(new DesktopAppOriginPolicy().allowsNavigation(url.replace("/dark/", "/light/"), url)).toBe(
    false,
  );
});
