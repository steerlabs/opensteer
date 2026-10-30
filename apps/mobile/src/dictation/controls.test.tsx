import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DictationController } from "@opensteer/client/dictation";
import type { DictationPort } from "@opensteer/protocol/dictation";
import "../screens/thread-settings.test-support.js";
import { DictationBar } from "./controls.js";

vi.mock("react-native-reanimated", () => ({ useReducedMotion: () => false }));
let cleanup: (() => void) | undefined;
afterEach(async () => {
  await act(async () => cleanup?.());
  document.body.replaceChildren();
  vi.useRealTimers();
});
it("shows cancel, waveform, elapsed, keep and send immediately while starting", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T12:00:00Z"));
  const port: DictationPort = {
    availability: async () => ({
      available: true,
      locale: "en-US",
      languageName: "English",
      model: "installed",
      microphone: "granted",
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    download: vi.fn(async () => {}),
    openMicrophoneSettings: vi.fn(async () => {}),
    subscribe: () => () => {},
  };
  const controller = new DictationController({
    port,
    createId: () => "00000000-0000-4000-8000-000000000001",
  });
  await controller.refresh();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    root.unmount();
    controller.dispose();
  };
  const send = vi.fn();
  function Recording() {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return (
      <DictationBar
        controller={controller}
        snapshot={snapshot}
        owner="draft"
        canSend
        onSend={send}
      />
    );
  }
  await act(async () => {
    root.render(<Recording />);
    controller.start({
      owner: "draft",
      read: () => ({ text: "", selection: { start: 0, end: 0 } }),
      commit: vi.fn(),
    });
  });
  expect(controller.getSnapshot().phase).toBe("starting");
  expect(document.body.textContent).toContain("0:00");
  expect(document.body.textContent).not.toMatch(/Starting|Checking/);
  expect(document.querySelector('[aria-label="Cancel dictation"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="Stop dictation"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(document.body.textContent).toContain("0:02");
  await act(async () =>
    document.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click(),
  );
  expect(send).toHaveBeenCalledOnce();
});
