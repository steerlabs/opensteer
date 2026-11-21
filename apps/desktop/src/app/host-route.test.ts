import { createId } from "@opensteer/core";
import {
  desktopHostStreamErrorRouteUrl,
  desktopHostTransportErrorHeader,
} from "@opensteer/protocol/desktop";
import { expect, it, vi } from "vitest";
import { forwardHostRoute } from "./host-route.js";

it("forwards only the bundled app's own requests, to a /v1 path under the Deployment they name", async () => {
  const forward = vi.fn(async () => new Response("forwarded"));
  const takeStreamError = vi.fn(async () => "deployment-changed" as const);
  const id = createId("deployment");
  const requestId = "00000000-0000-4000-8000-000000000001";
  const route = (url: string, initiatorOrigin?: string) =>
    forwardHostRoute(Object.assign(new Request(url), initiatorOrigin ? { initiatorOrigin } : {}), {
      forward,
      takeStreamError,
    });

  const accepted = await route(`app://opensteer/host/${id}/v1/rpc/x?input=1`, "app://opensteer");
  expect(await accepted.text()).toBe("forwarded");
  expect(forward).toHaveBeenCalledExactlyOnceWith(id, "/v1/rpc/x?input=1", expect.any(Request));

  const streamError = await route(desktopHostStreamErrorRouteUrl(requestId), "app://opensteer");
  expect(streamError.status).toBe(204);
  expect(streamError.headers.get(desktopHostTransportErrorHeader)).toBe("deployment-changed");
  expect(takeStreamError).toHaveBeenCalledExactlyOnceWith(requestId);
  expect((await route(desktopHostStreamErrorRouteUrl(requestId), "http://evil.test")).status).toBe(
    403,
  );
  expect((await route("app://opensteer/host/error/not-a-uuid", "app://opensteer")).status).toBe(
    404,
  );

  for (const initiator of [undefined, "null", "http://app.localhost:4310", "opensteer-app://view"])
    expect((await route(`app://opensteer/host/${id}/v1/rpc/x`, initiator)).status).toBe(403);
  for (const path of ["/internal/secrets", "/v1/%252e%252e/internal", "/.well-known/opensteer"])
    expect((await route(`app://opensteer/host/${id}${path}`, "app://opensteer")).status).toBe(404);
  expect(
    (await route("app://opensteer/host/not-a-deployment/v1/x", "app://opensteer")).status,
  ).toBe(404);
  expect(forward).toHaveBeenCalledOnce();
});
