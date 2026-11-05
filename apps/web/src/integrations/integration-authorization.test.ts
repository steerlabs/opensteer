import type { DesktopIntegrationAuthorizationReturn } from "@opensteer/protocol/desktop";
import { createId } from "@opensteer/core";
import { createIntegrationId } from "@opensteer/integration-core";
import { HostClientRequestError, type HostClient } from "@opensteer/client/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectOperations } from "../components/integrations/connect-operations.js";
import {
  beginIntegrationAuthorization,
  integrationAuthorizationCompletionPath,
  integrationAuthorizationFinish,
  subscribeIntegrationAuthorizationReturns,
  waitForIntegrationAuthorization,
} from "./integration-authorization.js";

const deploymentId = createId("deployment");
const userId = createId("user");
const started = {
  attemptId: createIntegrationId("oauthAttempt"),
  expiresAt: "2099-08-20T23:10:00.000Z",
  launchTicket: "t".repeat(43),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integrationAuthorizationFinish", () => {
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
    await expect(integrationAuthorizationFinish(bridge, capable)).resolves.toEqual({
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
    await expect(integrationAuthorizationFinish(bridge, finishOnly)).resolves.toEqual({
      finish: { finish: "app" },
    });
    expect(bridge.prepareIntegrationAuthorizationReturn).not.toHaveBeenCalled();
  });

  it("goes on through the app link when no port is free", async () => {
    await expect(integrationAuthorizationFinish(prepared(null), capable)).resolves.toEqual({
      finish: { finish: "app" },
    });
    await expect(
      integrationAuthorizationFinish(
        {
          prepareIntegrationAuthorizationReturn: vi.fn(async () => Promise.reject(new Error("x"))),
        },
        capable,
      ),
    ).resolves.toEqual({ finish: { finish: "app" } });
  });

  it("opens no listener for a person who chose the app button", async () => {
    const bridge = prepared(48_203);
    await expect(integrationAuthorizationFinish(bridge, capable, "app-button")).resolves.toEqual({
      finish: { finish: "app" },
    });
    expect(bridge.prepareIntegrationAuthorizationReturn).not.toHaveBeenCalled();
  });

  it("asks nothing of a browser", async () => {
    await expect(integrationAuthorizationFinish(null, capable)).resolves.toEqual({ finish: {} });
  });

  it("carries the preparation to registration and the route to tracking", async () => {
    const openIntegrationAuthorization = vi.fn(async () => ({ opened: true as const }));
    const onStarted = vi.fn();
    const begin = vi.fn(async () => started);
    const client = {
      getSnapshot: () => ({
        deploymentId,
        integrationAppFinishAvailable: true,
        integrationAppReturnPortAvailable: true,
        user: { id: userId },
      }),
    } as unknown as HostClient;
    const bridge = { ...prepared(48_203), openIntegrationAuthorization };
    await beginIntegrationAuthorization({ begin, bridge, client, onStarted, returnPath: "/" });
    expect(begin).toHaveBeenCalledWith("/", { appReturnPort: 48_203, finish: "app" });
    expect(onStarted).toHaveBeenCalledWith(started.attemptId, true);
    expect(openIntegrationAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ returnPreparation: preparation }),
    );
    await beginIntegrationAuthorization({
      begin,
      bridge,
      client,
      onStarted,
      returnPath: "/",
      returnRoute: "app-button",
    });
    expect(onStarted).toHaveBeenLastCalledWith(started.attemptId, false);
    expect(openIntegrationAuthorization.mock.lastCall).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ returnPreparation: expect.anything() })]),
    );
  });
});

describe("integration authorization client", () => {
  it("opens the completion tab synchronously before beginning web authorization", async () => {
    const events: string[] = [];
    const tab = authorizationTab(events);
    const browser = installWindow({
      href: "https://host.example/integrations?section=connected#github",
      open: vi.fn(() => {
        events.push("open");
        return tab;
      }),
    });
    const begin = vi.fn(async (returnPath: string) => {
      events.push("begin");
      expect(returnPath).toBe(integrationAuthorizationCompletionPath);
      expect(tab.opener).toBeNull();
      return started;
    });
    const onStarted = vi.fn();

    await expect(
      beginIntegrationAuthorization({ bridge: null, begin, onStarted, returnPath: "/ignored" }),
    ).resolves.toEqual(started);

    expect(events).toEqual(["open", "begin", "navigate"]);
    expect(browser.open).toHaveBeenCalledWith(integrationAuthorizationCompletionPath, "_blank");
    expect(begin).toHaveBeenCalledWith(integrationAuthorizationCompletionPath, {});
    expect(onStarted).toHaveBeenCalledWith(started.attemptId, false);
    expect(onStarted).not.toHaveBeenCalledWith(expect.stringContaining(started.launchTicket));
    expect(browser.href()).toBe("https://host.example/integrations?section=connected#github");
    expect(tab.location.replace).toHaveBeenCalledWith(
      `https://host.example/v1/integration-authorizations/${started.attemptId}/launch?ticket=${started.launchTicket}`,
    );
  });

  it("does not begin authorization when the browser blocks the tab", async () => {
    const browser = installWindow({ open: vi.fn(() => null) });
    const begin = vi.fn(async () => started);

    await expect(
      beginIntegrationAuthorization({ bridge: null, begin, returnPath: "/integrations" }),
    ).rejects.toThrow("Allow Opensteer to open a new tab");

    expect(browser.open).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
  });

  it("closes the prepared tab when beginning authorization fails", async () => {
    const tab = authorizationTab();
    installWindow({ open: vi.fn(() => tab) });
    const failure = new Error("Host refused the request");

    await expect(
      beginIntegrationAuthorization({
        bridge: null,
        begin: vi.fn(async () => {
          throw failure;
        }),
        returnPath: "/integrations",
      }),
    ).rejects.toBe(failure);

    expect(tab.close).toHaveBeenCalledOnce();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("closes the prepared tab when severing its opener fails", async () => {
    const failure = new Error("tab preparation failed");
    const tab = authorizationTab();
    Object.defineProperty(tab, "opener", {
      set() {
        throw failure;
      },
    });
    installWindow({ open: vi.fn(() => tab) });
    const begin = vi.fn(async () => started);

    await expect(
      beginIntegrationAuthorization({ bridge: null, begin, returnPath: "/integrations" }),
    ).rejects.toBe(failure);

    expect(tab.close).toHaveBeenCalledOnce();
    expect(begin).not.toHaveBeenCalled();
  });

  it("uses the existing desktop bridge and the requested return path", async () => {
    const browser = installWindow();
    const openIntegrationAuthorization = vi.fn(async () => ({ opened: true as const }));
    const begin = vi.fn(async () => started);

    await expect(
      beginIntegrationAuthorization({
        bridge: {
          openIntegrationAuthorization,
          prepareIntegrationAuthorizationReturn: vi.fn(),
        },
        client: {
          getSnapshot: () => ({ deploymentId, user: { id: userId } }),
        } as unknown as HostClient,
        begin,
        returnPath: "/threads/thread_123?panel=apps#request",
      }),
    ).resolves.toEqual(started);

    expect(browser.open).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith("/threads/thread_123?panel=apps#request", {});
    expect(openIntegrationAuthorization).toHaveBeenCalledWith({
      attemptId: started.attemptId,
      launchTicket: started.launchTicket,
      deploymentId,
      userId,
      expiresAt: started.expiresAt,
    });
  });

  it("opens the provider tab before createConnectOperations dispatches its begin command", async () => {
    const events: string[] = [];
    const tab = authorizationTab(events);
    installWindow({
      open: vi.fn(() => {
        events.push("open");
        return tab;
      }),
    });
    const dispatch = vi.fn(async () => {
      events.push("dispatch");
      return { ...started, type: "integration.authorization.begin" as const };
    });
    const tracking = { finished: vi.fn(), returnsByItself: vi.fn(), started: vi.fn() };
    const operations = createConnectOperations(
      {
        dispatch,
        getSnapshot: () => ({ integrationAppFinishAvailable: true }),
      } as unknown as HostClient,
      tracking,
    );

    await operations.beginAuthorization({
      applicationSource: null,
      definitionId: "github",
      returnPath: "/integrations?section=connected#github",
    });

    expect(events).toEqual(["open", "dispatch", "navigate"]);
    expect(dispatch.mock.calls[0]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ input: expect.objectContaining({ finish: "app" }) }),
      ]),
    );
    expect(tracking.started).toHaveBeenCalledWith(started.attemptId, false);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          definitionId: "github",
          returnPath: integrationAuthorizationCompletionPath,
          surface: "web",
        }),
        type: "integration.authorization.begin",
      }),
    );
  });

  it("keeps observing a durable attempt when the prepared tab was closed", async () => {
    const tab = authorizationTab();
    tab.closed = true;
    const browser = installWindow({
      href: "https://host.example/integrations?section=connected#github",
      open: vi.fn(() => tab),
    });

    await expect(
      beginIntegrationAuthorization({
        bridge: null,
        begin: vi.fn(async () => started),
        onStarted: vi.fn(),
        returnPath: "/integrations",
      }),
    ).resolves.toEqual(started);

    expect(tab.location.replace).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();
    expect(browser.href()).toBe("https://host.example/integrations?section=connected#github");
  });

  it("reports only the opaque attempt to router-owned tracking", async () => {
    const tab = authorizationTab();
    const browser = installWindow({
      href: "https://host.example/threads/thread_123?panel=apps#request-9",
      open: vi.fn(() => tab),
    });
    const onStarted = vi.fn();

    await beginIntegrationAuthorization({
      bridge: null,
      begin: vi.fn(async () => started),
      onStarted,
      returnPath: "/ignored",
    });

    expect(onStarted).toHaveBeenCalledOnce();
    expect(onStarted).toHaveBeenCalledWith(started.attemptId, false);
    expect(JSON.stringify(onStarted.mock.calls)).not.toContain(started.launchTicket);
    expect(browser.href()).toBe("https://host.example/threads/thread_123?panel=apps#request-9");
    expect(browser.href()).not.toContain(started.launchTicket);
  });
});

function authorizationTab(events: string[] = []) {
  return {
    close: vi.fn(),
    closed: false,
    location: {
      replace: vi.fn(() => events.push("navigate")),
    },
    opener: {} as Window,
  };
}

function installWindow(
  options: {
    readonly href?: string;
    readonly open?: ReturnType<typeof vi.fn>;
  } = {},
) {
  let href = options.href ?? "https://host.example/integrations";
  const open = options.open ?? vi.fn();
  const location = {
    get href() {
      return href;
    },
    get origin() {
      return new URL(href).origin;
    },
  };
  vi.stubGlobal("window", { location, open });
  return { href: () => href, open };
}

it("opts only a capable desktop into app finish", async () => {
  const bridge = { prepareIntegrationAuthorizationReturn: vi.fn(async () => ({ port: null })) };
  const client = {
    getSnapshot: () => ({ integrationAppFinishAvailable: true }),
  } as unknown as HostClient;
  await expect(integrationAuthorizationFinish(bridge, client)).resolves.toEqual({
    finish: { finish: "app" },
  });
  await expect(integrationAuthorizationFinish(null, client)).resolves.toEqual({ finish: {} });
  await expect(
    integrationAuthorizationFinish(bridge, { getSnapshot: () => ({}) } as unknown as HostClient),
  ).resolves.toEqual({ finish: {} });
});
it("dispatches a desktop return to its exact attachment once and wakes its waiter", async () => {
  const { createId } = await import("@opensteer/core");
  const deploymentId = createId("deployment");
  const userId = createId("user");
  const status = {
    connectionId: null,
    failureCode: null,
    expiresAt: started.expiresAt,
    status: "completed" as const,
  };
  const dispatch = vi.fn(async () => ({ ...status, type: "integration.authorization.return" }));
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
  const stop = subscribeIntegrationAuthorizationReturns(bridge, client);
  const callback = { deploymentId, attemptId: started.attemptId, returnProof: "r".repeat(43) };
  receive({ ...callback, deploymentId: createId("deployment") });
  expect(dispatch).not.toHaveBeenCalled();
  receive(callback);
  receive(callback);
  await vi.waitFor(() => expect(bridge.finishIntegrationAuthorization).toHaveBeenCalledOnce(), {
    timeout: 1000,
  });
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      attemptId: started.attemptId,
      returnProof: callback.returnProof,
      type: "integration.authorization.return",
      idempotencyKey: expect.any(String),
    }),
  );
  stop();
});

it.each([true, false])(
  "provider begin opts into app finish only with the desktop capability (%s)",
  async (capable) => {
    const openIntegrationAuthorization = vi.fn(async () => ({ opened: true as const }));
    installWindow();
    Object.assign(window, { opensteerDesktop: { openIntegrationAuthorization } });
    const dispatch = vi.fn(async () => ({
      ...started,
      type: "integration.authorization.begin" as const,
    }));
    const client = {
      dispatch,
      getSnapshot: () => ({
        deploymentId,
        user: { id: userId },
        integrationAppFinishAvailable: capable,
      }),
    } as unknown as HostClient;
    const operations = createConnectOperations(client, {
      started: vi.fn(),
      finished: vi.fn(),
      returnsByItself: vi.fn(),
    });
    await operations.beginAuthorization({
      applicationSource: null,
      definitionId: "github",
      returnPath: "/integrations",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        input: {
          definitionId: "github",
          returnPath: "/integrations",
          surface: "desktop",
          ...(capable ? { finish: "app" } : {}),
        },
      }),
    );
    expect(openIntegrationAuthorization).toHaveBeenCalledWith({ ...started, deploymentId, userId });
  },
);

it.each([400, 403, 404, 408, 429, 503])(
  "handles desktop proof redemption HTTP %i according to refusal classification",
  async (httpStatus) => {
    const attemptId = createIntegrationId("oauthAttempt");
    const dispatch = vi.fn(async () => {
      throw new HostClientRequestError({
        code: "forbidden",
        message: "Return refused",
        status: httpStatus,
      });
    });
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
      getSnapshot: () => ({ deploymentId, user: { id: userId } }),
    } as unknown as HostClient;
    const stop = subscribeIntegrationAuthorizationReturns(bridge, client);
    vi.useFakeTimers();
    try {
      const callback = { deploymentId, attemptId, returnProof: "r".repeat(43) };
      receive(callback);
      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledOnce();
      if ([400, 403, 404].includes(httpStatus)) {
        expect(bridge.finishIntegrationAuthorization).toHaveBeenCalledWith({
          deploymentId,
          attemptId,
        });
        await expect(waitForIntegrationAuthorization({ attemptId, client })).resolves.toMatchObject(
          { status: "failed", failureCode: "grant-rejected" },
        );
      } else {
        receive(callback);
        await vi.advanceTimersByTimeAsync(0);
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(bridge.finishIntegrationAuthorization).not.toHaveBeenCalled();
      }
    } finally {
      stop();
      vi.useRealTimers();
    }
  },
);
