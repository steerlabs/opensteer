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
      const search = container.querySelector<HTMLInputElement>(
        'input[aria-label="Search models"]',
      )!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          "work.test",
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const results = container.querySelector('[role="group"][aria-label="Results"]')!;
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
    const blockedAccount = container.querySelector(
      '[role="group"][aria-label="Codex accounts"] [role="menuitemradio"][aria-label="Codex Work"]',
    );
    expect(blockedAccount?.getAttribute("aria-checked")).toBe("true");
    expect(blockedAccount?.textContent).toContain("This work location is not connected");
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
