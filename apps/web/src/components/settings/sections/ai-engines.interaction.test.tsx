// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import {
  threadPlacementOptions,
  type ThreadPlacementOption,
  type EnvironmentSummary,
  type HarnessSummary,
} from "@opensteer/client/host";
import { HarnessModelDescriptorSchema, type HostApiCommandOutput } from "@opensteer/protocol";
import { AiEngineSettings } from "./ai-engines.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
});

async function mount() {
  const client = new MockHostClient();
  clients.push(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onAuthenticate = vi.fn();
  const onError = vi.fn();
  const render = async (
    transform?: (placement: ThreadPlacementOption) => ThreadPlacementOption,
    locations?: readonly EnvironmentSummary[],
  ) => {
    const snapshot = client.getSnapshot();
    const environments = (locations ?? snapshot.environments).map((environment) => ({
      ...environment,
      harnessDrivers: environment.harnessDrivers.map((driver) =>
        driver.readiness === "unavailable"
          ? driver
          : {
              ...driver,
              sources: driver.sources.filter((source) => source.kind === "first-party"),
            },
      ),
    }));
    const placements = threadPlacementOptions(environments, snapshot.harnesses);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AiEngineSettings
            client={client}
            environments={environments}
            harnesses={snapshot.harnesses}
            onAuthenticate={onAuthenticate}
            onError={onError}
            placements={transform ? placements.map(transform) : placements}
          />
        </MemoryRouter>,
      );
    });
  };
  await render();
  return { client, container, onAuthenticate, onError, render };
}

function addButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    '[aria-labelledby="settings-engine-codex"] .settings-engine__add',
  );
  if (!button) throw new Error("Codex Add account button missing");
  return button;
}

async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}

describe("account creation", () => {
  it("retries the exact request after a committed creation loses its response", async () => {
    const { client, container, onError, render } = await mount();
    const dispatch = client.dispatch.bind(client);
    let committed: HostApiCommandOutput | undefined;
    const spy = vi.spyOn(client, "dispatch").mockImplementation(async (command) => {
      if (committed) return committed;
      committed = await dispatch(command);
      throw new Error("Response lost");
    });
    await click(addButton(container));
    expect(onError).toHaveBeenCalledWith("Response lost");
    // Bootstrap can observe the committed account before the retry succeeds.
    await render();
    await click(addButton(container));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1]?.[0]).toEqual(spy.mock.calls[0]?.[0]);
  });

  it("keeps creation retries separate when the work location changes", async () => {
    const { client, container, render } = await mount();
    const main = client.getSnapshot().environments[0];
    if (!main) throw new Error("Main environment missing");
    const second = {
      ...main,
      id: "env_22222222-2222-4222-8222-222222222222",
      name: "Second computer",
    };
    await render(undefined, [main, second]);
    const spy = vi.spyOn(client, "dispatch").mockRejectedValue(new Error("Connection lost"));
    await click(addButton(container));
    const location = container.querySelector<HTMLInputElement>(`input[value="${second.id}"]`);
    if (!location) throw new Error("Second location missing");
    await act(async () => location.click());
    await click(addButton(container));
    const firstRequest = spy.mock.calls[0]?.[0];
    const secondRequest = spy.mock.calls[1]?.[0];
    expect(firstRequest).toMatchObject({ environmentId: main.id });
    expect(secondRequest).toMatchObject({ environmentId: second.id });
    if (firstRequest?.type !== "harness.create" || secondRequest?.type !== "harness.create") {
      throw new Error("Expected two harness creation requests");
    }
    expect(secondRequest.idempotencyKey).not.toBe(firstRequest.idempotencyKey);
  });

  it("keeps one creation active through preparation, then opens its sign-in once", async () => {
    const { client, container, onAuthenticate, onError, render } = await mount();
    const before = new Set(client.getSnapshot().harnesses.map(({ id }) => id));
    await click(addButton(container));
    const created = client.getSnapshot().harnesses.find(({ id }) => !before.has(id));
    if (!created) throw new Error("Expected created account");
    expect(addButton(container).disabled).toBe(true);
    await render((placement) =>
      placement.harnessInstanceId === created.id
        ? { ...placement, available: false, availability: "preparing", setupAvailable: false }
        : placement,
    );
    expect(addButton(container).disabled).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onAuthenticate).not.toHaveBeenCalled();
    await render((placement) =>
      placement.harnessInstanceId === created.id
        ? {
            ...placement,
            available: false,
            availability: "authentication-required",
            setupAvailable: true,
          }
        : placement,
    );
    expect(onAuthenticate).toHaveBeenCalledTimes(1);
    expect(onAuthenticate.mock.calls[0]?.[0].harnessInstanceId).toBe(created.id);
    expect(addButton(container).disabled).toBe(false);
  });

  it("lets the user leave preparation without deleting the account or opening a late dialog", async () => {
    const { client, container, onAuthenticate, render } = await mount();
    await click(addButton(container));
    const count = client.getSnapshot().harnesses.length;
    const later = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign in later",
    );
    if (!later) throw new Error("Sign in later button missing");
    await click(later);
    await render((placement) => ({
      ...placement,
      available: false,
      availability: "authentication-required",
      setupAvailable: true,
    }));
    expect(onAuthenticate).not.toHaveBeenCalled();
    expect(client.getSnapshot().harnesses).toHaveLength(count);
    expect(addButton(container).disabled).toBe(false);
  });

  it("ends pending sign-in when its computer disconnects and does not reopen it on reconnect", async () => {
    const { client, container, onAuthenticate, onError, render } = await mount();
    await click(addButton(container));
    const environments = client.getSnapshot().environments;
    const count = client.getSnapshot().harnesses.length;
    await render(
      undefined,
      environments.map((environment) => ({ ...environment, connected: false })),
    );
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onAuthenticate).not.toHaveBeenCalled();
    await render(
      (placement) => ({
        ...placement,
        available: false,
        availability: "authentication-required",
        setupAvailable: true,
      }),
      environments,
    );
    expect(onAuthenticate).not.toHaveBeenCalled();
    expect(client.getSnapshot().harnesses).toHaveLength(count);
    expect(addButton(container).disabled).toBe(false);
  });
});

describe("a model server account", () => {
  type Catalog = EnvironmentSummary["harnessCatalogs"][number];

  async function mountServer(catalogFor: (current: Catalog) => Catalog) {
    const client = new MockHostClient();
    clients.push(client);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const server = client
      .getSnapshot()
      .harnesses.find(({ sourceId }) => sourceId === "openai-compatible");
    if (!server) throw new Error("Mock compatible-endpoint account missing");
    const onAuthenticate = vi.fn();
    const onError = vi.fn();
    /**
     * Renders the page as a later bootstrap would, with this account's catalog,
     * revision and saved limits — and, for an account added since, its catalog.
     */
    const render = async (
      next: (current: Catalog) => Catalog,
      {
        connected = true,
        created,
        modelSettings,
        runtimeRevision = server.runtimeRevision,
      }: {
        readonly connected?: boolean;
        readonly created?: Catalog;
        readonly modelSettings?: HarnessSummary["modelSettings"];
        readonly runtimeRevision?: number;
      } = {},
    ) => {
      const snapshot = client.getSnapshot();
      const environments = snapshot.environments.map((environment) => ({
        ...environment,
        connected,
        harnessCatalogs: [
          ...environment.harnessCatalogs
            .filter((catalog) => catalog.harnessInstanceId !== created?.harnessInstanceId)
            .map((catalog) => (catalog.harnessInstanceId === server.id ? next(catalog) : catalog)),
          ...(created && environment.id === server.environmentId ? [created] : []),
        ],
        harnessDrivers: environment.harnessDrivers.map((driver) =>
          driver.readiness === "unavailable"
            ? driver
            : {
                ...driver,
                sources: driver.sources.map((source) =>
                  source.sourceId === "openai-compatible"
                    ? { ...source, modelSettings: true }
                    : source,
                ),
              },
        ),
      }));
      const harnesses = snapshot.harnesses.map((harness) =>
        harness.id === server.id ? { ...harness, modelSettings, runtimeRevision } : harness,
      );
      await act(async () =>
        root.render(
          <MemoryRouter>
            <AiEngineSettings
              client={client}
              environments={environments}
              harnesses={harnesses}
              onAuthenticate={onAuthenticate}
              onError={onError}
              placements={threadPlacementOptions(environments, harnesses)}
            />
          </MemoryRouter>,
        ),
      );
    };
    await render(catalogFor);
    const row = [...container.querySelectorAll<HTMLElement>(".settings-ai-engine-row")].find(
      (candidate) => candidate.textContent?.includes(server.name),
    );
    if (!row) throw new Error("Server row missing");
    return { client, container, onAuthenticate, onError, render, row, server };
  }

  const needsContext = (modelId: string, nativeModelId = modelId) =>
    HarnessModelDescriptorSchema.parse({
      displayName: modelId,
      isDefault: false,
      modelId,
      nativeModelId,
      needsContextWindow: true,
      options: [],
      providerId: "custom",
      unavailableReason: "Effective context window is unknown",
    });
  const notLoaded = HarnessModelDescriptorSchema.parse({
    displayName: "phi-4",
    isDefault: false,
    modelId: "phi-4",
    options: [],
    providerId: "custom",
    unavailableReason: "Model is not loaded",
  });
  const onlyModels =
    (...models: ReturnType<typeof needsContext>[]) =>
    (catalog: Catalog): Catalog =>
      catalog.status === "ready" ? { ...catalog, models } : catalog;
  const addModels =
    (...models: ReturnType<typeof needsContext>[]) =>
    (catalog: Catalog): Catalog =>
      catalog.status === "ready" ? { ...catalog, models: [...catalog.models, ...models] } : catalog;
  const preparing = (catalog: Catalog): Catalog => ({
    connections: [],
    driverKind: catalog.driverKind,
    harnessInstanceId: catalog.harnessInstanceId,
    models: [],
    setupMethods: [],
    status: "preparing",
    detail: "Reading models",
  });
  const unreachable = (catalog: Catalog): Catalog => ({
    connections: [],
    driverKind: catalog.driverKind,
    harnessInstanceId: catalog.harnessInstanceId,
    models: [],
    setupMethods: [],
    status: "error",
    detail: "Could not reach http://localhost:11434/v1",
  });

  function dialog(): HTMLElement {
    const match = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!match) throw new Error("Models dialog closed");
    return match;
  }

  function buttonIn(scope: ParentNode, label: string): HTMLButtonElement {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label,
    );
    if (!match) throw new Error(`${label} button missing`);
    return match;
  }

  const labels = (scope: ParentNode) =>
    [...scope.querySelectorAll("button")].map((candidate) => candidate.textContent);

  async function openMenuItem(row: HTMLElement, label: string) {
    const more = row.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (!more) throw new Error("Row menu missing");
    await act(async () => more.click());
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
      (candidate) => candidate.textContent === label,
    );
    if (!item) throw new Error(`${label} menu item missing`);
    await act(async () => item.click());
  }

  function withRefresh(client: MockHostClient) {
    const rpc = client.rpc;
    const refresh = vi.fn(rpc["harness.catalog.refresh"]);
    Object.defineProperty(client, "rpc", {
      value: new Proxy(rpc, {
        get: (target, key) =>
          key === "harness.catalog.refresh" ? refresh : Reflect.get(target, key),
      }),
    });
    return refresh;
  }

  it("says the server cannot be reached and offers to try again rather than a sign-in", async () => {
    const { client, onAuthenticate, row, server } = await mountServer(unreachable);
    expect(row.textContent).toContain("Could not reach http://localhost:11434/v1");
    expect(labels(row)).not.toContain("Sign in");
    const refresh = withRefresh(client);
    await act(async () => buttonIn(row, "Try again").click());
    expect(refresh).toHaveBeenCalledWith({
      environmentId: server.environmentId,
      harnessInstanceId: server.id,
    });
    expect(onAuthenticate).not.toHaveBeenCalled();
  });

  it("leads to setup whenever typing a context size would make a model usable", async () => {
    const { row } = await mountServer(onlyModels(needsContext("qwen3:8b")));
    expect(row.querySelector(".chip--ok")).toBeNull();
    expect(row.textContent).toContain("Needs setup");
    expect(row.textContent).toContain("1 needs a context size");
    // An account that already needed setup is not interrupted on render.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => buttonIn(row, "Set up models").click());
    expect(dialog().querySelector("input")).not.toBeNull();

    const { row: mixed } = await mountServer(addModels(needsContext("llama3.2:3b")));
    expect(mixed.textContent).toContain("Ready");
    expect(labels(mixed)).toContain("Set up models");
  });

  it("leaves a model only the server can fix to the models list, without a nudge", async () => {
    const { row } = await mountServer(addModels(notLoaded));
    expect(row.textContent).toContain("Ready");
    expect(row.textContent).not.toContain("context size");
    expect(labels(row)).not.toContain("Set up models");
    await openMenuItem(row, "Models");
    expect(dialog().textContent).toContain("Model is not loaded");
  });

  it("names the server by its address, not by the source or sign-in every account lists", async () => {
    const { row } = await mountServer((catalog) => catalog);
    expect(row.textContent).not.toContain("Its own sign-in");
    expect(row.textContent).not.toContain("Model server ·");
  });

  it("shows saved sizes, without offering edits, while the server is re-read or offline", async () => {
    const { render, row } = await mountServer(onlyModels(needsContext("qwen3:8b")));
    const modelSettings = { "qwen3:8b": { contextWindow: 8_192 } };
    await render(preparing, { modelSettings });
    await openMenuItem(row, "Models");
    expect(dialog().textContent).toContain("qwen3:8b");
    expect(dialog().textContent).toContain("8,192 tokens");
    expect(dialog().textContent).toContain("Checking the server’s models");
    expect(labels(dialog())).not.toContain("Change");
    expect(dialog().querySelector("input")).toBeNull();
    await act(async () => buttonIn(dialog(), "Done").click());
    await render(preparing, { connected: false, modelSettings });
    await openMenuItem(row, "Models");
    expect(dialog().textContent).toMatch(/offline/i);
    expect(dialog().textContent).toContain("qwen3:8b");
  });

  describe("just added", () => {
    async function connectNewServer() {
      const scope = await mountServer((catalog) => catalog);
      const before = new Set(scope.client.getSnapshot().harnesses.map(({ id }) => id));
      const card = scope.container.querySelector<HTMLElement>(
        '[aria-labelledby="settings-model-servers"]',
      );
      if (!card) throw new Error("Model servers card missing");
      // The computer found its oMLX by itself; connecting it is one click.
      await act(async () => undefined);
      await act(async () => buttonIn(card, "Connect").click());
      const created = scope.client.getSnapshot().harnesses.find(({ id }) => !before.has(id));
      if (!created) throw new Error("Expected created server account");
      const catalog = (status: "ready" | "authentication-required"): Catalog =>
        status === "ready"
          ? ({
              connections: [],
              continuationIdentity: null,
              driverKind: created.driverKind,
              harnessInstanceId: created.id,
              models: [needsContext("qwen3:8b")],
              setupMethods: [],
              status: "ready",
            } as unknown as Catalog)
          : ({
              connections: [],
              detail: "127.0.0.1:11434 needs an API key",
              driverKind: created.driverKind,
              harnessInstanceId: created.id,
              models: [],
              setupMethods: [
                {
                  connectionSlot: "primary",
                  inputLabel: "API key",
                  kind: "secret-input",
                  label: "API key",
                  methodId: "api-key",
                },
              ],
              status: "authentication-required",
            } as unknown as Catalog);
      return { ...scope, catalog, created };
    }

    it("is named for the server it is, and opens its models when one needs a size", async () => {
      const { catalog, created, onAuthenticate, onError, render } = await connectNewServer();
      expect(created.name).toBe("oMLX");
      expect(created.driverKind).toBe("pi");
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await render((current) => current, { created: catalog("ready") });
      expect(onError).not.toHaveBeenCalled();
      // A server that answers without a key asks for none.
      expect(onAuthenticate).not.toHaveBeenCalled();
      expect(dialog().textContent).toContain("qwen3:8b");
    });

    it("asks for a key only when the server refuses without one, then opens its models once", async () => {
      const { catalog, onAuthenticate, render } = await connectNewServer();
      await render((current) => current, { created: catalog("authentication-required") });
      expect(onAuthenticate).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await render((current) => current, { created: catalog("ready") });
      expect(dialog().textContent).toContain("qwen3:8b");
      await act(async () => buttonIn(dialog(), "Done").click());
      await render((current) => current, { created: catalog("ready") });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    });
  });

  describe("while a size is saved", () => {
    const qwen = HarnessModelDescriptorSchema.parse({
      displayName: "Qwen3 8B",
      isDefault: false,
      modelId: "qwen3-8b",
      nativeModelId: "qwen3:8b",
      needsContextWindow: true,
      options: [],
      providerId: "qwen",
      unavailableReason: "Effective context window is unknown",
    });
    const withQwen = (model: typeof qwen) => (catalog: Catalog) =>
      catalog.status === "ready" ? { ...catalog, models: [model] } : catalog;

    async function saveQwen(context: string) {
      const scope = await mountServer(withQwen(qwen));
      const revision = scope.server.runtimeRevision + 1;
      const dispatch = vi.spyOn(scope.client, "dispatch").mockResolvedValue({
        harness: { ...scope.server, runtimeRevision: revision },
        type: "harness.model.configure",
      } as unknown as HostApiCommandOutput);
      await act(async () => buttonIn(scope.row, "Set up models").click());
      const input = dialog().querySelector<HTMLInputElement>("input")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          input,
          context,
        );
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => buttonIn(dialog(), "Save").click());
      expect(dispatch).toHaveBeenCalledTimes(1);
      const modelSettings = { "qwen3:8b": { contextWindow: Number(context) } };
      return { ...scope, modelSettings, revision };
    }

    it("stays open on the models it last read while the server is re-read, then shows the result", async () => {
      const { modelSettings, render, revision } = await saveQwen("8192");
      await render(preparing, { modelSettings, runtimeRevision: revision });
      expect(dialog().textContent).toContain("Qwen3 8B");
      expect(dialog().textContent).toContain("8,192 tokens");
      expect(labels(dialog())).not.toContain("Change");

      const { unavailableReason: _reason, needsContextWindow: _needs, ...configured } = qwen;
      await render(withQwen({ ...configured, contextWindow: 8_192 }), {
        modelSettings,
        runtimeRevision: revision,
      });
      expect(dialog().querySelector("input")).toBeNull();
      expect(dialog().textContent).toContain("8,192 tokens");
      expect(labels(dialog())).toContain("Change");
    });

    it("keeps the saved size and offers to try again when the server can’t be re-read", async () => {
      const { client, modelSettings, render, revision, server } = await saveQwen("8192");
      await render(unreachable, { modelSettings, runtimeRevision: revision });
      expect(dialog().textContent).toContain("Could not reach http://localhost:11434/v1");
      expect(dialog().textContent).toContain("8,192 tokens");
      const refresh = withRefresh(client);
      await act(async () => buttonIn(dialog(), "Try again").click());
      expect(refresh).toHaveBeenCalledWith({
        environmentId: server.environmentId,
        harnessInstanceId: server.id,
      });
    });

    it("says the computer is offline rather than closing when it disconnects", async () => {
      const { modelSettings, render, revision } = await saveQwen("8192");
      await render(preparing, { connected: false, modelSettings, runtimeRevision: revision });
      expect(dialog().textContent).toMatch(/offline/i);
      expect(dialog().textContent).toContain("8,192 tokens");
    });
  });
});
