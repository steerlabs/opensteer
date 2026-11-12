// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
const shell = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../app-shell.js", () => ({ useShell: () => shell.value }));
vi.mock("../../start-task.js", () => ({
  useStartTask: () => vi.fn(),
  useThreadPath: () => vi.fn(),
}));
const { AgentDevicesSection } = await import("./agent-devices.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let host: MockHostClient;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
});
it("marks the computer Opensteer runs on", async () => {
  host = new MockHostClient({ latencyMs: 0 });
  shell.value = { hostClient: host, snapshot: host.getSnapshot(), desktopBridge: null };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      <MemoryRouter>
        <AgentDevicesSection />
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() =>
    expect(document.querySelectorAll(".settings-device-list li").length).toBeGreaterThan(0),
  );
  expect(
    [...document.querySelectorAll(".chip")].filter((chip) => chip.textContent === "Runs Opensteer"),
  ).toHaveLength(1);
});

