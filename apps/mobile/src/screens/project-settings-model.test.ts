import { afterEach, describe, expect, it } from "vitest";
import { unwrapRpcResult } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { integrationAllowOptions } from "./project-settings-model.js";

const clients: MockHostClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.dispose();
});

/** The preview Host's own accounts and installed apps, in the shapes the Host sends. */
async function accounts() {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  clients.push(host);
  await host.load();
  const dashboard = unwrapRpcResult(await host.rpc["integrations.get"]({}));
  const platform = unwrapRpcResult(await host.rpc["integration.platform.get"]({}));
  return { dashboard, platform };
}

describe("allowing a specialist's missing account", () => {
  it("offers the person's connected accounts for that service, each with its installed app", async () => {
    const { dashboard, platform } = await accounts();
    const github = dashboard.connections.filter(
      ({ computer, definitionId, status }) =>
        definitionId === "github" && status === "connected" && computer === null,
    );
    expect(github.length).toBeGreaterThan(0);
    const options = integrationAllowOptions(
      { service: "github", type: "integration" },
      dashboard,
      platform,
    );
    expect(options.map(({ connectionId }) => connectionId)).toEqual(github.map(({ id }) => id));
    expect(options.every(({ installationId }) => installationId.length > 0)).toBe(true);
  });

  it("offers nothing for a service with no connected account, so the next step is connecting one", async () => {
    const { dashboard, platform } = await accounts();
    expect(
      integrationAllowOptions(
        { service: "no-such-service", type: "integration" },
        dashboard,
        platform,
      ),
    ).toEqual([]);
    // A paused or disconnected account is not one an agent could use.
    expect(
      integrationAllowOptions(
        { service: "github", type: "integration" },
        {
          connections: dashboard.connections.map((connection) => ({
            ...connection,
            status: "paused" as const,
          })),
        },
        platform,
      ),
    ).toEqual([]);
  });
});
