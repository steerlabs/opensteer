import { withTimeout } from "@opensteer/shared/withTimeout";
import { DesktopSupervisor } from "./desktop-supervisor.js";
import { describe, expect, it, vi } from "vitest";
import { createId } from "@opensteer/core";
import type { HostNetworkSocketEvents } from "@opensteer/client/connections";
import { DesktopRemoteAdministrationExecutor } from "./remote-administration-executor.js";
import { testPersonalHostRuntime } from "../supervisor/personal-host-runtime-test-support.js";

it("executes Host intent once, reports progress, and resumes across its own socket reconnect", async () => {
  vi.useFakeTimers();
  let holdUpdate = true;
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
      deploymentShape: { kind: "personal" },
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
  const supervisor = new DesktopSupervisor({
    state: () => ({
      status: "idle",
      currentVersion: "1.0.0",
      channel: "stable",
      availableVersion: null,
      latestVersion: null,
      failed: null,
      downloadPercent: null,
    }),
    authorization: () => "Bearer desktop-process-capability",
    runtime: { current: async () => runtime },
    network: {
      openWebSocket: (input, events) => {
        expect(input.authorization).toBe("Bearer desktop-process-capability");
        const socket = {
          events,
          send: vi.fn((data: string) => {
            const message = JSON.parse(data) as { messageId?: string; type: string };
            if (message.messageId && !(holdUpdate && message.type === "desktop-update.progress"))
              events.message(
                JSON.stringify({ type: "ack", messageId: message.messageId, accepted: true }),
              );
          }),
          close: vi.fn(),
        };
        sockets.push(socket);
        return socket;
      },
    },
  });
  const executor = new DesktopRemoteAdministrationExecutor({ supervisor, execute });
  const id = crypto.randomUUID();
  const operation = {
    id,
    executionId: id,
    intent: { action: "unlink" },
    state: "pending",
    detail: null,
  };
  try {
    await supervisor.connect();
    const first = sockets[0]!;
    first.events.open();
    first.events.message(JSON.stringify({ type: "remote-access.operation", operation }));
    first.events.message(JSON.stringify({ type: "remote-access.operation", operation }));
    expect(execute).toHaveBeenCalledOnce();
    expect(
      first.send.mock.calls.map(
        ([message]) => (JSON.parse(message) as { progress: unknown }).progress,
      ),
    ).toContainEqual({
      operationId: id,
      state: "running",
      detail: "Revoking Connect",
    });
    const phaseId = crypto.randomUUID();
    const phase = supervisor.acknowledge({
      type: "desktop-update.progress",
      messageId: phaseId,
      operationId: crypto.randomUUID(),
      state: "staged",
      fromVersion: "1.0.0",
      targetVersion: "1.0.1",
      detail: null,
    });
    first.events.close(1006, "route lost");
    complete();
    await vi.advanceTimersByTimeAsync(1000);
    const second = sockets[1]!;
    holdUpdate = false;
    second.events.open();
    await withTimeout(phase, 1000, {
      timeoutError: () => new Error("Reconnected supervisor never acknowledged the staged target"),
    });
    expect(second.send.mock.calls.map(([message]) => JSON.parse(message))).toContainEqual(
      expect.objectContaining({ type: "desktop-update.progress", messageId: phaseId }),
    );
    const firstHello = JSON.parse(first.send.mock.calls[0]![0]) as { incarnationId: string };
    const secondHello = JSON.parse(second.send.mock.calls[0]![0]) as { incarnationId: string };
    expect(secondHello.incarnationId).toBe(firstHello.incarnationId);
    second.events.message(JSON.stringify({ type: "remote-access.operation", operation }));
    expect(execute).toHaveBeenCalledOnce();
    expect(
      second.send.mock.calls.map(
        ([message]) => (JSON.parse(message) as { progress: unknown }).progress,
      ),
    ).toContainEqual({ operationId: id, state: "succeeded", detail: null });
  } finally {
    complete();
    executor.stop();
    supervisor.stop();
    vi.useRealTimers();
  }
});

describe("executor shutdown", () => {
  it("does not attach when its desktop runtime is absent", async () => {
    const openWebSocket = vi.fn();
    const supervisor = new DesktopSupervisor({
      state: () => ({
        status: "idle",
        currentVersion: "1.0.0",
        channel: "stable",
        availableVersion: null,
        latestVersion: null,
        failed: null,
        downloadPercent: null,
      }),
      authorization: () => "Bearer desktop-process-capability",
      runtime: { current: async () => null },
      network: { openWebSocket },
    });
    await supervisor.connect();
    supervisor.stop();
    expect(openWebSocket).not.toHaveBeenCalled();
  });
});
