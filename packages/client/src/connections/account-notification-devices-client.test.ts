import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AccountNotificationDevicesClient,
  DeviceLimitReachedError,
  PushNotConfiguredError,
} from "./account-notification-devices-client.js";
import { AccountRequestError } from "./account-deployment-directory.js";

const accountOrigin = "https://accounts.opensteer.test";
const installationId = "install_0a1b2c3d4e5f6071";
const token = "a".repeat(64);
const subject = ControlPlaneAccountIdSchema.parse("acct_0192f4a1-0000-4000-8000-000000000001");

const signedIn = {
  accountAuthorizationLease: async () => ({
    authorization: "Bearer account-access-token",
    issuer: accountOrigin,
    signal: new AbortController().signal,
    subject,
  }),
};

const device = {
  approvalsEnabled: true,
  installationId,
  lastSeenAt: "2026-09-14T00:00:00.000Z",
  platform: "ios",
  registeredAt: "2026-09-14T00:00:00.000Z",
  runOutcomesEnabled: false,
  updatedAt: "2026-09-14T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("AccountNotificationDevicesClient", () => {
  it("registers this install's provider token under its own installation id", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input.toString()).toBe(
        `${accountOrigin}/v1/account/notification-devices/${installationId}`,
      );
      expect(init).toMatchObject({ credentials: "omit", method: "PUT", redirect: "error" });
      expect(init?.headers).toMatchObject({ authorization: "Bearer account-access-token" });
      expect(JSON.parse(String(init?.body))).toEqual({
        approvalsEnabled: true,
        apsEnvironment: "development",
        platform: "ios",
        runOutcomesEnabled: false,
        token,
      });
      return jsonResponse({ device });
    });
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: signedIn,
      fetch,
    });

    await expect(
      client.register(installationId, {
        approvalsEnabled: true,
        apsEnvironment: "development",
        platform: "ios",
        runOutcomesEnabled: false,
        token,
      }),
    ).resolves.toMatchObject({ approvalsEnabled: true, installationId });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("names a service that holds no push credentials as its own settled state", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "not_found",
            message: "Push notifications are not configured on this control plane",
            reason: "push-not-configured",
          },
        },
        404,
      ),
    );
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: signedIn,
      fetch,
    });

    await expect(
      client.register(installationId, {
        approvalsEnabled: true,
        apsEnvironment: "development",
        platform: "ios",
        runOutcomesEnabled: true,
        token,
      }),
    ).rejects.toBeInstanceOf(PushNotConfiguredError);
  });

  it("names an Account already at its device limit as its own settled state", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "conflict",
            message: "This Account already has 16 devices registered for notifications.",
            reason: "device-limit",
          },
        },
        409,
      ),
    );
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: signedIn,
      fetch,
    });

    // The repair is on another phone, so this must not read as a failure to
    // retry against.
    await expect(
      client.register(installationId, {
        approvalsEnabled: true,
        apsEnvironment: "development",
        platform: "ios",
        runOutcomesEnabled: true,
        token,
      }),
    ).rejects.toBeInstanceOf(DeviceLimitReachedError);
  });

  it("reports a refusal as an Account request failure carrying its code", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: "forbidden",
            message: "Push registration belongs to the Opensteer mobile application",
          },
        },
        403,
      ),
    );
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: signedIn,
      fetch,
    });

    await expect(client.list()).rejects.toMatchObject({
      code: "forbidden",
      name: "AccountRequestError",
      status: 403,
    });
  });

  it("treats a missing credential exactly like a rejected one", async () => {
    const fetch = vi.fn(async () => jsonResponse({ devices: [] }));
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: { accountAuthorizationLease: async () => null },
      fetch,
    });

    await expect(client.list()).rejects.toBeInstanceOf(AccountRequestError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a credential minted by a different Account service", async () => {
    const fetch = vi.fn(async () => jsonResponse({ devices: [] }));
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: {
        accountAuthorizationLease: async () => ({
          authorization: "Bearer account-access-token",
          issuer: "https://elsewhere.opensteer.test",
          signal: new AbortController().signal,
          subject,
        }),
      },
      fetch,
    });

    await expect(client.list()).rejects.toThrow(/issuer does not match/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("makes no request at all in a build with no Account service", async () => {
    const fetch = vi.fn(async () => jsonResponse({ devices: [] }));
    const client = new AccountNotificationDevicesClient({
      accountOrigin: null,
      authorization: signedIn,
      fetch,
    });

    await expect(client.list()).rejects.toThrow(/source build/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an installation id the registry could never key a row by", async () => {
    const fetch = vi.fn(async () => jsonResponse({ installationId, unregistered: true }));
    const client = new AccountNotificationDevicesClient({
      accountOrigin,
      authorization: signedIn,
      fetch,
    });

    await expect(client.unregister("short")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
