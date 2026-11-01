// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { threadPlacementOptions } from "@opensteer/client/host";
import { AiEngineSettings } from "./ai-engines.js";

/**
 * The five engines as a work location actually reports them, through the mock
 * Runner rather than a hand-built environment: what "Add account" offers for an
 * engine with many sources, what an engine with an ambient-only source offers,
 * and what an account reads like where its engine cannot run at all.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
});

async function mount(environmentId?: string) {
  const client = new MockHostClient();
  clients.push(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const snapshot = client.getSnapshot();
  const environments = environmentId
    ? snapshot.environments.filter((environment) => environment.id === environmentId)
    : snapshot.environments;
  await act(async () => {
    root.render(
      <MemoryRouter>
        <AiEngineSettings
          client={client}
          environments={environments}
          harnesses={snapshot.harnesses}
          onAuthenticate={vi.fn()}
          onError={vi.fn()}
          placements={threadPlacementOptions(environments, snapshot.harnesses)}
          updatesAvailable
        />
      </MemoryRouter>,
    );
  });
  return { client, container };
}

function engineCard(container: HTMLElement, driverKind: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(
    `[aria-labelledby="settings-engine-${driverKind}"]`,
  );
  if (!card) throw new Error(`No ${driverKind} card`);
  return card;
}

describe("the engines a work location reports", () => {
  it("shows model servers, then all five engines in catalog order", async () => {
    const { container } = await mount();

    expect(
      [...container.querySelectorAll(".settings-engine__title")].map((node) => node.textContent),
    ).toEqual(["Model servers", "Codex", "Claude Code", "OpenCode", "Pi", "Cursor"]);
  });

  it("offers a capability-gated update for an installed engine", async () => {
    const { client, container } = await mount();
    const update = engineCard(container, "codex").querySelector<HTMLButtonElement>(
      ".settings-engine__update",
    );
    if (!update) throw new Error("Codex Update button missing");
    expect(engineCard(container, "codex").textContent).toContain("Update available");
    const dispatch = vi.spyOn(client, "dispatch");
    await act(async () => update.click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ driverKind: "codex", type: "harness.update" }),
    );
  });

  it("lists every source an engine offers, each with what it talks to", async () => {
    const { container } = await mount();
    const add = engineCard(container, "opencode").querySelector<HTMLButtonElement>(
      ".settings-engine__add",
    );
    if (!add) throw new Error("OpenCode has no Add account button");
    await act(async () => add.click());

    const choices = [...document.querySelectorAll(".add-account__sources .settings-choice")];
    expect(
      choices.map((node) => node.querySelector(".settings-choice__title")?.textContent),
    ).toEqual(["OpenCode Zen", "OpenCode Go", "OpenAI", "Anthropic", "OpenRouter"]);
    // A source's own sentence is what tells it apart from the lab beside it.
    expect(choices[1]?.textContent).toContain("The OpenCode Go plan, billed by OpenCode.");
    // A model server is added under Model servers, where the computer finds it.
    expect(document.body.textContent).not.toContain("Ollama, LM Studio, oMLX");
    // One flat group with one question: nothing here groups by `kind`.
    expect(document.querySelectorAll(".add-account__sources")).toHaveLength(1);
    expect(document.querySelectorAll(".add-account__sources legend")).toHaveLength(1);
  });

  it("offers no account to add for an engine whose only sign-in is the CLI's own", async () => {
    const { container } = await mount();

    // Cursor's one source is `ambient`: the credential lives in this
    // computer's keychain, so there is nothing for Opensteer to add.
    expect(engineCard(container, "cursor").querySelector(".settings-engine__add")).toBeNull();
    expect(engineCard(container, "cursor").textContent).toContain(
      "Shares the Cursor CLI’s sign-in on this computer",
    );
  });

  it("gives an account the Runner's own reason when its engine cannot run here", async () => {
    const { container } = await mount("env_00000000-0000-4000-8000-000000000002");
    const card = engineCard(container, "cursor");

    expect(card.textContent).toContain(
      "Cursor's CLI is not installed on this computer. Install it from https://cursor.com/install",
    );
    expect(card.querySelector(".chip--bad")?.textContent).toBe("Needs attention");
    // The engine advertises no sources at all here, which is not the same as
    // an engine that dropped the one this account names.
    expect(card.textContent).not.toContain("no longer offers");
  });
});
