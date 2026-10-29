import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  session: { fromPartition: electron.fromPartition },
}));

import { ElectronServiceNetwork } from "./electron-service-network.js";

describe("ElectronServiceNetwork", () => {
  beforeEach(() => electron.fromPartition.mockReset());

  it("isolates each HTTP origin in one hardened in-memory session", async () => {
    const created: ReturnType<typeof serviceSession>[] = [];
    electron.fromPartition.mockImplementation(() => {
      const next = serviceSession();
      created.push(next);
      return next;
    });
    const network = new ElectronServiceNetwork();

    await network.fetch("https://accounts.beta.opensteer.com/v1/account/deployments");
    await network.fetch("https://accounts.beta.opensteer.com/api/auth/oauth2/token");
    await network.fetch("https://host.beta.opensteer.com/.well-known/opensteer");

    expect(electron.fromPartition).toHaveBeenCalledTimes(2);
    for (const [partition, options] of electron.fromPartition.mock.calls) {
      expect(partition).toMatch(/^opensteer-service-[a-f0-9]{24}$/u);
      expect(String(partition).startsWith("persist:")).toBe(false);
      expect(options).toEqual({ cache: false });
    }
    expect(created[0]?.setPermissionCheckHandler).toHaveBeenCalledOnce();
    expect(created[0]?.setPermissionRequestHandler).toHaveBeenCalledOnce();
    expect(created[0]?.unregisterPreloadScript).toHaveBeenCalledWith("unexpected-preload");

    expect(beforeRequestDecision(created[0]!, "https://accounts.beta.opensteer.com/next")).toEqual({
      cancel: false,
    });
    expect(beforeRequestDecision(created[0]!, "https://attacker.example/next")).toEqual({
      cancel: true,
    });
  });

  it("rejects non-service URLs before creating a session and clears sessions on close", async () => {
    const created = serviceSession();
    electron.fromPartition.mockReturnValue(created);
    const network = new ElectronServiceNetwork();

    expect(() => network.fetch("file:///tmp/credential")).toThrow(/HTTP or HTTPS/u);
    expect(() => network.fetch("https://user:secret@example.test/")).toThrow(
      /cannot contain credentials/u,
    );
    expect(electron.fromPartition).not.toHaveBeenCalled();

    await network.fetch("https://accounts.beta.opensteer.com/healthz");
    await network.close();
    expect(created.closeAllConnections).toHaveBeenCalledOnce();
    expect(created.clearAuthCache).toHaveBeenCalledOnce();
    expect(created.clearCache).toHaveBeenCalledOnce();
    expect(created.clearStorageData).toHaveBeenCalledOnce();
  });
});

function serviceSession() {
  let beforeRequest:
    | ((
        details: { readonly url: string },
        callback: (decision: { cancel: boolean }) => void,
      ) => void)
    | undefined;
  return {
    clearAuthCache: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    clearStorageData: vi.fn(async () => undefined),
    closeAllConnections: vi.fn(async () => undefined),
    fetch: vi.fn(async () => new Response(null, { status: 204 })),
    getPreloadScripts: vi.fn(() => [{ id: "unexpected-preload" }]),
    on: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    unregisterPreloadScript: vi.fn(),
    webRequest: {
      onBeforeRequest: vi.fn(
        (
          _filter: unknown,
          listener: (
            details: { readonly url: string },
            callback: (decision: { cancel: boolean }) => void,
          ) => void,
        ) => {
          beforeRequest = listener;
        },
      ),
    },
    beforeRequest: () => beforeRequest,
  };
}

function beforeRequestDecision(
  service: ReturnType<typeof serviceSession>,
  url: string,
): { cancel: boolean } | undefined {
  let decision: { cancel: boolean } | undefined;
  service.beforeRequest()?.({ url }, (next) => {
    decision = next;
  });
  return decision;
}
