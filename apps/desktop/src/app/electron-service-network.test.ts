import { execFileSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

    await network.fetch("https://accounts.opensteer.com/v1/account/deployments");
    await network.fetch("https://accounts.opensteer.com/api/auth/oauth2/token");
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

    expect(beforeRequestDecision(created[0]!, "https://accounts.opensteer.com/next")).toEqual({
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

    await network.fetch("https://accounts.opensteer.com/healthz");
    await network.close();
    expect(created.closeAllConnections).toHaveBeenCalledOnce();
    expect(created.clearAuthCache).toHaveBeenCalledOnce();
    expect(created.clearCache).toHaveBeenCalledOnce();
    expect(created.clearStorageData).toHaveBeenCalledOnce();
  });
});

// The first-run journey's account service is served with a fixture authority's certificate. Its
// key is accepted by the one session that talks to the account service, for that host alone; every
// other session, a browser profile's among them, is left to Chromium, which refuses it.
describe("the account service's pinned key, in a development launch", () => {
  beforeEach(() => electron.fromPartition.mockReset());
  const directory = mkdtempSync(path.join(tmpdir(), "service-network-pin-"));
  execFileSync("/bin/bash", [
    path.resolve(import.meta.dirname, "../../../../scripts/test-vm/fixture-authority-files.sh"),
    directory,
    "Opensteer journey fixture authority",
    "account.first-run.opensteer.example",
  ]);
  const certificate = readFileSync(path.join(directory, "account.pem"), "utf8");
  const authority = readFileSync(path.join(directory, "ca.pem"), "utf8");
  const keyOf = (pem: string) =>
    createHash("sha256")
      .update(new X509Certificate(pem).publicKey.export({ format: "der", type: "spki" }))
      .digest("base64");
  const origin = "https://account.first-run.opensteer.example:45213";

  /** The session's verdict on a certificate Chromium presents for `hostname`, as Electron asks. */
  function verdict(created: ReturnType<typeof serviceSession>, hostname: string, pem: string) {
    const verify = created.setCertificateVerifyProc.mock.calls.at(-1)?.[0] as
      ((request: unknown, callback: (result: number) => void) => void) | undefined;
    if (!verify) return "Chromium's";
    let result: number | undefined;
    verify(
      {
        certificate: { data: pem },
        errorCode: -202,
        hostname,
        verificationResult: "net::ERR_CERT_AUTHORITY_INVALID",
      },
      (value) => {
        result = value;
      },
    );
    return result === 0 ? "accepted" : result === -3 ? "Chromium's" : `refused ${result}`;
  }

  it("accepts it for the account host on the account service's session, and nothing else", async () => {
    const created: ReturnType<typeof serviceSession>[] = [];
    electron.fromPartition.mockImplementation(() => {
      const next = serviceSession();
      created.push(next);
      return next;
    });
    const network = new ElectronServiceNetwork({
      accountCertificate: { key: keyOf(certificate), origin },
    });
    await network.fetch(`${origin}/api/auth/oauth2/token`);
    await network.fetch("https://host.beta.opensteer.com/.well-known/opensteer");
    const [account, other] = created;
    expect(verdict(account!, "account.first-run.opensteer.example", certificate)).toBe("accepted");
    // Another host, or another key, on the same session: Chromium's own verdict.
    expect(verdict(account!, "accounts.opensteer.com", certificate)).toBe("Chromium's");
    expect(verdict(account!, "account.first-run.opensteer.example", authority)).toBe("Chromium's");
    // Any other service's session is never given one.
    expect(other!.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  it("gives no session a verdict of its own without a pin", async () => {
    const created = serviceSession();
    electron.fromPartition.mockReturnValue(created);
    await new ElectronServiceNetwork().fetch(`${origin}/healthz`);
    expect(created.setCertificateVerifyProc).not.toHaveBeenCalled();
  });

  // A browser profile's session, and every other session of the app, is never given one: only
  // this file sets a verify procedure, so Chromium refuses that key everywhere else.
  it("is the app's only certificate verdict", () => {
    const repository = path.resolve(import.meta.dirname, "../../../..");
    const setters = execFileSync(
      "git",
      ["grep", "-l", "setCertificateVerifyProc", "--", "apps/desktop/src", ":!*.test.ts"],
      { cwd: repository, encoding: "utf8" },
    )
      .trim()
      .split("\n");
    expect(setters).toEqual(["apps/desktop/src/app/electron-service-network.ts"]);
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
    setCertificateVerifyProc: vi.fn(),
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
