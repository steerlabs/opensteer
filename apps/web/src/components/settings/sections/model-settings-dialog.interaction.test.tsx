// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessModelDescriptorSchema } from "@opensteer/protocol";
import { ModelSettingsDialog } from "./model-settings-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const reported = HarnessModelDescriptorSchema.parse({
  contextWindow: 131_072,
  displayName: "Llama 3.3 70B",
  isDefault: true,
  modelId: "llama-3.3-70b",
  nativeModelId: "llama3.3:70b",
  options: [],
  providerId: "meta",
});
const needsSetup = HarnessModelDescriptorSchema.parse({
  displayName: "Qwen3 8B",
  isDefault: false,
  modelId: "qwen3-8b",
  nativeModelId: "qwen3:8b",
  options: [],
  needsContextWindow: true,
  providerId: "qwen",
  unavailableReason: "Effective context window is unknown",
});
const notLoaded = HarnessModelDescriptorSchema.parse({
  displayName: "Phi 4",
  isDefault: false,
  modelId: "phi-4",
  options: [],
  providerId: "microsoft",
  unavailableReason: "Model is not loaded",
});
const overridden = HarnessModelDescriptorSchema.parse({
  contextWindow: 16_384,
  displayName: "Gemma 3",
  isDefault: false,
  maxOutputTokens: 4_096,
  modelId: "gemma-3",
  options: [],
  providerId: "google",
});

async function mount(dispatch = vi.fn().mockResolvedValue({ type: "harness.model.configure" })) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <ModelSettingsDialog
        catalog={
          {
            connections: [],
            continuationIdentity: { continuationKey: "server" },
            driverKind: "opencode",
            harnessInstanceId: "hin-server",
            models: [reported, notLoaded, needsSetup, overridden],
            setupMethods: [],
            status: "ready",
            steering: false,
            supersededContinuationIdentities: [],
          } as unknown as ComponentProps<typeof ModelSettingsDialog>["catalog"]
        }
        client={{ dispatch }}
        connected
        onClose={vi.fn()}
        onRefresh={vi.fn().mockResolvedValue(undefined)}
        profile={{
          driverKind: "opencode",
          enabled: true,
          environmentId: "env-studio",
          id: "hin-server",
          isDefault: true,
          modelSettings: { "gemma-3": { contextWindow: 16_384, maxOutputTokens: 4_096 } },
          name: "Ollama",
          runtimeRevision: 1,
          sourceId: "openai-compatible",
          stateKind: "isolated",
        }}
      />,
    ),
  );
  return { dispatch };
}

function row(name: string): HTMLElement {
  const match = [...document.querySelectorAll<HTMLElement>(".model-settings__row")].find((item) =>
    item.textContent?.includes(name),
  );
  if (!match) throw new Error(`${name} row missing`);
  return match;
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`${label} button missing`);
  return match;
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function rows(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".model-settings__title")].map(
    (title) => title.textContent ?? "",
  );
}

describe("model context sizes", () => {
  it("asks for the missing size in place, ahead of the models that already run", async () => {
    await mount();
    expect(document.getElementById("model-settings-title")?.textContent).toBe("Ollama models");
    // Waiting first, usable next, the server's own problems last.
    expect(rows()).toEqual(["Qwen3 8B", "Llama 3.3 70B", "Gemma 3", "Phi 4"]);
    const waiting = row("Qwen3 8B").querySelector<HTMLInputElement>("input")!;
    expect(waiting).not.toBeNull();
    expect(document.activeElement).toBe(waiting);
    expect(row("Llama 3.3 70B").textContent).toContain("131,072 tokens");
    expect(row("Llama 3.3 70B").querySelector("input")).toBeNull();
    // Typing a size can't load a model, so nothing here offers to.
    expect(row("Phi 4").textContent).toContain("Model is not loaded");
    expect(row("Phi 4").querySelector("button")).toBeNull();
  });

  it("takes a size the way model cards write it and saves it under the server's id", async () => {
    const { dispatch } = await mount();
    const form = row("Qwen3 8B");
    const input = form.querySelector<HTMLInputElement>("input")!;
    for (const invalid of ["abc", "512", "32kb"]) {
      await type(input, invalid);
      expect(button(form, "Save").disabled).toBe(true);
      expect(form.textContent).toContain("like 32768 or 32k");
    }
    await type(input, "32k");
    expect(button(form, "Save").disabled).toBe(false);
    await act(async () => button(form, "Save").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessInstanceId: "hin-server",
        nativeModelId: "qwen3:8b",
        settings: { contextWindow: 32_768 },
        type: "harness.model.configure",
      }),
    );
  });

  it("keeps a saved output limit only while it fits a new size, and clears only a saved size", async () => {
    const { dispatch } = await mount();
    const gemma = row("Gemma 3");
    await act(async () => button(gemma, "Change").click());
    const input = gemma.querySelector<HTMLInputElement>("input")!;
    expect(input.value).toBe("16384");
    await type(input, "8192");
    await act(async () => button(row("Gemma 3"), "Save").click());
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        nativeModelId: "gemma-3",
        settings: { contextWindow: 8_192, maxOutputTokens: 4_096 },
      }),
    );
    await act(async () => button(row("Gemma 3"), "Change").click());
    await type(row("Gemma 3").querySelector<HTMLInputElement>("input")!, "4096");
    await act(async () => button(row("Gemma 3"), "Save").click());
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ settings: { contextWindow: 4_096 } }),
    );
    // Only a size the person entered can be taken back.
    expect(() => button(row("Llama 3.3 70B"), "Clear")).toThrow();
    await act(async () => button(row("Gemma 3"), "Clear").click());
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ nativeModelId: "gemma-3", settings: null }),
    );
  });

  it("saves one model without locking the others, and keeps what was typed when saving fails", async () => {
    let fail: (reason: Error) => void = () => undefined;
    const dispatch = vi.fn(
      () => new Promise((_resolve, reject: (reason: Error) => void) => (fail = reject)),
    );
    await mount(dispatch);
    const input = row("Qwen3 8B").querySelector<HTMLInputElement>("input")!;
    await type(input, "40960");
    await act(async () => button(row("Qwen3 8B"), "Save").click());
    expect(input.disabled).toBe(true);
    expect(button(row("Llama 3.3 70B"), "Change").disabled).toBe(false);
    await act(async () => fail(new Error("A run is using this account. Try again when it ends.")));
    expect(row("Qwen3 8B").querySelector('[role="alert"]')?.textContent).toContain(
      "A run is using this account",
    );
    expect(row("Qwen3 8B").querySelector<HTMLInputElement>("input")!.value).toBe("40960");
  });
});
