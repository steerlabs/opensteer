import { createId } from "@opensteer/core";
import { HostBootstrapSchema } from "@opensteer/protocol";
import { describe, expect, it, vi } from "vitest";
import { createHttpHostApiClient } from "@opensteer/client/host";
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

  it("serves a bootstrap that satisfies the real wire contract", async () => {
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
    });
    const result = await rpc["bootstrap.get"]({});
    expect(result.ok, result.ok ? "" : result.error.message).toBe(true);
    if (!result.ok) return;
    expect(HostBootstrapSchema.safeParse(result.data).success).toBe(true);
    expect(result.data.environments).toHaveLength(1);
    vi.useRealTimers();
  });
});
