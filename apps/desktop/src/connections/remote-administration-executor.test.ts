import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { HostNetworkSocketEvents } from "@opensteer/client/connections";
import { DesktopRemoteAdministrationExecutor } from "./remote-administration-executor.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";

it("executes Host intent once, reports progress, and resumes across its own socket reconnect", async () => {
  vi.useFakeTimers();
  const sockets: {
    events: HostNetworkSocketEvents;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const runtime = testPersonalHostRuntime({
    discovery: {
      canonicalOrigin: "http://127.0.0.1:4310",
      deploymentId: createId("deployment"),
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
      deploymentShape: { kind: "personal", defaultWorkspaceBacking: "local-directory" },
    },
    localOrigin: "http://127.0.0.1:4310",
    observedAt: new Date().toISOString(),
    ownership: "desktop-personal-host-supervisor",
    state: "ready",
    verification: "signed-loopback-discovery",
  });
  let complete!: () => void;
  const work = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const execute = vi.fn(
    async (
      _operation: import("@opensteer/protocol").PersonalRemoteAdministrationOperation,
      progress: (detail: string) => void,
    ) => {
      progress("Revoking Connect");
      await work;
    },
  );
  const executor = new DesktopRemoteAdministrationExecutor({
    runtime: { current: async () => runtime },
    network: {
      openWebSocket: (_input, events) => {
        const socket = { events, send: vi.fn(), close: vi.fn() };
        sockets.push(socket);
        return socket;
      },
    },
    execute,
  });
  const id = crypto.randomUUID();
  const operation = {
    id,
    executionId: id,
    intent: { action: "unlink" },
    state: "pending",
    detail: null,
  };
  try {
    await executor.connect();
    const first = sockets[0]!;
    first.events.open();
    first.events.message(JSON.stringify(operation));
    first.events.message(JSON.stringify(operation));
    expect(execute).toHaveBeenCalledOnce();
    expect(first.send.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual({
      operationId: id,
      state: "running",
      detail: "Revoking Connect",
    });
    first.events.close(1006, "route lost");
    complete();
    await vi.advanceTimersByTimeAsync(1000);
    const second = sockets[1]!;
    second.events.open();
    second.events.message(JSON.stringify(operation));
    expect(execute).toHaveBeenCalledOnce();
    expect(second.send).toHaveBeenCalledWith(
      JSON.stringify({ operationId: id, state: "succeeded", detail: null }),
    );
  } finally {
    complete();
    executor.stop();
    vi.useRealTimers();
  }
});

describe("executor shutdown", () => {
  it("does not attach when its desktop runtime is absent", async () => {
    const openWebSocket = vi.fn();
    const executor = new DesktopRemoteAdministrationExecutor({
      runtime: { current: async () => null },
      network: { openWebSocket },
      execute: vi.fn(),
    });
    await executor.connect();
    executor.stop();
    expect(openWebSocket).not.toHaveBeenCalled();
  });
});
