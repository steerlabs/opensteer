// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import type { HostClient } from "@opensteer/client/host";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";
import { addressWords } from "../ui/address-words.js";

/*
 * The phone's Plugins screens reach the background controls a person needs,
 * over the mock Host: endpoints existed for these while no screen offered them.
 *
 * What can go wrong:
 * - a manual webhook setup shows its instructions but has nothing to finish
 *   it with, or a setup that asks for nothing has no "Done";
 * - a saved account outlives every plugin that used it with nowhere to remove it;
 * - a live workflow run that isn't among the first rows has no Stop;
 * - an app built into Opensteer, such as iMessage, can't be found in the
 *   catalog, which says nothing matches.
 */

const state = vi.hoisted(() => ({
  host: null as HostClient | null,
  pages: [] as NativeSettingsPageProps[],
  navigate: vi.fn(),
  settingUp: null as string | null,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, Platform: { OS: "ios" } }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate, goBack: () => undefined }),
}));
vi.mock("./deployment-gate.js", () => ({
  useAttachedHost: () => state.host,
  DeploymentGate: () => null,
}));
const mobile = vi.hoisted(() => ({
  // One object, as the real context gives: a new one each render re-runs every read.
  client: { getSnapshot: () => ({ selection: { hostClient: state.host } }) },
}));
vi.mock("../ui/mobile-client-context.js", () => ({ useMobileClient: () => mobile.client }));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./confirm.js", () => ({
  confirmDestructive: (input: { readonly onConfirm: () => void }) => input.onConfirm(),
}));
vi.mock("../thread/app-frame.js", () => ({ AppFrame: () => null }));
vi.mock("../ui/sheet.js", () => ({ Sheet: () => null }));
vi.mock("./device-app-setup-sheet.js", () => ({
  DeviceAppSetupSheet: (props: { readonly definition: { readonly id: string } }) => {
    state.settingUp = props.definition.id;
    return null;
  },
}));
vi.mock("./local-server-sections.js", () => ({
  useLocalServerSections: () => ({ sections: [], sheet: null }),
}));
vi.mock("./native-settings-page.js", () => ({
  NativeSettingsPage: (props: NativeSettingsPageProps) => {
    state.pages.push(props);
    return null;
  },
}));
const { PluginDetailScreen } = await import("./plugin-detail.js");
const { PluginAccountsScreen } = await import("./plugin-accounts.js");
const { PluginCatalogScreen, PluginsScreen } = await import("./plugins.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let client: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.dispose();
  state.pages = [];
  state.host = null;
  state.settingUp = null;
  state.navigate.mockClear();
});

async function host() {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  // The mock engine takes a moment to start on its first read, as the real one does.
  await client.rpc["plugins.accounts.list"]({});
  state.host = client;
  return client;
}
async function render(element: React.ReactElement) {
  root = createRoot(document.createElement("div"));
  await act(async () => root!.render(element));
}
/** The latest render of the main page, or of the sheet titled `sheet`. */
function page(sheet?: string) {
  const found = state.pages.findLast((props) =>
    sheet ? props.sheet?.title === sheet : !props.sheet,
  );
  if (!found) throw new Error(`No page${sheet ? ` ${sheet}` : ""}`);
  return found;
}
const rows = (props: NativeSettingsPageProps) => props.sections.flatMap((section) => section.rows);
function row(props: NativeSettingsPageProps, test: (row: NativeSettingsRow) => boolean) {
  return rows(props).find(test);
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
const has = (sheet: string | undefined, label: string) => {
  try {
    return rows(page(sheet)).some((candidate) => candidate.label === label);
  } catch {
    return false;
  }
};
async function press(sheet: string | undefined, label: string) {
  const found = row(page(sheet), (candidate) => candidate.label === label);
  if (found?.kind !== "button" && found?.kind !== "primary") throw new Error(`No button ${label}`);
  if (found.disabled) throw new Error(`${label} is disabled`);
  await act(async () => found.onPress());
}
async function enter(sheet: string, label: string, value: string) {
  const found = row(page(sheet), (candidate) => candidate.label === label);
  if (found?.kind !== "input") throw new Error(`No field ${label}`);
  await act(async () => found.onChange(value));
}
async function webhookStep(pluginId: string, webhookId: string) {
  const setup = await client!.rpc["plugins.webhook.setup.get"]({ pluginId, webhookId });
  if (!setup.ok) throw new Error("setup read failed");
  return setup.data.step;
}
const detail = (pluginId: string) => (
  <PluginDetailScreen route={{ params: { deploymentId: "dep_fixture", pluginId } } as never} />
);

it("finishes a manual webhook setup with the secret and field the service gave", async () => {
  await host();
  await render(detail("plg_linear"));
  await until(() => has(undefined, "Finish setting up Project updates"), "the plugin loaded");
  await press(undefined, "Finish setting up Project updates");
  const sheet = "Set up Project updates";
  await until(() => has(sheet, "Done"), "the setup sheet opened");
  expect(
    row(page(sheet), (candidate) => candidate.key === "url")?.kind === "button" &&
      rows(page(sheet)).some(
        (candidate) =>
          "detail" in candidate &&
          candidate.detail?.startsWith(
            addressWords("https://hooks.opensteer.example/hooks/v1/plugins/"),
          ),
      ),
  ).toBe(true);
  expect(row(page(sheet), (candidate) => candidate.label === "Done")).toMatchObject({
    disabled: true,
  });
  await enter(sheet, "Signing secret from the service", "whsec_from_linear");
  await enter(sheet, "Workspace ID", "acme");
  await press(sheet, "Done");
  await until(() => !has(undefined, "Finish setting up Project updates"), "the row updated");
  expect(await webhookStep("plg_linear", "whk_linear_projects")).toBe("done");
});

it("finishes a manual webhook setup that asks for nothing with Done", async () => {
  await host();
  await render(detail("plg_stripe"));
  await until(() => has(undefined, "Finish setting up Payment events"), "the plugin loaded");
  await press(undefined, "Finish setting up Payment events");
  const sheet = "Set up Payment events";
  await until(() => has(sheet, "Done"), "the setup sheet opened");
  expect(rows(page(sheet)).some((candidate) => candidate.kind === "input")).toBe(false);
  await press(sheet, "Done");
  await until(() => !has(undefined, "Finish setting up Payment events"), "the row updated");
  expect(await webhookStep("plg_stripe", "whk_stripe_payments")).toBe("done");
});

it("removes a saved account after every plugin is gone, from Plugins", async () => {
  const client = await host();
  // As on the Host, live runs and webhooks are cleaned up before a plugin can go.
  await client.enginePlugins.removeEverything();
  await render(<PluginsScreen route={{ params: { deploymentId: "dep_fixture" } } as never} />);
  await until(() => has(undefined, "No plugins yet"), "the empty Plugins list loaded");
  await press(undefined, "Connected accounts");
  expect(state.navigate).toHaveBeenCalledWith("PluginAccounts", { deploymentId: "dep_fixture" });
  act(() => root!.unmount());
  state.pages = [];
  await render(
    <PluginAccountsScreen route={{ params: { deploymentId: "dep_fixture" } } as never} />,
  );
  await until(() => has(undefined, "Live account"), "the saved accounts loaded");
  expect(row(page(), (candidate) => candidate.label === "Live account")).toMatchObject({
    detail: "Stripe · Not used by any plugin",
  });
  await press(undefined, "Live account");
  await until(() => !has(undefined, "Live account"), "the account left the list");
  const accounts = await client.rpc["plugins.accounts.list"]({});
  if (!accounts.ok) throw new Error("accounts read failed");
  expect(accounts.data.accounts.some(({ id }) => id === "acc_stripe_live")).toBe(false);
});

it("stops a live workflow run the Host lists past the first six", async () => {
  const client = await host();
  await render(detail("plg_linear"));
  const live = () =>
    rows(page()).find(
      (candidate) =>
        candidate.kind === "button" &&
        candidate.key === "wfr_6a8" &&
        candidate.actions?.some(({ label }) => label === "Stop"),
    );
  await until(() => live() !== undefined, "the live run was offered with Stop");
  const stop = live();
  if (stop?.kind !== "button") throw new Error("not a button");
  await act(async () => stop.actions!.find(({ label }) => label === "Stop")!.onPress());
  await until(() => live() === undefined, "the run stopped");
  const runs = await client.rpc["plugins.workflow.runs"]({ pluginId: "plg_linear" });
  if (!runs.ok) throw new Error("runs read failed");
  expect(runs.data.runs.find(({ id }) => id === "wfr_6a8")?.status).toBe("terminated");
});

it("offers Try again under a catalog that could not be read, and reloads it", async () => {
  const client = await host();
  const loaded = await client.rpc["plugins.catalog.list"]({ limit: 30 });
  if (!loaded.ok) throw new Error("catalog read failed");
  const busy = {
    ok: false,
    error: { code: "unavailable", message: "Host busy", retryable: true },
  } as never;
  // The read tries twice more by itself before it says so.
  const list = vi
    .fn()
    .mockResolvedValueOnce(busy)
    .mockResolvedValueOnce(busy)
    .mockResolvedValueOnce(busy)
    .mockResolvedValue(loaded);
  Object.defineProperty(client.rpc, "plugins.catalog.list", { value: list });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await render(
      <PluginCatalogScreen route={{ params: { deploymentId: "dep_fixture" } } as never} />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    const catalog = page().sections.find(({ key }) => key === "catalog")!;
    expect(list).toHaveBeenCalledTimes(3);
    expect(rows(page()).some(({ label }) => label === "The catalog is empty.")).toBe(false);
    expect(catalog.footer?.link?.label).toBe("Try again");
    await act(async () => catalog.footer!.link!.onPress());
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(list).toHaveBeenCalledTimes(4);
    expect(rows(page()).some(({ label }) => label === loaded.data.items[0]!.name)).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("finds iMessage in the catalog and sets it up on a device", async () => {
  await host();
  await render(
    <PluginCatalogScreen route={{ params: { deploymentId: "dep_fixture" } } as never} />,
  );
  await until(() => !!page().search, "the catalog loaded");
  await act(async () => page().search!.onChange("imessage"));
  await until(() => has(undefined, "Apple Messages"), "Apple Messages was listed");
  expect(row(page(), (candidate) => candidate.label === "Apple Messages")).toMatchObject({
    detail: expect.stringMatching(/^Requires a Mac · /u),
  });
  expect(rows(page()).some((candidate) => candidate.label.startsWith("Nothing in the"))).toBe(
    false,
  );
  await press(undefined, "Apple Messages");
  await until(() => state.settingUp === "apple-messages", "the setup sheet opened");
});
