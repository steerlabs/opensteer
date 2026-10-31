import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HarnessModelDescriptorSchema, type HarnessModelDescriptor } from "@opensteer/protocol";
import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import { selectionForModel, type ThreadPlacementOption } from "@opensteer/client/host";
import { MemoryRouter } from "react-router";
import { ModelPicker, EnginePickerPanel } from "./model-picker.js";

const gptOnCodex = HarnessModelDescriptorSchema.parse({
  displayName: "GPT-5.6-Sol",
  isDefault: true,
  modelId: "gpt-5.6-sol",
  options: [],
  providerId: "openai",
});
const sonnet = HarnessModelDescriptorSchema.parse({
  displayName: "Claude Sonnet 5",
  isDefault: true,
  modelId: "claude-sonnet-5",
  options: [],
  providerId: "anthropic",
});

const claudeMain = placement("Claude Code", "hin-claude", [sonnet]);

const personal = {
  accountLabel: "alex@personal.test",
  billingLabel: "Plus",
  connectionSlot: "primary",
  label: "Codex",
  status: "connected" as const,
  usage: {
    limitReached: false,
    observedAt: "2026-09-15T09:00:00.000Z",
    windows: [{ label: "weekly", resetsAt: "2099-01-01T00:00:00.000Z", usedPercent: 98 }],
  },
};
const work = {
  ...personal,
  accountLabel: "alex@work.test",
  billingLabel: "Team",
  usage: undefined,
};
const codexPersonal = placement("Codex", "hin-codex-personal", [gptOnCodex], {
  observedConnections: [personal],
});
const codexWork = placement("Codex", "hin-codex-work", [gptOnCodex], {
  accountName: "Codex 2",
  defaultAccount: false,
  observedConnections: [work],
});

describe("EnginePickerPanel", () => {
  it("selects the searched account even when another account is the current selection", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = vi.fn();
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <EnginePickerPanel
              blocked={null}
              history={[]}
              placements={[codexPersonal, codexWork]}
              onSelect={onSelect}
              selection={{
                environmentId: "environment-main",
                harnessInstanceId: "hin-codex-personal",
                modelSelection: selectionForModel(gptOnCodex),
              }}
            />
          </MemoryRouter>,
        ),
      );
      await act(async () =>
        container.firstElementChild!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "w", bubbles: true }),
        ),
      );
      const search = container.querySelector<HTMLInputElement>(
        'input[aria-label="Search models"]',
      )!;
      const typeSearch = async (value: string) =>
        act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
            search,
            value,
          );
          search.dispatchEvent(new Event("input", { bubbles: true }));
        });
      // The same model on two accounts must not sound the same: each result is
      // described by where it runs.
      await typeSearch("GPT");
      const described = [
        ...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'),
      ].map(
        (item) => document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent,
      );
      expect(described).toEqual(["Codex · alex@personal.test", "Codex · alex@work.test"]);
      await typeSearch("work.test");
      const results = container.querySelector('[role="menu"][aria-label="Models"]')!;
      const rows = results.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.getAttribute("aria-label")).toBe("GPT-5.6-Sol");
      expect(row.getAttribute("aria-checked")).toBe("false");
      await act(async () => row.click());
      expect(onSelect).toHaveBeenCalledExactlyOnceWith({ model: gptOnCodex, placement: codexWork });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("shows external sign-in instructions and an explicit recheck without offering managed sign-in", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EnginePickerPanel
          blocked={null}
          history={[]}
          selection={null}
          onSelect={vi.fn()}
          onAuthenticate={vi.fn()}
          onRefresh={vi.fn()}
          placements={[
            {
              ...placement("Cursor", "hin-cursor", []),
              harnessAuthenticationAllowed: true,
              availability: "authentication-required",
              available: false,
              setupAvailable: false,
              detail: "Sign in to use Cursor. Run `agent login` on this computer.",
            },
          ]}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Sign in to use Cursor. Run `agent login` on this computer.");
    expect(html).toContain("Check again");
    expect(html).not.toContain(">Sign in</button>");
  });

  it("offers setup for any authorized work location whose driver declares a method", () => {
    const managed: ThreadPlacementOption = {
      ...placement("Codex", "hin-codex", []),
      availability: "authentication-required",
      available: false,
      detail: "Sign in to Codex",
      environmentKind: "managed",
      harnessAuthenticationAllowed: true,
      setupAvailable: true,
    };
    const onAuthenticate = vi.fn();
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EnginePickerPanel
          blocked={null}
          history={[]}
          onAuthenticate={onAuthenticate}
          onSelect={vi.fn()}
          selection={null}
          placements={[managed]}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(">Sign in</button>");

    const localHtml = renderToStaticMarkup(
      <MemoryRouter>
        <EnginePickerPanel
          blocked={null}
          history={[]}
          onAuthenticate={onAuthenticate}
          onSelect={vi.fn()}
          selection={null}
          placements={[{ ...managed, environmentKind: "local" }]}
        />
      </MemoryRouter>,
    );
    expect(localHtml).toContain(">Sign in</button>");

    const forbiddenHtml = renderToStaticMarkup(
      <MemoryRouter>
        <EnginePickerPanel
          blocked={null}
          history={[]}
          onAuthenticate={onAuthenticate}
          onSelect={vi.fn()}
          selection={null}
          placements={[{ ...managed, harnessAuthenticationAllowed: false }]}
        />
      </MemoryRouter>,
    );
    expect(forbiddenHtml).not.toContain(">Sign in</button>");

    const unsupportedHtml = renderToStaticMarkup(
      <MemoryRouter>
        <EnginePickerPanel
          blocked={null}
          history={[]}
          onAuthenticate={onAuthenticate}
          onSelect={vi.fn()}
          selection={null}
          placements={[{ ...managed, setupAvailable: false }]}
        />
      </MemoryRouter>,
    );
    expect(unsupportedHtml).not.toContain(">Sign in</button>");
  });

  it("signs a blocked AI in through its own fix, leaving the window alone", async () => {
    const managed: ThreadPlacementOption = {
      ...placement("Codex", "hin-codex", []),
      availability: "authentication-required",
      available: false,
      detail: "Sign in to Codex",
      harnessAuthenticationAllowed: true,
      setupAvailable: true,
    };
    const onAuthenticate = vi.fn();
    // A fix that closed "the menu" with a bare close() would close the window.
    const closeWindow = vi.spyOn(window, "close").mockImplementation(() => undefined);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    try {
      await act(async () =>
        root.render(
          <MemoryRouter>
            <EnginePickerPanel
              blocked={null}
              history={[]}
              onAuthenticate={onAuthenticate}
              onSelect={vi.fn()}
              placements={[managed]}
              selection={null}
            />
          </MemoryRouter>,
        ),
      );
      const signIn = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Sign in",
      )!;
      await act(async () => signIn.click());
      expect(onAuthenticate).toHaveBeenCalledExactlyOnceWith(managed);
      expect(closeWindow).not.toHaveBeenCalled();
    } finally {
      closeWindow.mockRestore();
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("ModelPicker", () => {
  it("keeps a blocked choice on the pill instead of quietly naming something else", () => {
    const off: ThreadPlacementOption = {
      ...placement("Codex", "hin-codex-work", [], { accountName: "Codex Work" }),
      availability: "disconnected",
      available: false,
      detail: "This work location is not connected",
      whereLabel: "Studio Mac",
    };
    const blocked = {
      environmentId: "environment-main",
      harnessInstanceId: "hin-codex-work",
      modelSelection: selectionForModel(gptOnCodex),
    };

    const html = renderToStaticMarkup(
      <ModelPicker
        history={[]}
        blocked={blocked}
        placements={[claudeMain, off]}
        onSelect={vi.fn()}
        selection={null}
      />,
    );

    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("Codex Work");
    expect(html).toContain("is-unavailable");
    expect(html).toContain("(unavailable)");
    expect(html).not.toContain("Claude Sonnet 5");
    expect(html).not.toContain("Choose AI");
  });

  it("marks the blocked account as current in its engine, with its reason", () => {
    const off: ThreadPlacementOption = {
      ...placement("Codex", "hin-codex-work", [], { accountName: "Codex Work" }),
      availability: "disconnected",
      available: false,
      detail: "This work location is not connected",
      whereLabel: "Studio Mac",
    };

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <EnginePickerPanel
          history={[]}
          blocked={{
            environmentId: "environment-main",
            harnessInstanceId: "hin-codex-work",
            modelSelection: selectionForModel(gptOnCodex),
          }}
          placements={[claudeMain, off]}
          onSelect={vi.fn()}
          selection={null}
        />
      </MemoryRouter>,
    );

    const container = document.createElement("div");
    container.innerHTML = html;
    expect(
      container.querySelector('[role="tab"][aria-label="Codex"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(container.textContent).toContain("This work location is not connected");
  });
});

function placement(
  engineName: string,
  harnessInstanceId: string,
  models: HarnessModelDescriptor[],
  overrides: Partial<ThreadPlacementOption> = {},
): ThreadPlacementOption {
  const first = models[0];
  return {
    accessModes: [...ThreadAccessModeSchema.options],
    accountName: engineName,
    availability: "runtime-check",
    available: true,
    continuationIdentity: null,
    defaultAccount: true,
    detail: "Ready",
    driverKind: engineName.toLowerCase().replaceAll(" ", "-"),
    engineName,
    environmentId: "environment-main",
    environmentKind: "main",
    harnessAuthenticationAllowed: false,
    harnessInstanceId,
    models,
    observedConnections: [],
    modelSelection: first
      ? selectionForModel(first)
      : ModelSelectionSchema.parse({
          modelId: "unavailable",
          options: {},
          providerId: "unavailable",
        }),
    setupAvailable: false,
    setupMethods: [],
    source: {
      fields: [],
      kind: "first-party",
      label: "OpenAI",
      quota: "windows",
      sourceId: "openai",
      stateKinds: ["ambient", "isolated"],
    },
    sourceId: "openai",
    whereLabel: "Main",
    ...overrides,
  };
}
// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";

import { emptyExecutionPreferences } from "@opensteer/core";
import { ExecutionControls } from "./execution-controls.js";

it("keeps exhausted accounts visible, applies access and routes the chosen account", async () => {
  const exhausted = {
    ...codexPersonal,
    observedConnections: [{ ...personal, usage: { ...personal.usage, limitReached: true } }],
  };
  const onApply = vi.fn();
  const onAccess = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const rect = new DOMRect(10, 100, 100, 30);
  const spy = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue(Object.assign([rect], { item: () => rect }));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ExecutionControls
            placements={[exhausted, codexWork]}
            preferences={emptyExecutionPreferences}
            selection={{
              environmentId: exhausted.environmentId,
              harnessInstanceId: exhausted.harnessInstanceId,
              modelSelection: selectionForModel(gptOnCodex),
            }}
            onApply={onApply}
            access={{ engine: exhausted, mode: "full-access", onApply: onAccess }}
          />
        </MemoryRouter>,
      ),
    );
    await act(async () =>
      node.querySelector<HTMLButtonElement>('[aria-label^="Engine and model:"]')!.click(),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    const conversation = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes("Full access ·"),
    )!;
    await act(async () => conversation.click());
    expect(dialog.querySelector("[data-view-back]")?.textContent).toBe("This conversation");
    const access = [...dialog.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
      (item) => item.textContent?.includes("Supervised"),
    )!;
    await act(async () => access.click());
    expect(onAccess).toHaveBeenCalledExactlyOnceWith("approval-required");
    const work = [...dialog.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((item) =>
      item.textContent?.includes("alex@work.test"),
    )!;
    expect(dialog.querySelector(".execution-menu__exhausted")).not.toBeNull();
    await act(async () => work.click());
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harnessInstanceId: codexWork.harnessInstanceId }),
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    spy.mockRestore();
  }
});

it("reviews a session-ending account switch before applying it", async () => {
  const onApply = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const rect = new DOMRect(10, 100, 100, 30);
  const spy = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue(Object.assign([rect], { item: () => rect }));
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ExecutionControls
            placements={[codexPersonal, codexWork]}
            preferences={emptyExecutionPreferences}
            selection={{
              environmentId: codexPersonal.environmentId,
              harnessInstanceId: codexPersonal.harnessInstanceId,
              modelSelection: selectionForModel(gptOnCodex),
            }}
            onApply={onApply}
            review={() => ({
              kind: "incompatible",
              access: null,
              engineName: "Codex",
              accountName: "Work",
              expectedProviderSessionId: "session",
              currentEngineName: "Codex",
            })}
          />
        </MemoryRouter>,
      ),
    );
    await act(async () => node.querySelector("button")!.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".execution-menu__bottom")!.click(),
    );
    const account = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (item) => item.textContent?.includes("alex@work.test"),
    )!;
    await act(async () => account.click());
    expect(onApply).not.toHaveBeenCalled();
    const confirm = [...document.querySelectorAll<HTMLButtonElement>(".switch-review button")].find(
      (item) => item.textContent === "Use Codex",
    )!;
    await act(async () => confirm.click());
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harnessInstanceId: codexWork.harnessInstanceId }),
      { continuation: { expectedProviderSessionId: "session" } },
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    spy.mockRestore();
  }
});

it("keeps everything on Keep, and asks for an access mode rather than choosing one", async () => {
  const onApply = vi.fn();
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const rect = new DOMRect(10, 100, 100, 30);
  const spy = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue(Object.assign([rect], { item: () => rect }));
  const pickWork = async () => {
    await act(async () => node.querySelector("button")!.click());
    await act(async () =>
      document.querySelector<HTMLButtonElement>(".execution-menu__bottom")!.click(),
    );
    const account = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
      (item) => item.textContent?.includes("alex@work.test"),
    )!;
    await act(async () => account.click());
  };
  const reviewButton = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>(".switch-review button")].find(
      (item) => item.textContent === label,
    )!;
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <ExecutionControls
            placements={[codexPersonal, codexWork]}
            preferences={emptyExecutionPreferences}
            selection={{
              environmentId: codexPersonal.environmentId,
              harnessInstanceId: codexPersonal.harnessInstanceId,
              modelSelection: selectionForModel(gptOnCodex),
            }}
            onApply={onApply}
            review={() => ({
              kind: "incompatible",
              access: { current: "full-access", offered: ["approval-required", "auto"] },
              engineName: "Codex",
              accountName: "Work",
              expectedProviderSessionId: "session",
              currentEngineName: "Codex",
            })}
          />
        </MemoryRouter>,
      ),
    );
    await pickWork();
    await act(async () => reviewButton("Keep Codex").click());
    expect(document.querySelector(".switch-review")).toBeNull();
    expect(onApply).not.toHaveBeenCalled();

    await pickWork();
    // Nothing is chosen for the reader: confirming waits until they pick a mode.
    expect(reviewButton("Use Codex").disabled).toBe(true);
    const supervised = [
      ...document.querySelectorAll<HTMLButtonElement>('.switch-review [role="radio"]'),
    ].find((item) => item.textContent?.includes("Supervised"))!;
    await act(async () => supervised.click());
    await act(async () => reviewButton("Use Codex").click());
    expect(onApply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ harnessInstanceId: codexWork.harnessInstanceId }),
      {
        accessMode: "approval-required",
        continuation: { expectedProviderSessionId: "session" },
      },
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
    spy.mockRestore();
  }
});
