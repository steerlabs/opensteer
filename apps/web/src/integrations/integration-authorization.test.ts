import { createIntegrationId } from "@opensteer/integration-core";
import type { HostClient } from "@opensteer/client/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConnectOperations } from "../components/integrations/connect-operations.js";
import {
  beginIntegrationAuthorization,
  integrationAuthorizationCompletionPath,
} from "./integration-authorization.js";

const started = {
  attemptId: createIntegrationId("oauthAttempt"),
  expiresAt: "2099-08-20T23:10:00.000Z",
  launchTicket: "t".repeat(43),
};

afterEach(() => {
  vi.unstubAllGlobals();
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
    expect(begin).toHaveBeenCalledWith(integrationAuthorizationCompletionPath);
    expect(onStarted).toHaveBeenCalledWith(started.attemptId);
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
        bridge: { openIntegrationAuthorization },
        begin,
        returnPath: "/threads/thread_123?panel=apps#request",
      }),
    ).resolves.toEqual(started);

    expect(browser.open).not.toHaveBeenCalled();
    expect(begin).toHaveBeenCalledWith("/threads/thread_123?panel=apps#request");
    expect(openIntegrationAuthorization).toHaveBeenCalledWith({
      attemptId: started.attemptId,
      launchTicket: started.launchTicket,
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
    const tracking = { finished: vi.fn(), started: vi.fn() };
    const operations = createConnectOperations({ dispatch } as unknown as HostClient, tracking);

    await operations.beginAuthorization({
      applicationSource: null,
      definitionId: "github",
      returnPath: "/integrations?section=connected#github",
    });

    expect(events).toEqual(["open", "dispatch", "navigate"]);
    expect(tracking.started).toHaveBeenCalledWith(started.attemptId);
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
    expect(onStarted).toHaveBeenCalledWith(started.attemptId);
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
