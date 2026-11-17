import { createId } from "@opensteer/core";
import { scopedPersonalApiVersion } from "@opensteer/protocol/personal-sync";
import { describe, expect, it, vi } from "vitest";
import { createHttpHostApiClient, unwrapRpcResult } from "@opensteer/client/host";
import { createDesktopHostFetch } from "./desktop-host-transport.js";
import { desktopPreviewBridge } from "./desktop-preview-bridge.js";

describe("Desktop preview Host simulation", () => {
  it("keeps refused leave unconfirmed instead of fabricating Host acknowledgment", async () => {
    const id = createId("deployment");
    const bridge = desktopPreviewBridge("?desktop-preview=first-run", true, {
      attached: {
        id,
        name: "Home",
        origin: "https://home.opensteer.test",
        hosting: null,
        runnerId: createId("runner"),
      },
      leaveDevice: async () => {
        throw new Error("Host refused leave");
      },
      transitionDelayMs: 0,
    })!;
    await bridge.leaveDeployment({ deploymentId: id });
    expect((await bridge.getLocalExecutionStatus({ deploymentId: id })).membership).toMatchObject({
      state: "leaving",
      leaveUnconfirmed: true,
    });
    await expect(
      bridge.setUpDevice({ deploymentId: id, runnerName: "Mac", runAgents: false }),
    ).rejects.toThrow("unconfirmed");
  });

  it("serves a scoped shell and its matching environment detail through the Desktop transport", async () => {
    vi.useFakeTimers();
    const bridge = desktopPreviewBridge("?desktop-preview=first-run", true, {
      transitionDelayMs: 1,
    });
    expect(bridge).not.toBeNull();
    if (!bridge) return;

    await bridge.createPersonalDeployment();
    await vi.runAllTimersAsync();
    const snapshot = await bridge.getDeploymentAccessSnapshot();
    expect(snapshot.deployments[0]?.status).toBe("connected");

    const canonicalOrigin = snapshot.deployments[0]?.canonicalOrigin;
    expect(canonicalOrigin).toBeDefined();
    if (!canonicalOrigin) return;

    // The real transport and the real client decide the route and the envelope;
    // the simulator only answers. Driving both proves the emulation still fits.
    const rpc = createHttpHostApiClient({
      baseUrl: new URL(canonicalOrigin),
      fetch: createDesktopHostFetch(bridge, canonicalOrigin, snapshot.deployments[0]!.id),
      onAuthenticationRequired: () => undefined,
      personalVersion: scopedPersonalApiVersion,
    });
    const shell = unwrapRpcResult(await rpc["personal.shell.get"]({}));
    expect(shell.session.user.id).toBe(shell.viewerId);
    expect(shell.deploymentId).toBe(snapshot.deployments[0]?.id);
    const expectedRevision = shell.resourceRevisions.environment;
    const details = unwrapRpcResult(
      await rpc["resources.detail.get"]({ kind: "environment", expectedRevision }),
    );
    expect(details.revision).toBe(expectedRevision);
    expect(details.next).toBeNull();
    expect(details.data.kind).toBe("environment");
    if (details.data.kind !== "environment") throw new Error("Missing environment details");
    expect(details.data.environments).toHaveLength(1);
    expect(details.data.environments[0]?.id).toBe(
      shell.resources?.find(({ kind }) => kind === "environment")?.view.entries[0]?.id,
    );
    vi.useRealTimers();
  });
});
