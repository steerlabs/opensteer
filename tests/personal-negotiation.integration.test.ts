import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { once } from "node:events";
import { it, expect } from "vitest";
import { createId } from "../packages/core/src/index.js";
import {
  apiCurrentQueryParameter,
  apiVersionHeaders,
  apiVersionQueryParameter,
  hostApiCurrentHeader,
  hostApiVersion,
  hostApiVersionHeader,
  minimumHostApiVersion,
  setApiVersionQuery,
} from "../packages/deployment-authority/src/index.js";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { verifyAccessEndpoint } from "../packages/client/src/connections/deployment-catalog.js";
import { hostApi, sessionExchangePath } from "../packages/protocol/src/index.js";
import { startPersonalRuntime } from "../apps/host/src/runtime/personal-startup.test-support.js";
import { waitForRealtimeMessage } from "../apps/host/src/agents/vertical-stack.test-support.js";
import { withTimeout } from "@opensteer/shared/withTimeout";

it("serves every Personal caller whose window overlaps, and refuses the rest before parsing, routes and realtime dispatch", async () => {
  const database = await cloneTestDatabase("host"),
    directory = await mkdtemp(join(tmpdir(), "personal-negotiation-"));
  let runtime: Awaited<ReturnType<typeof startPersonalRuntime>> | undefined,
    socket: WebSocket | undefined;
  try {
    runtime = await ownTestDatabaseProducer(database.url, () =>
      startPersonalRuntime({
        databaseUrl: database.url,
        agentHome: { computerId: createId("runner"), path: directory },
      }),
    );
    const descriptor = await (
      await fetch(new URL("/.well-known/opensteer", runtime.hostOrigin.origin))
    ).json();
    expect(descriptor).toMatchObject({
      apiVersion: minimumHostApiVersion,
      currentApiVersion: hostApiVersion,
    });
    const matched = await verifyAccessEndpoint({
      kind: "canonical",
      origin: runtime.hostOrigin.origin,
    });
    expect(matched.discovery.deploymentId).toBe(runtime.host.deployment.id);
    // A newer Host that still serves this tree's version.
    await expect(
      verifyAccessEndpoint({
        kind: "canonical",
        origin: runtime.hostOrigin.origin,
        fetch: async () => Response.json({ ...descriptor, currentApiVersion: hostApiVersion + 3 }),
      }),
    ).resolves.toMatchObject({ discovery: { deploymentId: runtime.host.deployment.id } });
    const dispatch = (headers: Record<string, string>) =>
      runtime!.host.app.inject({
        method: "POST",
        url: "/v1/rpc/commands.dispatch",
        headers: { ...headers, "content-type": "application/json" },
        payload: "{broken",
      });
    // Admitted: refused only for the payload, never for the version.
    for (const headers of [
      apiVersionHeaders("personal"),
      { [hostApiVersionHeader]: String(hostApiVersion) },
      {
        [hostApiVersionHeader]: String(minimumHostApiVersion),
        [hostApiCurrentHeader]: String(hostApiVersion + 3),
      },
    ])
      expect(
        JSON.stringify((await dispatch(headers)).json()),
        JSON.stringify(headers),
      ).not.toContain("unsupported-version");
    const shellResponse = await runtime.host.app.inject({
      method: "GET",
      url: "/v1/rpc/personal.shell.get?input=%7B%7D",
      headers: {
        [hostApiVersionHeader]: String(minimumHostApiVersion),
        [hostApiCurrentHeader]: String(hostApiVersion + 3),
        cookie: runtime.sessionCookie,
        origin: runtime.hostOrigin.origin,
      },
    });
    expect(shellResponse.statusCode).toBe(200);
    const shell = hostApi["personal.shell.get"].success.parse(shellResponse.json().data);
    expect(shell.deploymentId).toBe(runtime.host.deployment.id);
    for (const version of [minimumHostApiVersion - 1, minimumHostApiVersion - 2]) {
      expect((await dispatch({ [hostApiVersionHeader]: String(version) })).json()).toMatchObject({
        ok: false,
        error: { reason: "unsupported-version", retryable: false },
      });
      await expect(
        verifyAccessEndpoint({
          kind: "canonical",
          origin: runtime.hostOrigin.origin,
          fetch: async () =>
            Response.json({ kind: "personal", apiVersion: version, authority: { legacy: true } }),
        }),
      ).rejects.toMatchObject({ code: "host-too-old" });
    }
    expect(
      (await dispatch({ [hostApiVersionHeader]: String(hostApiVersion + 1) })).json(),
    ).toMatchObject({ error: { reason: "unsupported-version" } });
    await expect(
      verifyAccessEndpoint({
        kind: "canonical",
        origin: runtime.hostOrigin.origin,
        fetch: async () => Response.json({ ...descriptor, apiVersion: hostApiVersion + 1 }),
      }),
    ).rejects.toMatchObject({ code: "client-too-old" });
    // Every other route refuses an unversioned caller before authentication;
    // only routes a browser or another service reaches are declared exempt.
    const unversioned = (url: string) => runtime!.host.app.inject({ method: "GET", url });
    expect((await unversioned("/v1/personal-remote-access")).json()).toMatchObject({
      error: { reason: "unsupported-version" },
    });
    const appId = `app_${crypto.randomUUID()}`;
    const viewToken = "t".repeat(43);
    for (const url of [
      "/v1/plugin-oauth/client-metadata.json",
      "/v1/plugin-oauth/callback?state=x&code=y",
      `/v1/integration-authorizations/${crypto.randomUUID()}/launch?ticket=x`,
      `/v1/apps/${appId}/light/${viewToken}/index.html`,
      `/v1/plugin-pages/${appId}/light/${viewToken}/index.html`,
    ])
      expect(JSON.stringify((await unversioned(url)).body), url).not.toContain(
        "unsupported-version",
      );
    const webhook = await runtime.host.app.inject({
      method: "POST",
      url: `/hooks/v1/plugins/${appId}/whk_fixture`,
    });
    expect(webhook.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(webhook.body).not.toContain("unsupported-version");
    const portalForm = await runtime.host.app.inject({
      method: "POST",
      url: sessionExchangePath,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "grant=invalid",
    });
    expect(portalForm.statusCode).toBe(400);
    expect(portalForm.body).not.toContain("unsupported-version");
    const clientExchange = await runtime.host.app.inject({
      method: "POST",
      url: sessionExchangePath,
      headers: { "content-type": "application/json" },
      payload: "{broken",
    });
    expect(clientExchange.json()).toMatchObject({
      error: { reason: "unsupported-version" },
    });
    for (const url of [
      "/v1/integration-platform/mcp-oauth/client-metadata.json",
      "/v1/integration-platform/mcp-oauth/callback?state=x&code=y",
      "/v1/integrations/oauth/callback/github?state=x&code=y",
    ]) {
      const retired = await runtime.host.app.inject({
        method: "GET",
        url,
        headers: apiVersionHeaders("personal"),
      });
      expect(retired.statusCode, url).toBe(404);
    }
    const realtime = setApiVersionQuery(
      new URL("/v1/realtime", runtime.hostOrigin.origin.replace(/^http/u, "ws")),
      "personal",
    );
    realtime.searchParams.set(apiCurrentQueryParameter, String(hostApiVersion + 3));
    socket = new WebSocket(realtime, {
      headers: { cookie: runtime.sessionCookie, origin: runtime.hostOrigin.origin },
    });
    await withTimeout(once(socket, "open"), 3000, {
      timeoutError: () => new Error("Personal realtime never opened"),
    });
    const replaced = waitForRealtimeMessage(
      socket,
      (frame) => frame.type === "host.snapshot" && "scope" in frame && frame.scope.kind === "shell",
    );
    const synchronized = waitForRealtimeMessage(
      socket,
      (frame) => frame.type === "host.synchronized",
    );
    // A cursor from a prior epoch is replaced from the start.
    socket.send(
      JSON.stringify({
        type: "client.attach",
        apiVersion: hostApiVersion,
        generation: 1,
        interests: [],
        installed: {},
        cursor: {
          deploymentId: shell.deploymentId,
          epoch: crypto.randomUUID(),
          viewerId: shell.viewerId,
          scopeKey: "shell",
          afterSequence: "0",
        },
      }),
    );
    expect(await replaced).toMatchObject({
      type: "host.snapshot",
      snapshot: { epoch: shell.epoch, deploymentId: shell.deploymentId },
    });
    expect(await synchronized).toMatchObject({ type: "host.synchronized" });
    // A socket below the window is refused at the upgrade, before any frame.
    const below = new URL(realtime);
    below.searchParams.delete(apiCurrentQueryParameter);
    below.searchParams.set(apiVersionQueryParameter, String(minimumHostApiVersion - 1));
    const refusedUpgrade = await runtime.host.app.inject({
      method: "GET",
      url: `${below.pathname}${below.search}`,
      headers: { connection: "Upgrade", upgrade: "websocket" },
    });
    expect(refusedUpgrade.json()).toMatchObject({ error: { reason: "unsupported-version" } });
  } finally {
    socket?.terminate();
    await runtime?.close();
    await database.drop();
    await rm(directory, { recursive: true, force: true });
  }
});
