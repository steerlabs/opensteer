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
      fetch: createDesktopHostFetch(
        bridge,
        canonicalOrigin,
        snapshot.deployments[0]!.id,
        (input, init) => bridge.hostRoute(new Request(input, init)),
      ),
      onAuthenticationRequired: () => undefined,
      personalVersion: scopedPersonalApiVersion,
    });
    const shell = unwrapRpcResult(await rpc["personal.shell.get"]({}));
    expect(shell.session.user.id).toBe(shell.viewerId);
    expect(shell.deploymentId).toBe(snapshot.deployments[0]?.id);
    const details = unwrapRpcResult(await rpc["resources.detail.get"]({ kind: "environment" }));
    expect(details.revision).toBe("0");
    expect(details.next).toBeNull();
    expect(details.data.kind).toBe("environment");
    if (details.data.kind !== "environment") throw new Error("Missing environment details");
    expect(details.data.environments).toHaveLength(1);
    const [listed] = details.data.environments;
    expect(listed).toMatchObject({ name: "This Computer", sections: { harnessDrivers: 0 } });
    expect(listed).not.toHaveProperty("harnessDrivers");
    // The environment whole is its own read, as on the real Host.
    const whole = unwrapRpcResult(
      await rpc["environment.detail.get"]({ environmentId: listed!.id }),
    );
    expect(whole.environment).toMatchObject({ id: listed!.id, name: "This Computer" });
    expect(whole.environment.harnessDrivers).toEqual([]);
    const machines = unwrapRpcResult(await rpc["resources.detail.get"]({ kind: "machine" }));
    if (machines.data.kind !== "machine") throw new Error("Missing machine details");
    const [computer] = machines.data.machines;
    expect(computer).toMatchObject({ name: "Preview MacBook", sections: { apps: null } });
    const machine = unwrapRpcResult(await rpc["machine.detail.get"]({ machineId: computer!.id }));
    expect(machine.machine).toMatchObject({ id: computer!.id, name: "Preview MacBook" });
    await expect(rpc["machine.detail.get"]({ machineId: "rnr_missing" })).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    // An attach is always answered, marked, even when every installed revision is current.
    const frames: unknown[] = [];
    const stop = bridge.onHostWebSocketEvent((event) => {
      if (event.type === "text") frames.push(JSON.parse(event.data));
    });
    const { connectionId } = await bridge.openHostWebSocket({
      expectedDeploymentId: snapshot.deployments[0]!.id,
      path: "/v1/personal/socket",
    });
    await bridge.sendHostWebSocket({
      connectionId,
      type: "text",
      data: JSON.stringify({
        type: "client.attach",
        apiVersion: scopedPersonalApiVersion,
        generation: 1,
        interests: ["environment"],
        installed: { environment: "0" },
      }),
    });
    await vi.runAllTimersAsync();
    expect(frames).toContainEqual(
      expect.objectContaining({ type: "host.resource", reply: true, revisions: {} }),
    );
    stop();
    vi.useRealTimers();
  });
});
