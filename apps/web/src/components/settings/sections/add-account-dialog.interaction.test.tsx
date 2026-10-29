// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessSourceDescriptor } from "@opensteer/protocol";
import { AddAccountDialog } from "./add-account-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const server: HarnessSourceDescriptor = {
  detail: "A proxy or local runtime that speaks OpenAI's Chat Completions API.",
  fields: [
    { id: "baseUrl", kind: "url", label: "Base URL", placeholder: "http://localhost:11434/v1" },
    {
      defaultValue: "generic",
      id: "runtime",
      kind: "select",
      label: "Server software",
      options: [
        { label: "Other", value: "generic" },
        { label: "Ollama", value: "ollama" },
        { label: "LM Studio", value: "lmstudio" },
      ],
    },
    { id: "note", kind: "text", label: "Label", required: false },
  ],
  kind: "compatible-endpoint",
  label: "OpenAI-compatible endpoint",
  quota: "none",
  sourceId: "openai-compatible",
  stateKinds: ["isolated"],
};
const lab: HarnessSourceDescriptor = {
  fields: [],
  kind: "first-party",
  label: "OpenAI",
  quota: "none",
  sourceId: "openai",
  stateKinds: ["isolated"],
};
const region: HarnessSourceDescriptor = {
  fields: [{ defaultValue: "us-east-1", id: "region", kind: "text", label: "Region" }],
  kind: "cloud-identity",
  label: "Bedrock",
  quota: "none",
  sourceId: "bedrock",
  stateKinds: ["isolated"],
};

async function mount(sources: readonly HarnessSourceDescriptor[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const onSubmit = vi.fn();
  await act(async () =>
    root.render(
      <AddAccountDialog
        engineName="OpenCode"
        onClose={vi.fn()}
        onSubmit={onSubmit}
        sources={sources}
        submitting={false}
        whereLabel="Studio Mac"
      />,
    ),
  );
  const submit = () => [...document.querySelectorAll<HTMLButtonElement>("button[type=submit]")][0]!;
  return { onSubmit, submit };
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Typing and leaving the field, which is when an address is judged and tidied. */
async function enter(input: HTMLInputElement, value: string) {
  await type(input, value);
  await act(async () => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

const address = () => document.querySelector<HTMLInputElement>("#add-account-baseUrl")!;
const runtime = () => document.querySelector<HTMLSelectElement>("select#add-account-runtime")!;

describe("adding an endpoint account", () => {
  it("renders the endpoint's fields as the driver declared them, reached from the work location", async () => {
    const { onSubmit, submit } = await mount([server]);
    // No article: "Add a OpenCode account" reads wrong for any vowel-led name.
    expect(document.getElementById("add-account-title")?.textContent).toBe("Add OpenCode account");
    // No address is guessed: an endpoint is where the person says it is.
    expect(address().value).toBe("");
    expect(runtime().value).toBe("generic");
    expect(submit().textContent).toBe("Connect");
    expect(submit().disabled).toBe(true);
    // The address is reached from the work location, never from this device.
    expect(document.body.textContent).toContain("Studio Mac");
    expect(document.body.textContent).toContain("localhost");
    // A key is asked for only if the server refuses without one.
    expect(document.body.textContent).not.toMatch(/API key/i);
    expect(document.body.textContent).toContain("(optional)");

    await enter(address(), "http://studio.local:9000/v1");
    await act(async () => submit().click());
    // The blank optional field is left out rather than sent empty.
    expect(onSubmit).toHaveBeenCalledWith({
      fields: { baseUrl: "http://studio.local:9000/v1", runtime: "generic" },
      source: server,
    });
  });

  it("takes an address the way servers print it", async () => {
    const { onSubmit, submit } = await mount([server]);
    await act(async () => {
      runtime().value = "lmstudio";
      runtime().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await enter(address(), "localhost:1234");
    expect(address().value).toBe("http://localhost:1234/v1");
    expect(address().getAttribute("aria-invalid")).not.toBe("true");
    await act(async () => submit().click());
    expect(onSubmit).toHaveBeenLastCalledWith({
      fields: { baseUrl: "http://localhost:1234/v1", runtime: "lmstudio" },
      source: server,
    });
    // An address that already names its path is the person's to decide.
    await enter(address(), "https://gateway.example.com/api/v1/");
    expect(address().value).toBe("https://gateway.example.com/api/v1");
  });

  it("says what is wrong with an address the server path can't be joined to, before connecting", async () => {
    const { submit } = await mount([server]);
    const hint = () => address().closest("label")?.querySelector(".field__hint")?.textContent ?? "";
    // Even an empty query or fragment, or credentials in the address, cannot
    // survive the API path being appended.
    for (const value of [
      "ftp://nas/v1",
      "http://me:secret@localhost:11434/v1",
      "http://localhost:11434/v1?",
      "http://localhost:11434/v1#",
      "http://localhost:11434/v1?token=x",
    ]) {
      await enter(address(), value);
      expect(submit().disabled).toBe(true);
      expect(address().getAttribute("aria-invalid")).toBe("true");
      expect(hint()).toMatch(/without/i);
    }
    await enter(address(), "http://localhost:11434/v1");
    expect(submit().disabled).toBe(false);
    expect(address().getAttribute("aria-invalid")).not.toBe("true");
    expect(hint()).not.toMatch(/without/i);
  });

  it("starts each source from its own defaults when the person switches", async () => {
    const { onSubmit, submit } = await mount([lab, server, region]);
    expect(submit().textContent).toBe("Continue");
    const choose = async (sourceId: string) =>
      act(async () =>
        document.querySelector<HTMLInputElement>(`input[value="${sourceId}"]`)!.click(),
      );
    const scrollIntoView = vi
      .spyOn(Element.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    await choose("openai-compatible");
    // A long source list leaves the new fields below the fold; bring them up.
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "nearest" });
    scrollIntoView.mockRestore();
    await type(address(), "http://a:1/v1");
    await choose("bedrock");
    expect(document.querySelector<HTMLInputElement>("#add-account-region")?.value).toBe(
      "us-east-1",
    );
    await choose("openai-compatible");
    expect(address().value).toBe("");
    await choose("bedrock");
    await act(async () => submit().click());
    expect(onSubmit).toHaveBeenCalledWith({ fields: { region: "us-east-1" }, source: region });
  });
});
