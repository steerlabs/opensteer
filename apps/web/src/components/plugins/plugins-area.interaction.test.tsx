// @vitest-environment happy-dom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { HostClient } from "@opensteer/client/host";
import { PluginsArea } from "./plugins-area.js";

/*
 * The Plugins area's background controls a person must be able to reach, over
 * the mock Host: endpoints existed for these while no screen offered them.
 *
 * What can go wrong:
 * - a manual webhook setup shows its instructions but has nothing to finish
 *   it with, or a setup that asks for nothing has no "Done";
 * - a saved account outlives every plugin that used it with nowhere to remove it;
 * - a live workflow run that isn't among the first rows has no Stop;
 * - background work the Host publishes leaves an open plugin showing what was.
 */

const harness = vi.hoisted(() => ({ client: null as unknown as HostClient }));
vi.mock("../app-shell.js", () => ({
  useShell: () => ({
    hostClient: harness.client,
    snapshot: useSyncExternalStore(harness.client.subscribe, harness.client.getSnapshot),
    openMobileNavigation: () => {},
  }),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let client: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.dispose();
  document.body.replaceChildren();
});

async function host() {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  // The mock engine takes a moment to start on its first read, as the real one does.
  await client.rpc["plugins.accounts.list"]({});
  harness.client = client;
  return client;
}

async function mount(path: string, existing?: MockHostClient) {
  const client = existing ?? (await host());
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <PluginsArea />
      </MemoryRouter>,
    ),
  );
  return { client, node };
}

async function until(condition: () => boolean, what: string) {
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      if (!condition()) throw new Error(`${what} never happened`);
    },
    { timeout: 4_000 },
  );
}
const text = () => document.body.textContent ?? "";
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button, a")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === label ||
      candidate.textContent?.trim() === label ||
      candidate.querySelector(".card__row-title")?.textContent === label,
  );
  if (!found) throw new Error(`No control ${label}`);
  return found as HTMLButtonElement;
}
async function press(label: string) {
  await act(async () => button(label).click());
}
async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(
      field,
      value,
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function field(label: string): HTMLInputElement {
  const prompt = [...document.querySelectorAll("label > span, .action-form__prompt")].find((node) =>
    node.textContent?.startsWith(label),
  );
  const input =
    prompt?.closest("label")?.querySelector("input") ??
    (prompt?.id ? document.querySelector(`input[aria-labelledby="${prompt.id}"]`) : null);
  if (!(input instanceof HTMLInputElement)) throw new Error(`No field ${label}`);
  return input;
}
async function webhookStep(host: MockHostClient, pluginId: string, webhookId: string) {
  const setup = await host.rpc["plugins.webhook.setup.get"]({ pluginId, webhookId });
  if (!setup.ok) throw new Error("setup read failed");
  return setup.data.step;
}

it("finishes a manual webhook setup with the secret and field the service gave", async () => {
  const { client } = await mount("/settings/plugins/installed/plg_linear");
  await until(() => text().includes("Project updates"), "the Linear plugin loaded");
  await press("Finish setting up Project updates");
  await until(() => text().includes("Workspace ID"), "the setup form opened");
  expect(text()).toContain("https://hooks.opensteer.example/hooks/v1/plugins/plg_linear/");
  expect(button("Done").disabled).toBe(true);
  await type(field("Signing secret from the service"), "whsec_from_linear");
  await type(field("Workspace ID"), "acme");
  expect(button("Done").disabled).toBe(false);
  await press("Done");
  await until(() => !text().includes("Finish setting up Project updates"), "the row updated");
  expect(await webhookStep(client, "plg_linear", "whk_linear_projects")).toBe("done");
});

it("finishes a manual webhook setup that asks for nothing with Done", async () => {
  const { client } = await mount("/settings/plugins/installed/plg_stripe");
  await until(() => text().includes("Payment events"), "the Stripe plugin loaded");
  await press("Finish setting up Payment events");
  await until(() => text().includes("Signing secret to give the service"), "the setup opened");
  // The secret Opensteer made is shown to copy; nothing is asked, so Done finishes it.
  expect(text()).toContain("whsec_mock_");
  expect(button("Done").disabled).toBe(false);
  await press("Done");
  await until(() => !text().includes("Finish setting up Payment events"), "the row updated");
  expect(await webhookStep(client, "plg_stripe", "whk_stripe_payments")).toBe("done");
});

it("removes a saved account after every plugin is gone, from the Plugins area", async () => {
  const client = await host();
  const installed = await client.rpc["plugins.installed.list"]({});
  if (!installed.ok) throw new Error("installed read failed");
  for (const plugin of installed.data.plugins ?? [])
    await client.dispatch({
      type: "plugins.remove",
      idempotencyKey: `remove:${plugin.id}`,
      pluginId: plugin.id,
    });
  await mount("/settings/plugins", client);
  await until(() => text().includes("No plugins yet"), "the empty Plugins list loaded");
  await press("Connected accounts");
  await until(() => text().includes("Live account"), "the saved accounts loaded");
  await press("Remove Live account");
  await until(() => text().includes("Remove Live account?"), "the confirmation opened");
  expect(text()).toContain("No plugin uses it.");
  await press("Remove account");
  await until(() => !text().includes("Live account"), "the account left the list");
  const accounts = await client.rpc["plugins.accounts.list"]({});
  if (!accounts.ok) throw new Error("accounts read failed");
  expect(accounts.data.accounts.some(({ id }) => id === "acc_stripe_live")).toBe(false);
});

it("stops a live workflow run among finished ones", async () => {
  const { client } = await mount("/settings/plugins/installed/plg_linear");
  await until(() => text().includes("Import backlog"), "the workflow runs loaded");
  const stop = [...document.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) =>
    candidate.getAttribute("aria-label")?.startsWith("Stop Import backlog run"),
  );
  expect(stop).toHaveLength(1);
  await act(async () => stop[0]!.click());
  await until(
    () => !document.querySelector('button[aria-label^="Stop Import backlog run"]'),
    "the run stopped",
  );
  const runs = await client.rpc["plugins.workflow.runs"]({ pluginId: "plg_linear" });
  if (!runs.ok) throw new Error("runs read failed");
  expect(runs.data.runs.find(({ id }) => id === "wfr_6a8")?.status).toBe("terminated");
});

it("shows background work the Host publishes on the open plugin, without navigating", async () => {
  const { client } = await mount("/settings/plugins/installed/plg_linear");
  const finish = () =>
    document.querySelector('button[aria-label="Finish setting up Project updates"]');
  await until(() => finish() !== null, "the Linear plugin loaded");
  client.enginePlugins.confirmWebhookInBackground("plg_linear", "whk_linear_projects");
  await until(() => finish() === null, "the page reread after the Host's change notice");
  expect(text()).toContain("Project updates");
});

it("reaches every installed plugin past the first page", async () => {
  window.history.replaceState(null, "", "/?mock-plugins=many");
  try {
    await mount("/settings/plugins");
    await until(() => text().includes("Helper 001"), "the first page loaded");
    expect(text()).not.toContain("Helper 120");
    while (!text().includes("Helper 120")) {
      await press("Show more plugins");
      await until(() => !text().includes("Loading…"), "the next page loaded");
    }
    expect(document.querySelectorAll('[role="listitem"][href*="plg_helper_"]')).toHaveLength(120);
    expect(text()).not.toContain("Show more plugins");
  } finally {
    window.history.replaceState(null, "", "/");
  }
});
