import { createId } from "@opensteer/core";
import { ConnectOperationIdSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  AccountReauthorizationRequiredError,
  AccountConnectClient,
} from "./account-connect-client.js";

describe("AccountConnectClient", () => {
  it("sends an Account bearer only on the bounded provision request", async () => {
    const deploymentId = createId("deployment");
    const hostInstanceId = createId("hostInstance");
    const operationId = ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`);
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer account-access-token" });
      expect(JSON.parse(String(init?.body))).toEqual({
        hostInstanceId,
        localOrigin: "http://127.0.0.1:4310",
        operationId,
      });
      return jsonResponse({
        canonicalOrigin: "http://127.0.0.1:4310",
        connectorCredentialGeneration: 1,
        deploymentId,
        hostInstanceId,
        hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
        routeOrigin: "https://home.connect.opensteer.test",
        tunnelToken: `eyJ${"x".repeat(80)}`,
      });
    });
    const client = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => "Bearer account-access-token" },
      fetch,
    });

    await expect(
      client.provision(deploymentId, {
        hostInstanceId,
        localOrigin: "http://127.0.0.1:4310",
        operationId,
      }),
    ).resolves.toMatchObject({ deploymentId, connectorCredentialGeneration: 1 });
    expect(fetch).toHaveBeenCalledWith(
      `https://accounts.opensteer.test/v1/account/deployments/${deploymentId}/connect`,
      expect.objectContaining({ credentials: "omit", method: "PUT", redirect: "error" }),
    );
  });

  it("does not call the control plane without a current Account authorization", async () => {
    const fetch = vi.fn();
    const client = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => null },
      fetch,
    });
    await expect(
      client.revoke(createId("deployment"), {
        hostInstanceId: createId("hostInstance"),
        operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
      }),
    ).rejects.toThrow(/Sign in/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an Account request when the exact authorization session ends", async () => {
    const session = new AbortController();
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const client = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: {
        accountAuthorizationHeader: async () => "Bearer replacement-account",
        accountAuthorizationLease: async () => ({
          authorization: "Bearer original-account",
          signal: session.signal,
        }),
      },
      fetch,
    });

    const request = client.createCloudDeployment({
      name: "Studio",
      operationId: crypto.randomUUID(),
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    session.abort(new Error("Account session ended"));

    await expect(request).rejects.toThrow("Account session ended");
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer original-account",
    });
  });

  it("never falls back to a dynamic Account header for Cloud", async () => {
    const fetch = vi.fn();
    const client = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => "Bearer replacement-account" },
      fetch,
    });

    await expect(client.listCloudDeployments()).rejects.toThrow(/Sign in/u);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces a typed step-up requirement without retrying the mutation", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "recent_sign_in_required",
              message: "Recent Opensteer Account sign-in is required",
            },
          }),
          { headers: { "content-type": "application/json" }, status: 401 },
        ),
    );
    const client = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => "Bearer account-access-token" },
      fetch,
    });

    const request = client.revoke(createId("deployment"), {
      hostInstanceId: createId("hostInstance"),
      operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
    });
    await expect(request).rejects.toBeInstanceOf(AccountReauthorizationRequiredError);
    await expect(request).rejects.toMatchObject({
      code: "recent_sign_in_required",
      name: "AccountReauthorizationRequiredError",
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects redirected and oversized responses", async () => {
    const deploymentId = createId("deployment");
    const request = {
      hostInstanceId: createId("hostInstance"),
      operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
    };
    const redirected = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => "Bearer account-access-token" },
      fetch: async () => redirectedJsonResponse(),
    });
    await expect(redirected.rotate(deploymentId, request)).rejects.toThrow(/must not redirect/u);

    const oversized = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => "Bearer account-access-token" },
      fetch: async () =>
        new Response("{}", {
          headers: {
            "content-length": String(128 * 1_024 + 1),
            "content-type": "application/json",
          },
        }),
    });
    await expect(oversized.rotate(deploymentId, request)).rejects.toThrow(/too large/u);
  });

  it("keeps its timeout active until a stalled response body is cancelled", async () => {
    let cancelled = false;
    const client = new AccountConnectClient({
      accountOrigin: "https://accounts.opensteer.test",
      authorization: { accountAuthorizationHeader: async () => "Bearer account-access-token" },
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      timeoutMs: 10,
    });
    await expect(
      client.rotate(createId("deployment"), {
        hostInstanceId: createId("hostInstance"),
        operationId: ConnectOperationIdSchema.parse(`cop_${crypto.randomUUID()}`),
      }),
    ).rejects.toThrow(/timed out/u);
    expect(cancelled).toBe(true);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function redirectedJsonResponse(): Response {
  const response = jsonResponse({});
  Object.defineProperties(response, {
    redirected: { value: true },
    url: { value: "https://other.example.test" },
  });
  return response;
}
