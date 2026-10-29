// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient, ThreadPlacementOption } from "@opensteer/client/host";
import { HarnessAuthenticationDialog } from "./harness-authentication-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

// A model server that refused a request without a key offers only the key.
const placement = {
  accountName: "Ollama",
  engineName: "OpenCode",
  environmentId: "env-studio",
  harnessInstanceId: "hin-server",
  setupMethods: [
    {
      connectionSlot: "primary",
      inputLabel: "OpenAI-compatible endpoint API key",
      kind: "secret-input",
      label: "API key",
      methodId: "api-key",
    },
  ],
  source: { kind: "compatible-endpoint", label: "Model server" },
  whereLabel: "Studio",
} as unknown as ThreadPlacementOption;

async function mount() {
  const dispatch = vi.fn(async (command: { readonly type: string }) => ({
    authentication: {
      challenge: { inputLabel: "API key", kind: "secret-input" },
      status: "pending",
    },
    environmentStatus: "connected",
    type: command.type,
  }));
  const refresh = vi.fn(async () => undefined);
  const onReady = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <HarnessAuthenticationDialog
        client={{ dispatch, refresh, rpc: {} } as unknown as HostClient}
        onClose={vi.fn()}
        onReady={onReady}
        placement={placement}
      />,
    ),
  );
  return { dispatch, onReady, refresh };
}

describe("a model server that needs an API key", () => {
  it("opens straight on the key, named for the server rather than a sign-in", async () => {
    const { dispatch } = await mount();
    expect(document.getElementById("harness-authentication-title")?.textContent).toBe(
      "Connect Ollama",
    );
    // The only way in is chosen for the person; there is no list to pick from.
    expect(document.body.textContent).not.toContain("Choose how to connect");
    expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
      methodId: "api-key",
      type: "harness.authentication.begin",
    });
    expect(document.querySelector('input[type="password"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("Continue in browser");
  });
});
