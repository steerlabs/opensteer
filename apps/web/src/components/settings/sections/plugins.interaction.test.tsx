// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { HostClientRequestError, unwrapRpcResult } from "@opensteer/client/host";
import { pluginCatalogProducts, pluginPath } from "@opensteer/client/settings";
import {
  completePluginConsent,
  pluginConsentKey,
  readPluginConsent,
  storePluginConsent,
} from "./plugin-add-consent.js";
import { PluginsSection, PluginAddSheet } from "./plugins.js";
import { ToastProvider } from "../../toast.js";
import type { SettingsView } from "../primitives.js";
const shell = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("../../app-shell.js", () => ({ useShell: () => shell.value }));
const signIn = vi.hoisted(() => ({ connectionId: "" }));
vi.mock("../../integrations/integrations-page.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../integrations/integrations-page.js")>();
  return {
    ...actual,
    IntegrationsPage: (props: Parameters<typeof actual.IntegrationsPage>[0]) => (
      <>
        <actual.IntegrationsPage {...props} />
        {props.onConnected ? (
          <button type="button" onClick={() => void props.onConnected?.(signIn.connectionId)}>
            Complete sign-in fixture
          </button>
        ) : null}
      </>
    ),
  };
});
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | null = null;
let client: MockHostClient;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  client?.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  sessionStorage.clear();
});
const view: SettingsView = {
  administrator: true,
  deployment: null,
  kind: "personal",
  machineOwner: true,
  name: "My Mac",
  facts: { desktop: false, onThisComputer: false, remote: false },
  statusInfo: { status: "ready", reason: null },
};
async function mount(
  path = "/settings/plugins",
  options: {
    sheet?: boolean;
    empty?: boolean;
    configure?: (client: MockHostClient) => Promise<void>;
  } = {},
) {
  client = new MockHostClient({ latencyMs: 0 });
  await options.configure?.(client);
  if (options.empty) {
    const rpc = client.rpc;
    Object.defineProperty(client, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key) =>
          key === "plugins.overview.get"
            ? async () => ({ ok: true, data: { rows: [] } })
            : Reflect.get(target, key),
      }),
    });
  }
  shell.value = {
    hostClient: client,
    snapshot: client.getSnapshot(),
    desktopBridge: null,
    desktopDeployment: null,
    localExecutionStatus: null,
  };
  const gmail = options.sheet
    ? pluginCatalogProducts(
        unwrapRpcResult(await client.rpc["plugins.directory.get"]({})).catalog,
      ).find(({ id }) => id === "google-gmail")!
    : null;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          {gmail ? (
            <PluginAddSheet personal={false} product={gmail} />
          ) : (
            <PluginsSection view={view} />
          )}
        </ToastProvider>
      </MemoryRouter>,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).not.toContain("Loading plugins…"), {
      timeout: 1500,
    });
  });
  return node;
}
describe("Plugins settings", () => {
  it("restores only reviewed placement after the Host confirms an OAuth return", async () => {
    const attemptId = "ioa_00000000-0000-4000-8000-0000000000a1";
    let key = "";
    let dispatched: unknown[] = [];
    const node = await mount(`/settings/plugins?integrationAttempt=${attemptId}`, {
      configure: async (client) => {
        const snapshot = client.getSnapshot();
        const detail = unwrapRpcResult(
          await client.rpc["plugins.detail.get"]({
            target: { kind: "service", definitionId: "google-gmail" },
          }),
        );
        key = pluginConsentKey(snapshot.homeWorkspaceId!, snapshot.user!.id, attemptId);
        storePluginConsent(key, {
          target: detail.row.target,
          everywhere: false,
          places: [snapshot.homeWorkspaceId!],
          access: "read",
          idempotencyKey: "returned-consent",
          command: null,
        });
        const rpc = client.rpc;
        Object.defineProperty(client, "rpc", {
          value: new Proxy(rpc, {
            get: (target, name) =>
              name === "integration.authorization.get"
                ? async () => ({
                    ok: true,
                    data: {
                      connectionId: detail.accounts[0]!.connectionId,
                      expiresAt: new Date(Date.now() + 60_000).toISOString(),
                      failureCode: null,
                      status: "completed",
                    },
                  })
                : Reflect.get(target, name),
          }),
        });
        const dispatch = client.dispatch.bind(client);
        vi.spyOn(client, "dispatch").mockImplementation((command) => {
          dispatched.push(command);
          return dispatch(command);
        });
      },
    });
    await act(async () => {
      await vi.waitFor(() => expect(node.textContent).toContain("Google connected"));
    });
    expect(dispatched).toContainEqual(
      expect.objectContaining({
        type: "settings.plugin.placement.set",
        idempotencyKey: "returned-consent",
        personalEverywhere: null,
      }),
    );
    expect(readPluginConsent(key)).toBeNull();
  });
  it("retains the exact consent command when its response is lost", async () => {
    await mount();
    const detail = unwrapRpcResult(
      await client.rpc["plugins.detail.get"]({
        target: { kind: "service", definitionId: "google-gmail" },
      }),
    );
    const key = "test-consent";
    storePluginConsent(key, {
      target: detail.row.target,
      everywhere: true,
      places: [],
      access: "read",
      idempotencyKey: "uncertain-consent",
      command: null,
    });
    const dispatch = client.dispatch.bind(client);
    const spy = vi.spyOn(client, "dispatch").mockImplementationOnce(async (command) => {
      await dispatch(command);
      throw new Error("Response lost");
    });
    await expect(
      completePluginConsent(
        client,
        readPluginConsent(key)!,
        detail.accounts[0]!.connectionId,
        (next) => storePluginConsent(key, next),
      ),
    ).rejects.toThrow("Response lost");
    await completePluginConsent(
      client,
      readPluginConsent(key)!,
      detail.accounts[0]!.connectionId,
      (next) => storePluginConsent(key, next),
    );
    expect(spy.mock.calls[1]![0]).toEqual(spy.mock.calls[0]![0]);
    expect(JSON.stringify(readPluginConsent(key))).not.toContain("launchTicket");
    expect(JSON.stringify(readPluginConsent(key))).not.toContain(detail.accounts[1]!.connectionId);
  });
  it("requires server placement and explicit Add before opening sign-in", async () => {
    const node = await mount("/settings/plugins/add", { sheet: true });
    await act(async () => {
      await vi.waitFor(() => expect(node.textContent).toContain("Read and search mail"));
    });
    const proceed = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Connect Gmail",
    )!;
    expect(proceed.disabled).toBe(true);
    expect(node.textContent).not.toContain("Everywhere");
    const choices = node.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    await act(async () => choices[0]!.click());
    expect(proceed.disabled).toBe(false);
    expect(node.querySelector('select[aria-label="Agent access"]')).toBeNull();
    expect(node.querySelectorAll('input:not([role="switch"])')).toHaveLength(0);
    const accounts = unwrapRpcResult(
      await client.rpc["plugins.detail.get"]({
        target: { kind: "service", definitionId: "google-gmail" },
      }),
    ).accounts;
    signIn.connectionId = accounts[0]!.connectionId;
    const dispatch = vi.spyOn(client, "dispatch");
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => proceed.click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(node.querySelector(".intg-hero")?.textContent).toContain("Gmail"),
      );
    });
    const complete = [...node.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Complete sign-in fixture",
    )!;
    await act(async () => complete.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "settings.plugin.placement.set",
        mainIncluded: true,
        personalEverywhere: null,
      }),
    );
    expect(dispatch.mock.calls[0]![0].type).toBe("settings.plugin.enabled.set");
    const command = dispatch.mock.calls.find(
      ([command]) => command.type === "settings.plugin.placement.set",
    )![0];
    if (command.type !== "settings.plugin.placement.set")
      throw new Error("Placement command missing");
    expect(JSON.stringify(command)).not.toContain(accounts[1]!.connectionId);
    expect(node.textContent).toContain("Connected and turned on in your chosen places.");
  });
  it("returns provider links into the Plugins service editor with one account list", async () => {
    const node = await mount("/settings/plugins?provider=google-gmail");
    await act(async () => {
      await vi.waitFor(() =>
        expect(node.querySelector(".intg-hero")?.textContent).toContain("Gmail"),
      );
    });
    expect(
      [...node.querySelectorAll("h2")].filter((heading) => heading.textContent === "Accounts"),
    ).toHaveLength(1);
    expect(node.textContent).not.toContain("Your accounts");
    expect(node.textContent).toContain("tim@example.com");
  });
  it("shows the catalog's popular picks on the page itself when nothing is added", async () => {
    const node = await mount("/settings/plugins", { empty: true });
    await act(async () => {
      await vi.waitFor(() =>
        expect(node.querySelectorAll(".settings-catalog__tile").length).toBeGreaterThan(0),
      );
    });
    expect(node.textContent).toContain("Add more");
    expect(node.querySelector('[aria-label="Add Gmail"]')).not.toBeNull();
    expect(node.textContent).not.toContain("Needs you");
  });
  it("shows one Gmail row and retains committed switch state while the Host is pending", async () => {
    const node = await mount();
    expect(node.querySelectorAll("a.card__row-body").length).toBeGreaterThan(1);
    const toggle = node.querySelector<HTMLInputElement>('[aria-label="Enable Gmail"]')!;
    expect(toggle.checked).toBe(true);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = client.dispatch.bind(client);
    const spy = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      await gate;
      return dispatch(command);
    });
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    expect(node.textContent).toContain("Saving…");
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => release());
    await vi.waitFor(
      async () => {
        await act(async () => {});
        expect(node.querySelector<HTMLInputElement>('[aria-label="Enable Gmail"]')?.checked).toBe(
          false,
        );
      },
      { timeout: 1500 },
    );
    const row = unwrapRpcResult(await client.rpc["plugins.overview.get"]({})).rows.find(
      (row) => row.title === "Gmail",
    )!;
    const detail = unwrapRpcResult(await client.rpc["plugins.detail.get"]({ target: row.target }));
    expect(detail.accounts).toHaveLength(2);
    expect(detail.places.some((place) => place.selected)).toBe(true);
  });
  it("opens a composite identity with exact accounts and layered permission facts", async () => {
    const node = await mount(pluginPath({ kind: "service", definitionId: "google-gmail" }));
    await act(async () => {
      await vi.waitFor(() => expect(node.textContent).toContain("Where it’s on"), {
        timeout: 1500,
      });
    });
    expect(node.textContent).toContain("What agents may do");
    const detail = unwrapRpcResult(
      await client.rpc["plugins.detail.get"]({
        target: { kind: "service", definitionId: "google-gmail" },
      }),
    );
    for (const account of detail.accounts) expect(node.textContent).toContain(account.displayName);
    expect(node.querySelector('[aria-label="Enable Gmail"]')).not.toBeNull();
  });
});

it("changes only entered server secrets from unified plugin detail", async () => {
  let serverId = "";
  const node = await mount(pluginPath({ kind: "service", definitionId: "google-gmail" }), {
    configure: async (client) => {
      await client.load();
      const detail = unwrapRpcResult(
        await client.rpc["plugins.detail.get"]({
          target: { kind: "service", definitionId: "google-gmail" },
        }),
      );
      const rpc = client.rpc;
      const platform = unwrapRpcResult(await rpc["integration.platform.get"]({}));
      const mcp = platform.installations.find((entry) => entry.servers.length > 0);
      if (!mcp) throw new Error("Missing MCP fixture");
      serverId = "isv_00000000-0000-4000-8000-000000000009";
      Object.defineProperty(client, "rpc", {
        value: new Proxy(rpc, {
          get: (target, key) =>
            key === "integration.platform.get"
              ? async () => ({
                  ok: true,
                  data: {
                    ...platform,
                    installations: [
                      {
                        ...mcp,
                        installation: {
                          ...mcp.installation,
                          id: "iin_secret_fixture",
                          sourceKind: "plugin",
                        },
                        servers: mcp.servers.map((server) => ({
                          ...server,
                          name: "Plugin mail server",
                        })),
                      },
                    ],
                  },
                })
              : key === "plugins.detail.get"
                ? async () => ({
                    ok: true,
                    data: { ...detail, installationIds: ["iin_secret_fixture"] },
                  })
                : key === "integration.server.secrets.list"
                  ? async () => ({
                      ok: true,
                      data: {
                        servers: [
                          {
                            id: serverId,
                            installationId: "iin_secret_fixture",
                            plugin: "Gmail",
                            computer: "Studio Mac",
                            name: "mail",
                            secrets: [
                              { name: "PASSWORD", title: "Mail password" },
                              { name: "TOKEN", title: "Token" },
                            ],
                          },
                        ],
                      },
                    })
                  : Reflect.get(target, key),
        }),
      });
    },
  });
  const dispatch = vi
    .spyOn(client, "dispatch")
    .mockResolvedValue({ type: "integration.server.secrets.set" } as never);
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).toContain("Secrets on your computers"));
  });
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).toContain("Plugin mail server"));
  });
  expect(node.textContent).toContain("MCP servers");
  expect(
    [...node.querySelectorAll("button")].some((button) => button.textContent === "Uninstall"),
  ).toBe(false);
  await act(async () =>
    [...node.querySelectorAll("button")].find((button) => button.textContent === "Change")!.click(),
  );
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Save")!
      .click(),
  );
  expect(document.body.textContent).toContain("Enter a new value to change.");
  const field = document.querySelector<HTMLInputElement>('input[type="password"]')!;
  expect(field.type).toBe("password");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      field,
      "new-secret",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    [...document.querySelectorAll("button")]
      .find((button) => button.textContent === "Save")!
      .click(),
  );
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "integration.server.secrets.set",
      serverId,
      secrets: { PASSWORD: "new-secret" },
    }),
  );
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.body.textContent).not.toContain("new-secret");
});

it("offers only what isn't yours yet, finds it by search and opens its add sheet", async () => {
  const node = await mount("/settings/plugins/add");
  await act(async () => {
    await vi.waitFor(() => expect(node.textContent).toContain("Add more"));
  });
  const catalog = node.querySelector(".settings-catalog")!;
  // Gmail is already this person's, so the catalog leaves it out.
  expect(catalog.querySelector('[aria-label="Add Gmail"]')).toBeNull();
  const search = node.querySelector<HTMLInputElement>('input[aria-label="Search plugins"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      search,
      "resend",
    );
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        [...catalog.querySelectorAll("button[aria-label^='Add ']")].map((button) =>
          button.getAttribute("aria-label"),
        ),
      ).toEqual(["Add Resend"]),
    );
  });
  await act(async () =>
    catalog.querySelector<HTMLButtonElement>('[aria-label="Add Resend"]')!.click(),
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain("What it can reach");
  expect(dialog.querySelector(".intg-icon--mark svg path")).not.toBeNull();
});

it("paints a remembered plugin list again only for the person who saw it", async () => {
  await mount();
  act(() => root!.unmount());
  const rpc = client.rpc;
  // The return visit's own read never answers, so only a remembered list can show.
  Object.defineProperty(client, "rpc", {
    value: new Proxy(rpc, {
      get: (target, key) =>
        key === "plugins.overview.get" ? () => new Promise(() => {}) : Reflect.get(target, key),
    }),
  });
  const revisit = async () => {
    const node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    await act(async () =>
      root!.render(
        <MemoryRouter initialEntries={["/settings/plugins"]}>
          <ToastProvider>
            <PluginsSection view={view} />
          </ToastProvider>
        </MemoryRouter>,
      ),
    );
    return node;
  };
  expect((await revisit()).querySelector('[aria-label="Enable Gmail"]')).not.toBeNull();
  act(() => root!.unmount());
  const snapshot = client.getSnapshot();
  vi.spyOn(client, "getSnapshot").mockReturnValue({
    ...snapshot,
    user: { ...snapshot.user!, id: "usr_00000000-0000-4000-8000-0000000000ff" as never },
  });
  const other = await revisit();
  expect(other.querySelector('[aria-label="Enable Gmail"]')).toBeNull();
  expect(other.querySelector('[aria-label="Loading plugins"]')).not.toBeNull();
});

it("releases a rejected switch attempt before the next click", async () => {
  const node = await mount();
  const dispatch = vi
    .spyOn(client, "dispatch")
    .mockRejectedValueOnce(
      new HostClientRequestError({ code: "conflict", status: 409, message: "Changed elsewhere" }),
    );
  await act(async () =>
    node.querySelector<HTMLInputElement>('[aria-label="Enable Gmail"]')!.click(),
  );
  await act(async () =>
    node.querySelector<HTMLInputElement>('[aria-label="Enable Gmail"]')!.click(),
  );
  expect(dispatch).toHaveBeenCalledTimes(2);
  const first = dispatch.mock.calls[0]![0];
  const second = dispatch.mock.calls[1]![0];
  if (first.type !== "settings.plugin.enabled.set" || second.type !== first.type)
    throw new Error("Missing switch");
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
});

it("uses the explicitly selected provider account and access for Everywhere", async () => {
  const node = await mount(pluginPath({ kind: "service", definitionId: "google-gmail" }));
  const select = node.querySelector<HTMLSelectElement>('select[aria-label^="Access for "]')!;
  expect(select).not.toBeNull();
  await act(async () => {
    select.value = "read-write";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const dispatch = vi.spyOn(client, "dispatch");
  const everywhere = [...node.querySelectorAll<HTMLInputElement>("#plugin-placement input")][0]!;
  await act(async () => everywhere.click());
  const command = dispatch.mock.calls[0]![0];
  expect(command.type).toBe("settings.plugin.placement.set");
  if (command.type !== "settings.plugin.placement.set") throw new Error("Missing placement");
  expect(command.personalEverywhere?.accounts).toHaveLength(1);
  expect(command.personalEverywhere?.accounts[0]?.access).toBe("read-write");
  for (const project of command.projects)
    expect(project.accounts).toEqual(command.personalEverywhere?.accounts);
});
