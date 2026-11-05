import type { HostClient } from "@opensteer/client/host";
import { subscribeIntegrationAuthorizationReturns } from "../../../../web/src/integrations/integration-authorization.js";
import { createId } from "@opensteer/core";
import {
  createIntegrationId,
  buildIntegrationAuthorizationAppReturn,
} from "@opensteer/integration-core";
import { expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { DesktopBridgeContext } from "../context.js";
import { DesktopIntegrationAuthorizations } from "../../app/integration-authorizations.js";
import { handleOpenIntegrationAuthorization } from "./integrations.js";

const oauth = {
  application: "desktop",
  clientId: "opensteer-desktop",
  accountCallback: "com.opensteer.opensteer:/oauth/account-callback",
  hostCallback: "com.opensteer.opensteer:/oauth/host-callback",
} as const;
const entry = () => ({
  deploymentId: createId("deployment"),
  attemptId: createIntegrationId("oauthAttempt"),
  userId: createId("user"),
  expiresAt: "2099-01-01T00:00:00.000Z",
});
it("drops unknown returns, queues registered returns before renderer subscription, and clears terminal authority", async () => {
  const focus = vi.fn();
  const returns = new DesktopIntegrationAuthorizations(oauth, focus);
  const started = entry();
  const callback = {
    deploymentId: started.deploymentId,
    attemptId: started.attemptId,
    returnProof: "r".repeat(43),
  };
  const url = buildIntegrationAuthorizationAppReturn("desktop", callback);
  expect(returns.accept(url)).toBe(false);
  expect(focus).not.toHaveBeenCalled();
  await returns.register(started);
  expect(returns.accept(url)).toBe(true);
  expect(focus).toHaveBeenCalledWith(started.deploymentId);
  const deliver = vi.fn();
  const wrong = returns.attach({ ...started, userId: createId("user") }, deliver);
  await returns.settled();
  expect(deliver).not.toHaveBeenCalled();
  wrong();
  const detach = returns.attach(started, deliver);
  await returns.settled();
  expect(deliver).toHaveBeenCalledWith(callback);
  await returns.forget(started);
  expect(returns.accept(url)).toBe(false);
  detach();
});
it("registers before browser launch and refuses another attached Deployment", async () => {
  const returns = new DesktopIntegrationAuthorizations(oauth, () => {});
  const started = entry();
  const openExternal = vi.fn(async () => {
    expect(returns.find(started)).toEqual(started);
  });
  const frame = { url: "app://opensteer/" };
  const context = {
    options: {
      bridgeToken: "b".repeat(43),
      integrationAuthorizations: returns,
      hostTransport: {
        current: async () => ({
          connection: { authority: { document: { deploymentId: started.deploymentId } } },
        }),
        integrationAuthorizationOrigin: async () => "https://host.example",
      },
      portal: { openExternal },
    },
  } as unknown as DesktopBridgeContext;
  const event = {
    senderFrame: frame,
    sender: { mainFrame: frame },
  } as unknown as IpcMainInvokeEvent;
  const open = (input: unknown) =>
    handleOpenIntegrationAuthorization(context)(event, { bridgeToken: "b".repeat(43), input });
  await expect(open({ ...started, launchTicket: "t".repeat(43) })).resolves.toEqual({
    opened: true,
  });
  await expect(
    open({ ...started, deploymentId: createId("deployment"), launchTicket: "t".repeat(43) }),
  ).rejects.toThrow(/deployment/i);
  expect(openExternal).toHaveBeenCalledOnce();
});

it("redelivers a retained proof after transient redemption failure without another OS callback", async () => {
  vi.useFakeTimers();
  const returns = new DesktopIntegrationAuthorizations(oauth, () => {});
  const started = entry();
  await returns.register(started);
  const status = {
    type: "integration.authorization.return",
    status: "completed",
    connectionId: null,
    failureCode: null,
    expiresAt: started.expiresAt,
  };
  const dispatch = vi.fn(async () => status).mockRejectedValueOnce(new Error("offline"));
  const client = {
    dispatch,
    getSnapshot: () => ({ deploymentId: started.deploymentId, user: { id: started.userId } }),
    subscribe: () => () => {},
  } as unknown as HostClient;
  const bridge = {
    onIntegrationAuthorizationReturn: returns.attach.bind(returns),
    finishIntegrationAuthorization: async () => returns.forget(started),
  };
  const stop = subscribeIntegrationAuthorizationReturns(bridge, client);
  try {
    expect(
      returns.accept(
        buildIntegrationAuthorizationAppReturn("desktop", {
          ...started,
          returnProof: "r".repeat(43),
        }),
      ),
    ).toBe(true);
    await returns.settled();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    await returns.settled();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1]).toEqual(dispatch.mock.calls[0]);
    expect(returns.find(started)).toBeNull();
  } finally {
    stop();
    vi.useRealTimers();
  }
});
