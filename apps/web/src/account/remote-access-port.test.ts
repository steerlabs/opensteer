import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import type { DeploymentAccessSnapshot, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import {
  courierRemoteAccessPort,
  signInThroughBrowser,
  webRemoteAccessRoute,
} from "./remote-access-port.js";

const desktopOwn = "deployment_desktop";
const viewedElsewhere = "deployment_studio";

function bridge() {
  return {
    completePersonalAccountLink: vi.fn(async () => ({ completion: "sealed" })),
    getDeploymentAccessSnapshot: vi.fn(),
    issuePersonalAccountLinkChallenge: vi.fn(async () => ({ challengeId: "challenge" })),
    linkPersonal: vi.fn(async () => {}),
    onDeploymentAccessSnapshotChanged: vi.fn(),
    signIn: vi.fn(async () => {}),
    unlinkPersonal: vi.fn(async () => {}),
  };
}

const access = {
  personalSetup: { deploymentId: desktopOwn },
} as unknown as DeploymentAccessSnapshot;

describe("webRemoteAccessRoute", () => {
  it("links the desktop's own deployment through its journal", () => {
    const desktop = bridge();
    expect(
      webRemoteAccessRoute({
        bridge: desktop as unknown as OpensteerDesktopBridge,
        deploymentAccess: access,
        viewedDeploymentId: desktopOwn,
      }).kind,
    ).toBe("desktop");
  });

  it("links another viewed computer through that computer's Host, never the desktop's own link", async () => {
    const desktop = bridge();
    const route = webRemoteAccessRoute({
      bridge: desktop as unknown as OpensteerDesktopBridge,
      deploymentAccess: access,
      viewedDeploymentId: viewedElsewhere,
    });
    expect(route.kind).toBe("courier");
    if (route.kind !== "courier") return;
    const dispatch = vi.fn(async (command: { readonly type: string }) =>
      command.type === "personal.accountLink.approve"
        ? { type: command.type, proof: "proof" }
        : { type: command.type },
    );
    const viewedHost = { dispatch } as unknown as HostClient;
    const port = courierRemoteAccessPort({
      bridge: route.bridge,
      hostClient: viewedHost,
      name: "Studio Mac",
      status: {
        authorityEnvelope: "studio-envelope",
      } as unknown as PersonalRemoteAdministrationStatus,
    });
    await port.link({ activating: false, signal: new AbortController().signal });
    expect(desktop.issuePersonalAccountLinkChallenge).toHaveBeenCalledWith(
      expect.objectContaining({ authorityEnvelope: "studio-envelope", name: "Studio Mac" }),
    );
    expect(dispatch.mock.calls.map(([command]) => command.type)).toEqual([
      "personal.accountLink.approve",
      "personal.accountLink.complete",
    ]);
    expect(desktop.linkPersonal).not.toHaveBeenCalled();
    expect(desktop.unlinkPersonal).not.toHaveBeenCalled();
  });
});

describe("signInThroughBrowser", () => {
  function accountBridge(status: string) {
    let listener: ((next: DeploymentAccessSnapshot) => void) | null = null;
    let account = { available: true, status };
    const desktop = {
      getDeploymentAccessSnapshot: vi.fn(async () => ({ account }) as DeploymentAccessSnapshot),
      onDeploymentAccessSnapshotChanged: vi.fn((next: typeof listener) => {
        listener = next;
        return () => {
          listener = null;
        };
      }),
      signIn: vi.fn(async () => {
        account = { available: true, status: "authorizing" };
      }),
    };
    const publish = (next: string) => {
      account = { available: true, status: next };
      listener?.({ account } as DeploymentAccessSnapshot);
    };
    return { desktop, listening: () => listener !== null, publish };
  }

  it("ends with the browser sign-in, signed in or given up, and lets go of the snapshot", async () => {
    const signedIn = accountBridge("signed-out");
    const success = signInThroughBrowser(signedIn.desktop, new AbortController().signal);
    await vi.waitFor(() => expect(signedIn.listening()).toBe(true));
    signedIn.publish("signed-in");
    await expect(success).resolves.toBeUndefined();
    expect(signedIn.desktop.signIn).toHaveBeenCalledOnce();
    expect(signedIn.listening()).toBe(false);

    // Closing the browser's sign-in is an answer, not a wait that never ends.
    const givenUp = accountBridge("signed-out");
    const failure = signInThroughBrowser(givenUp.desktop, new AbortController().signal);
    await vi.waitFor(() => expect(givenUp.listening()).toBe(true));
    givenUp.publish("signed-out");
    await expect(failure).rejects.toThrow("Sign-in didn’t finish. Try again.");
    expect(givenUp.listening()).toBe(false);
  });

  it("joins a sign-in already open in the browser instead of opening another", async () => {
    const open = accountBridge("authorizing");
    const joined = signInThroughBrowser(open.desktop, new AbortController().signal);
    await vi.waitFor(() => expect(open.listening()).toBe(true));
    open.publish("signed-in");
    await expect(joined).resolves.toBeUndefined();
    expect(open.desktop.signIn).not.toHaveBeenCalled();
  });
});
