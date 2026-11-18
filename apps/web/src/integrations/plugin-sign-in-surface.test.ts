import type { DesktopIntegrationAuthorizationReturn } from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { IntegrationAuthorizationAttemptIdSchema } from "@opensteer/integration-core";
import type { HostClient } from "@opensteer/client/host";
import { describe, expect, it, vi } from "vitest";
import { pluginSignInFinish, subscribePluginSignInReturns } from "./plugin-sign-in-surface.js";

const deploymentId = createId("deployment");
const userId = createId("user");
const started = { expiresAt: "2099-08-20T23:10:00.000Z" };

describe("pluginSignInFinish", () => {
  const capable = {
    getSnapshot: () => ({
      deploymentId,
      integrationAppFinishAvailable: true,
      integrationAppReturnPortAvailable: true,
    }),
  } as unknown as HostClient;
  const preparation = "00000000-0000-4000-8000-000000000009";
  const prepared = (port: number | null) => ({
    prepareIntegrationAuthorizationReturn: vi.fn(async () =>
      port === null ? { port } : { port, preparation },
    ),
  });

  it("asks a capable app for its port before the attempt begins", async () => {
    const bridge = prepared(48_203);
    await expect(pluginSignInFinish(bridge, capable)).resolves.toEqual({
      finish: { appReturnPort: 48_203, finish: "app" },
      preparation,
    });
    expect(bridge.prepareIntegrationAuthorizationReturn).toHaveBeenCalledWith({ deploymentId });
  });

  it("sends no port to a Host that would refuse it, and opens no listener", async () => {
    const bridge = prepared(48_203);
    const finishOnly = {
      getSnapshot: () => ({ deploymentId, integrationAppFinishAvailable: true }),
    } as unknown as HostClient;
    await expect(pluginSignInFinish(bridge, finishOnly)).resolves.toEqual({
      finish: { finish: "app" },
    });
    expect(bridge.prepareIntegrationAuthorizationReturn).not.toHaveBeenCalled();
  });

  it("goes on through the app link when no port is free", async () => {
    await expect(pluginSignInFinish(prepared(null), capable)).resolves.toEqual({
      finish: { finish: "app" },
    });
    await expect(
      pluginSignInFinish(
        {
          prepareIntegrationAuthorizationReturn: vi.fn(async () => Promise.reject(new Error("x"))),
        },
        capable,
      ),
    ).resolves.toEqual({ finish: { finish: "app" } });
  });

  it("asks nothing of a browser", async () => {
    await expect(pluginSignInFinish(null, capable)).resolves.toEqual({ finish: {} });
  });
});

it("sends a plugin sign-in's desktop return to the plugin command and closes it in main", async () => {
  const attemptId = IntegrationAuthorizationAttemptIdSchema.parse(
    "ioa_00000000-0000-4000-8000-000000000009",
  );
  const dispatch = vi.fn(async () => ({
    type: "plugin.authorization.return",
    attemptId,
    connection: "con_1",
    account: "acc_1",
    expiresAt: started.expiresAt,
    status: "completed",
    failureCode: null,
  }));
  let receive!: (value: DesktopIntegrationAuthorizationReturn) => void;
  const bridge = {
    onIntegrationAuthorizationReturn: (_identity: unknown, listener: typeof receive) => {
      receive = listener;
      return () => {};
    },
    finishIntegrationAuthorization: vi.fn(async () => {}),
  };
  const client = {
    dispatch,
    subscribe: () => () => {},
    getSnapshot: () => ({ user: { id: userId }, deploymentId }),
  } as unknown as HostClient;
  const stop = subscribePluginSignInReturns(bridge, client);
  receive({ deploymentId, attemptId, returnProof: "r".repeat(43) });
  await vi.waitFor(() =>
    expect(bridge.finishIntegrationAuthorization).toHaveBeenCalledWith({ deploymentId, attemptId }),
  );
  expect(dispatch).toHaveBeenCalledExactlyOnceWith({
    type: "plugin.authorization.return",
    idempotencyKey: `plugin-auth-return:${attemptId}`,
    attemptId,
    returnProof: "r".repeat(43),
  });
  stop();
});
