import { HostTransportError } from "@opensteer/client/connections";
// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ModelSelectionSchema } from "@opensteer/core";
import { MockHostClient, MockPersonalHost } from "@opensteer/client/mock";
import { HttpHostClient, unwrapRpcResult, type HostClient } from "@opensteer/client/host";
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
let http: HttpHostClient | undefined;
let transport: MockPersonalHost | undefined;
afterEach(() => {
  act(() => root?.unmount());
  http?.dispose();
  http = undefined;
  if (transport) transport.dispose();
  else client?.dispose();
  transport = undefined;
  document.body.replaceChildren();
});
async function mount(memoryPasses?: "active" | "waiting-for-model", edit = false) {
  client = new MockHostClient({ latencyMs: 0, ...(memoryPasses ? { memoryPasses } : {}) });
  await client.load();
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
  const { node, trigger } = await mount("waiting-for-model");
  expect(node.textContent).toContain("Waiting for an eligible AI account on the hosting computer.");
  expect(node.textContent).toContain("findings go into your agent’s memory");
  expect(node.querySelector(`a[href="/tasks/${trigger.anchorThreadId}"]`)).not.toBeNull();
  for (const label of ["Delete", "Run now", "Edit code"])
    expect(node.textContent).not.toContain(label);
  await act(async () => button(node, "Pause").click());
  await vi.waitFor(() => expect(button(node, "Resume")).toBeDefined(), { timeout: 2000 });
  // Paused by the person, it no longer says it is waiting.
  expect(node.textContent).not.toContain(
    "Waiting for an eligible AI account on the hosting computer.",
  );
  await act(async () => button(node, "Resume").click());
  await vi.waitFor(() => expect(button(node, "Pause")).toBeDefined(), { timeout: 2000 });
});
it("refuses the direct managed editor route", async () => {
  const { node } = await mount("active", true);
  expect(node.querySelector("form")).toBeNull();
});
it("opens the code editor once the connection returns, after a read the outage interrupted", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  harness.client = client;
  const trigger = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers.find(
    (t) => t.source.kind === "schedule" && t.source.schedule.kind === "cron",
  )!;
  const read = client.rpc["triggers.get"];
  let reachable = false;
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get(target, key) {
        if (key !== "triggers.get") return Reflect.get(target, key);
        return async (input: { triggerId: string }) => {
          if (!reachable) throw new HostTransportError("unreachable");
          return read(input);
        };
      },
    }),
  });
  client.connection.stop();
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/automations/${trigger.id}/edit`]}>
        <Routes>
          <Route path="/automations/:triggerId/edit" element={<AutomationEditorPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await act(async () => undefined);
  expect(node.querySelector("form")).toBeNull();
  expect(node.querySelector('[role="alert"]')).toBeNull();
  reachable = true;
  await act(async () => client.connection.start());
  await vi.waitFor(() => expect(node.querySelector("form")).not.toBeNull(), { timeout: 2000 });
});

it("keeps ordinary automation controls", async () => {
  const { node } = await mount();
  for (const label of ["Delete", "Run now", "Edit code"]) expect(node.textContent).toContain(label);
});
it("keeps managed background workers out of task Done controls", async () => {
  const { node, trigger } = await mount("active");
  await expect(client.setTaskDone(trigger.anchorThreadId, true)).rejects.toThrow(
    "Only tasks can be Done.",
  );
  expect(button(node, "Reopen worker")).toBeUndefined();
  expect(button(node, "Pause")).toBeDefined();
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

it("refreshes an authorized hidden worker on a scoped connection and ignores unrelated task changes", async () => {
  client = new MockHostClient({ latencyMs: 0, memoryPasses: "active" });
  const trigger = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers.find(
    (t) => t.systemRole === "memory-light",
  )!;
  const seed = unwrapRpcResult(await client.rpc["triggers.get"]({ triggerId: trigger.id }));
  let worker: NonNullable<typeof seed.anchorThread> = {
    ...seed.anchorThread!,
    listed: false,
    doneAt: "2026-11-03T10:00:00Z",
    inputQueuePaused: false,
  };
  await client.load();
  const host = (transport = new MockPersonalHost(client));
  const read = vi.fn(() => ({ ...seed, anchorThread: worker }));
  http = new HttpHostClient({
    baseUrl: "http://127.0.0.1",

    reconnectBaseDelayMs: 1,
    reconnectMaxDelayMs: 1,
    fetch: async (input, init) =>
      new URL(String(input)).pathname.endsWith("/triggers.get")
        ? Response.json({ ok: true, data: read() })
        : host.fetch(input, init),
    webSocketFactory: host.connect,
  });
  await http.load();
  const first = [...host.sockets][0]!;
  harness.client = http;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/automations/${trigger.id}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeDefined(), { timeout: 2000 });
  expect(http.getSnapshot().threads.some((t) => t.id === worker.id)).toBe(false);
  const changed = () => first.deliver({ type: "host.triggers-changed" });
  await act(async () => {
    worker = { ...worker, doneAt: null };
    changed();
  });
  await vi.waitFor(() => expect(button(node, "Reopen worker")).toBeUndefined(), { timeout: 2000 });
  await act(async () => {
    worker = { ...worker, inputQueuePaused: true };
    changed();
  });
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeDefined(), { timeout: 2000 });
  await act(async () => {
    worker = {
      ...worker,
      modelSelection: ModelSelectionSchema.parse({
        ...worker.modelSelection!,
        modelId: "changed-model",
      }),
    };
    changed();
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4), { timeout: 2000 });
  const unrelated = client
    .getSnapshot()
    .tasks?.entries.find(({ thread }) => thread.id !== worker.id);
  if (!unrelated) throw new Error("Missing unrelated task fixture");
  await act(async () => {
    await client.dispatch({
      type: "thread.rename",
      threadId: unrelated.thread.id,
      title: "Unrelated task renamed",
      idempotencyKey: "unrelated-rename",
    });
  });
  expect(read).toHaveBeenCalledTimes(4);
  await act(async () => {
    worker = { ...worker, inputQueuePaused: false };
    first.emit("close", { code: 1006, reason: "Disconnected" });
  });
  await vi.waitFor(() => expect([...host.sockets][0]).not.toBe(first), { timeout: 2000 });
  await vi.waitFor(() => expect(button(node, "Resume worker")).toBeUndefined(), { timeout: 2000 });
  expect(read).toHaveBeenCalledTimes(5);
});

it("shows live webhook address, marks legacy automations as needing an update without prefilling code, and preserves spaces in interpreter argv (AA5)", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  harness.client = client;
  const triggers = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers;
  const webhookTrigger = triggers.find((t) => t.source.kind === "webhook")!;
  const cronTrigger = triggers.find(
    (t) => t.source.kind === "schedule" && t.source.schedule.kind === "cron",
  )!;
  const baseRead = client.rpc["triggers.get"];
  const legacySource = "export default async function ({ opensteer }) { return opensteer; }";
  const webhookUrl = "https://home.opensteer.example/hooks/v1/whk_live_addr_123";
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get(target, key) {
        if (key !== "triggers.get") return Reflect.get(target, key);
        return async (input: { triggerId: string }) => {
          const detail = unwrapRpcResult(await baseRead(input));
          if (input.triggerId === webhookTrigger.id) {
            return {
              ok: true,
              data: {
                ...detail,
                webhook: { scope: "public" as const, url: webhookUrl },
              },
            };
          }
          if (input.triggerId === cronTrigger.id) {
            return {
              ok: true,
              data: {
                ...detail,
                revision: {
                  ...detail.revision,
                  legacySource,
                  script: null,
                },
              },
            };
          }
          return { ok: true, data: detail };
        };
      },
    }),
  });
  const dispatch = vi.spyOn(client, "dispatch").mockResolvedValue({} as never);

  // 1. Webhook detail shows live address, never "secret were shown once".
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter key="webhook" initialEntries={[`/automations/${webhookTrigger.id}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(node.textContent).toContain(webhookTrigger.name), {
    timeout: 2000,
  });
  expect(node.textContent).toContain(webhookUrl);
  expect(node.textContent).not.toContain("secret were shown once");

  // 2. Legacy detail says "Needs an update: ask your agent", never "Legacy program".
  await act(async () =>
    root!.render(
      <MemoryRouter key="legacy-detail" initialEntries={[`/automations/${cronTrigger.id}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(node.textContent).toContain(cronTrigger.name), { timeout: 2000 });
  expect(node.textContent).toContain("Needs an update: ask your agent");
  expect(node.textContent).not.toContain("Legacy program");

  // 3. Editor keeps editable script empty for legacy automation and preserves spaces in interpreter argv.
  await act(async () =>
    root!.render(
      <MemoryRouter key="legacy-edit" initialEntries={[`/automations/${cronTrigger.id}/edit`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
          <Route path="/automations/:triggerId/edit" element={<AutomationEditorPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(() => expect(node.querySelector("textarea")).not.toBeNull(), { timeout: 2000 });
  const textarea = node.querySelector("textarea")!;
  expect(textarea.value).toBe("");
  expect(node.textContent).toContain("Needs an update: ask your agent");
  expect(node.textContent).toContain(legacySource);

  const setNativeValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const exeInput = node.querySelector<HTMLInputElement>(
    'input[aria-label="Interpreter executable"]',
  )!;
  expect(exeInput).not.toBeNull();
  await act(async () => setNativeValue(exeInput, "/Applications/My App/python3"));
  const addArg = button(node, "Add argument");
  expect(addArg).toBeDefined();
  await act(async () => addArg.click());
  const arg1Input = node.querySelector<HTMLInputElement>(
    'input[aria-label="Interpreter argument 1"]',
  )!;
  await act(async () => setNativeValue(arg1Input, "-u"));
  await act(async () => setNativeValue(textarea, "print('ok')"));
  await act(async () => {
    node
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalled(), { timeout: 2000 });
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "trigger.update",
      input: expect.objectContaining({
        script: {
          interpreter: ["/Applications/My App/python3", "-u"],
          text: "print('ok')",
        },
      }),
    }),
  );
});

it("shows a plain notice instead of empty output when a firing's output was pruned", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  harness.client = client;
  const trigger = unwrapRpcResult(await client.rpc["triggers.list"]({})).triggers.find(
    (t) => t.source.kind === "schedule" && t.source.schedule.kind === "cron",
  )!;
  const baseDetail = unwrapRpcResult(await client.rpc["triggers.get"]({ triggerId: trigger.id }));
  const prunedDetail = {
    ...baseDetail,
    occurrences: [
      {
        ...baseDetail.occurrences[0]!,
        outputPrunedAt: "2026-11-23T00:00:00.000Z",
        result: null,
        status: "succeeded" as const,
        stderr: "",
        stdout: "",
      },
    ],
  };
  Object.defineProperty(client, "rpc", {
    value: new Proxy(client.rpc, {
      get(target, key) {
        if (key !== "triggers.get") return Reflect.get(target, key);
        return async () => ({ ok: true as const, data: prunedDetail });
      },
    }),
  });
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[`/automations/${trigger.id}`]}>
        <Routes>
          <Route path="/automations/:triggerId" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  );
  await vi.waitFor(
    () => expect(node.textContent).toContain("Opensteer no longer keeps this firing's output."),
    { timeout: 2000 },
  );
  expect(node.querySelector("details.automation-run__output")).toBeNull();
});

it("lists secret names and lets the person add, replace, and remove secrets with honest copy", async () => {
  const { node } = await mount();
  expect(node.textContent).toContain("Secrets");
  expect(node.textContent).toContain("can read them there");
  expect(node.textContent?.toLowerCase()).not.toContain("agent cannot see");

  // Add a secret
  await act(async () => button(node, "Add").click());
  const nameInput = node.querySelector<HTMLInputElement>('input[name="secret-name"]')!;
  const valueInput = node.querySelector<HTMLInputElement>('input[name="secret-value"]')!;
  expect(nameInput).not.toBeNull();
  expect(valueInput.type).toBe("password");
  const setInput = (el: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  await act(async () => {
    setInput(nameInput, "API_TOKEN");
    setInput(valueInput, "secret-value-1");
  });
  await act(async () => button(node, "Save").click());
  await vi.waitFor(() => expect(node.textContent).toContain("API_TOKEN"), { timeout: 2000 });
  expect(node.textContent).not.toContain("secret-value-1");

  // Replace the secret
  await act(async () => button(node, "Replace").click());
  const replaceInput = node.querySelector<HTMLInputElement>('input[name="secret-value"]')!;
  expect(replaceInput.type).toBe("password");
  await act(async () => {
    setInput(replaceInput, "secret-value-2");
  });
  await act(async () => button(node, "Save").click());
  await vi.waitFor(() => expect(node.querySelector('input[name="secret-value"]')).toBeNull(), {
    timeout: 2000,
  });
  expect(node.textContent).toContain("API_TOKEN");
  expect(node.textContent).not.toContain("secret-value-2");

  // Remove the secret
  await act(async () => button(node, "Remove").click());
  await vi.waitFor(() => expect(node.textContent).not.toContain("API_TOKEN"), { timeout: 2000 });
});
