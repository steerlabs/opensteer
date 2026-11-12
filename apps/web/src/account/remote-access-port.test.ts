import { describe, expect, it, vi } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import type { PersonalRemoteAdministrationStatus } from "@opensteer/protocol";
import type { DeploymentAccessSnapshot, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { courierRemoteAccessPort, webRemoteAccessRoute } from "./remote-access-port.js";

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
