import { expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
const electron = vi.hoisted(() => ({ fromPartition: vi.fn(), WebSocket: vi.fn() }));
vi.mock("electron", () => ({
  session: { fromPartition: electron.fromPartition },
  net: { WebSocket: electron.WebSocket },
}));
import { ElectronHostNetwork } from "./electron-host-network.js";

it("forwards a capability app upload as a stream with its Accept header, omitted credentials and manual redirects", async () => {
  const fetch = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response("event", { headers: { "content-type": "text/event-stream" } }),
  );
  electron.fromPartition.mockReturnValue({
    fetch,
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    on: vi.fn(),
  });
  const network = new ElectronHostNetwork();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2]));
      c.close();
    },
  });
  const signal = new AbortController().signal;
  const response = await network.request({
    authorization: null,
    canonicalOrigin: "https://host",
    requestOrigin: "https://route",
    deploymentId: createId("deployment"),
    url: "https://route/v1/apps/app/dark/token/",
    signal,
    request: {
      method: "POST",
      path: "/v1/apps/app/dark/token/",
      headers: { additional: { accept: "text/html", "content-type": "application/json" } },
      body,
      credentials: "omit",
      redirect: "manual",
    },
  });
  expect(fetch).toHaveBeenCalledWith(
    "https://route/v1/apps/app/dark/token/",
    expect.objectContaining({
      body,
      method: "POST",
      credentials: "omit",
      redirect: "manual",
      signal,
      headers: { accept: "text/html", origin: "https://route", "content-type": "application/json" },
    }),
  );
  expect(fetch.mock.calls[0]![1]).not.toHaveProperty("headers.authorization");
  expect(await response.text()).toBe("event");
});

it("forwards pinned team upgrade headers and its protected credential in the team partition", () => {
  electron.fromPartition.mockReturnValue({
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    getPreloadScripts: () => [],
    on: vi.fn(),
  });
  const addEventListener = vi.fn();
  electron.WebSocket.mockImplementation(function () {
    return { addEventListener, close: vi.fn(), send: vi.fn() };
  });
  const network = new ElectronHostNetwork();
  const deploymentId = createId("deployment");
  network.openWebSocket(
    {
      deploymentId,
      authorization: "Bearer protected-team-session",
      canonicalOrigin: "https://team.example",
      requestOrigin: "https://team.example",
      url: "wss://team.example/v1/realtime",
      headers: { "x-opensteer-team-api-version": "1" },
    },
    { open: vi.fn(), close: vi.fn(), error: vi.fn(), message: vi.fn() },
  );
  expect(electron.WebSocket).toHaveBeenCalledWith(
    "wss://team.example/v1/realtime",
    expect.objectContaining({
      headers: {
        "x-opensteer-team-api-version": "1",
        authorization: "Bearer protected-team-session",
      },
      origin: "https://team.example",
      useSessionCookies: true,
    }),
  );
  expect(electron.fromPartition).toHaveBeenCalledWith(`persist:opensteer-host-${deploymentId}`, {
    cache: true,
  });
});
