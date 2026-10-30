import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import type { WebContents } from "electron";
import type { DictationEvent } from "@opensteer/protocol/dictation";
import { DictationService } from "./dictation-service.js";
const first = "00000000-0000-4000-8000-000000000001";
const second = "00000000-0000-4000-8000-000000000002";
function setup(overrides = {}) {
  let emit!: (event: DictationEvent) => void;
  let lost!: () => void;
  const client = {
    call: vi.fn(async () => ({ available: false, reason: "language" })),
    close: vi.fn(),
    disconnect: vi.fn(),
    subscribe: (event: typeof emit, disconnect: typeof lost) => {
      emit = event;
      lost = disconnect;
      return () => {};
    },
  };
  const service = new DictationService({
    client,
    platform: "darwin",
    arch: "arm64",
    osMajor: 25,
    openSettings: async () => undefined,
    ...overrides,
  });
  const window = () =>
    Object.assign(new EventEmitter(), {
      send: vi.fn(),
      isDestroyed: () => false,
    }) as unknown as WebContents;
  return {
    client,
    service,
    window,
    emit: (event: DictationEvent) => emit(event),
    lost: () => lost(),
  };
}
describe("Mac dictation ownership", () => {
  for (const method of ["start", "download"] as const) {
    it(`rejects a finished ${method} replay without acquiring ownership`, async () => {
      const { service, window, client, emit } = setup();
      const owner = window();
      await service.command(owner, method, { session: first });
      emit({ type: "ended", session: first, seq: 1, reason: "completed", error: null });
      await expect(service.command(owner, method, { session: first })).rejects.toThrow(
        "already ended",
      );
      expect(client.call).toHaveBeenCalledTimes(1);
      expect(owner.send).toHaveBeenCalledTimes(1);
      await service.command(owner, method, { session: second });
      expect(client.call).toHaveBeenLastCalledWith(method, second);
    });
    for (const overrides of [
      { platform: "linux" },
      { osMajor: 24 },
      { arch: "x64" },
      { translated: true },
    ]) {
      it(`rejects direct ${method} on ${JSON.stringify(overrides)} without launching`, async () => {
        const { service, window, client } = setup(overrides);
        await expect(service.command(window(), method, { session: first })).rejects.toThrow(
          "unavailable",
        );
        expect(client.call).not.toHaveBeenCalled();
      });
    }
  }
  it("makes capture and downloads exclusive and checks stop/cancel ownership", async () => {
    const { service, window, client, emit } = setup();
    const a = window();
    const b = window();
    await service.command(a, "download", { session: first });
    await service.command(b, "start", { session: second });
    expect(b.send).toHaveBeenCalledWith(expect.any(String), {
      type: "ended",
      session: second,
      seq: 1,
      reason: "failed",
      error: "busy",
    });
    await service.command(b, "cancel", { session: first });
    expect(client.call).toHaveBeenCalledTimes(1);
    emit({ type: "downloading", session: first, seq: 1, progress: 0.5 });
    expect(a.send).toHaveBeenCalledTimes(1);
    emit({ type: "ended", session: first, seq: 2, reason: "completed", error: null });
    await service.command(b, "start", { session: "00000000-0000-4000-8000-000000000003" });
    expect(client.call).toHaveBeenLastCalledWith("start", "00000000-0000-4000-8000-000000000003");
  });
  for (const method of ["start", "download"] as const) {
    for (const lifecycle of ["destroyed", "render-process-gone", "did-start-navigation"]) {
      it(`cancels ${method} on ${lifecycle}`, async () => {
        const { service, window, client, emit } = setup();
        const owner = window();
        await service.command(owner, method, { session: first });
        owner.emit(lifecycle, {}, "app://opensteer/", false, true);
        expect(client.call).toHaveBeenLastCalledWith("cancel", first);
        emit({ type: "listening", session: first, seq: 1 });
        expect(owner.send).not.toHaveBeenCalled();
      });
    }
  }
  it("interrupts for sleep/lock and terminates once on connection loss", async () => {
    const { service, window, client, lost, emit } = setup();
    const owner = window();
    await service.command(owner, "start", { session: first });
    emit({ type: "listening", session: first, seq: 1 });
    service.interrupt();
    expect(client.call).toHaveBeenLastCalledWith("interrupt");
    lost();
    lost();
    expect(owner.send).toHaveBeenCalledTimes(2);
    expect(owner.send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ seq: 2, error: "service-unavailable" }),
    );
  });
  it("cancels sequence gaps and closes malformed native input", async () => {
    const { service, window, client, emit } = setup();
    const owner = window();
    await service.command(owner, "start", { session: first });
    emit({ type: "listening", session: first, seq: 2 });
    expect(client.call).toHaveBeenLastCalledWith("cancel", first);
    expect(owner.send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "recognition-failed" }),
    );
    await service.command(owner, "start", { session: second });
    emit({ type: "bad" } as unknown as DictationEvent);
    expect(client.disconnect).toHaveBeenCalled();
    expect(owner.send).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "service-unavailable" }),
    );
  });
  it("fences a late interrupt rejection from the next session", async () => {
    const { service, window, client, emit } = setup();
    const owner = window();
    await service.command(owner, "start", { session: first });
    let rejectInterrupt!: (error: Error) => void;
    client.call.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectInterrupt = reject;
        }),
    );
    service.interrupt();
    emit({ type: "ended", session: first, seq: 1, reason: "interrupted", error: null });
    await service.command(owner, "start", { session: second });
    rejectInterrupt(new Error("old connection"));
    await Promise.resolve();
    await Promise.resolve();
    emit({ type: "listening", session: second, seq: 1 });
    expect(owner.send).toHaveBeenCalledTimes(2);
    expect(owner.send).toHaveBeenLastCalledWith(expect.any(String), {
      type: "listening",
      session: second,
      seq: 1,
    });
  });
  it("closes without waiting for finalization", async () => {
    const { service, window, client } = setup();
    await service.command(window(), "start", { session: first });
    service.close();
    expect(client.close).toHaveBeenCalled();
  });
  for (const [overrides, reason] of [
    [{ platform: "linux" }, "platform"],
    [{ osMajor: 24 }, "os"],
    [{ arch: "x64" }, "hardware"],
    [{ translated: true }, "hardware"],
  ] as const) {
    it(`gates unsupported ${JSON.stringify(overrides)} without launching`, async () => {
      const { service, client } = setup(overrides);
      expect(await service.availability()).toEqual({ available: false, reason });
      expect(client.call).not.toHaveBeenCalled();
    });
  }
});
