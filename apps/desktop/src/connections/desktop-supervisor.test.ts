import { createId } from "@opensteer/core";
import { statesApiVersion } from "@opensteer/deployment-authority";
import type { HostNetwork } from "@opensteer/client/connections";
import { expect, it } from "vitest";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";
import { DesktopSupervisor } from "./desktop-supervisor.js";

it("states the epoch the Host requires before it admits the executor socket", async () => {
  const runtime = testPersonalHostRuntime({
    discovery: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { kind: "personal" as const },
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: "2026-08-20T12:00:00.000Z",
    ownership: "desktop-personal-host-supervisor",
    schemaVersion: 1,
    state: "ready",
    verification: "signed-loopback-discovery",
  });
  const opened: Parameters<HostNetwork["openWebSocket"]>[0][] = [];
  const supervisor = new DesktopSupervisor({
    authorization: () => "Bearer capability",
    network: {
      openWebSocket: (input) => {
        opened.push(input);
        return { close: () => {}, send: () => {} };
      },
    },
    runtime: { current: async () => runtime },
    state: () => ({ status: "idle" }) as never,
  });
  try {
    await supervisor.connect();
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0]!.url).pathname).toBe("/v1/desktop-supervisor");
    expect(statesApiVersion(opened[0]!.headers ?? {}, "personal")).toBe(true);
  } finally {
    supervisor.stop();
  }
});
