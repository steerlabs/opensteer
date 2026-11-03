// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { unwrapRpcResult, type HostClient } from "@opensteer/client/host";
import { AutomationDetailPage } from "./automation-detail.js";
import { AutomationEditorPage } from "./automation-editor.js";

const harness = vi.hoisted(() => ({ client: null as unknown as HostClient }));
vi.mock("../app-shell.js", () => ({
  useShell: () => ({
    hostClient: harness.client,
    snapshot: useSyncExternalStore(harness.client.subscribe, harness.client.getSnapshot),
    openMobileNavigation: () => {},
  }),
}));
vi.mock("../toast.js", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let client: MockHostClient;
afterEach(() => {
  act(() => root?.unmount());
  client?.dispose();
  document.body.replaceChildren();
});
async function mount(memoryPasses?: "active" | "no-light-model", edit = false) {
  client = new MockHostClient({ latencyMs: 0, ...(memoryPasses ? { memoryPasses } : {}) });
  harness.client = client;
  const triggers = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers;
  const trigger = memoryPasses
    ? triggers.find((t) => t.systemRole === "memory-light")!
    : triggers.find((t) => t.source.kind === "schedule" && t.source.schedule.kind === "cron")!;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/automations/${trigger.id}${edit ? "/edit" : ""}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
          <Route path="/automations/:triggerId/edit" element={<AutomationEditorPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(
    () =>
      expect(node.textContent).toContain(
        edit ? "Opensteer manages" : trigger.systemRole ? "Light memory pass" : trigger.name,
      ),
    { timeout: 2000 },
  );
  return { node, trigger };
}
function button(node: HTMLElement, name: string) {
  return [...node.querySelectorAll("button")].find((b) => b.textContent?.trim() === name)!;
}
it("inspects managed passes, links the worker, and retains Pause/Resume without destructive controls", async () => {
  const { node, trigger } = await mount("no-light-model");
  expect(node.textContent).toContain("This engine has no light model");
  expect(node.textContent).toContain("findings reach you through Chat");
  expect(node.querySelector(`a[href="/threads/${trigger.anchorThreadId}"]`)).not.toBeNull();
  for (const label of ["Delete", "Run now", "Edit code"])
    expect(node.textContent).not.toContain(label);
  await act(async () => button(node, "Resume").click());
  await vi.waitFor(() => expect(button(node, "Pause")).toBeDefined(), { timeout: 2000 });
  await act(async () => button(node, "Pause").click());
  await vi.waitFor(() => expect(button(node, "Resume")).toBeDefined(), { timeout: 2000 });
});
it("refuses the direct managed editor route", async () => {
  const { node } = await mount("active", true);
  expect(node.querySelector("form")).toBeNull();
});
it("keeps ordinary automation controls", async () => {
  const { node } = await mount();
  for (const label of ["Delete", "Run now", "Edit code"]) expect(node.textContent).toContain(label);
});
it("reads current worker recovery state after other-device lifecycle changes", async () => {
  const { node, trigger } = await mount("active");
  await act(async () => {
    await client.setTaskDone(trigger.anchorThreadId, true);
  });
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeDefined(), { timeout: 2000 });
  await act(async () => button(node, "Reopen worker").click());
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeUndefined(), { timeout: 2000 });
  expect(button(node, "Resume")).toBeDefined();
});

it("offers Resume worker for a stopped managed worker", async () => {
  const { node, trigger } = await mount("active");
  const read = client.rpc["triggers.get"];
  let stopped = true;
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get(target, key) {
        if (key !== "triggers.get") return Reflect.get(target, key);
        return async (input: { triggerId: string }) => {
          const detail = unwrapRpcResult(await read(input));
          return {
            ok: true,
            data: {
              ...detail,
              anchorThread: detail.anchorThread
                ? { ...detail.anchorThread, inputQueuePaused: stopped }
                : null,
            },
          };
        };
      },
    }),
  });
  const resume = vi.spyOn(client, "resumeThreadInputQueue").mockImplementation(async () => {
    stopped = false;
  });
  await act(async () =>
    client.dispatch({
      type: "trigger.status.set",
      triggerId: trigger.id,
      status: "paused",
      idempotencyKey: "cross-device-stop",
    }),
  );
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeDefined(), { timeout: 2000 });
  await act(async () => button(node, "Resume worker").click());
  expect(resume).toHaveBeenCalledWith(trigger.anchorThreadId);
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeUndefined(), { timeout: 2000 });
});
