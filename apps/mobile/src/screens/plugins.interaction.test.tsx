// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostClient, HostSnapshot } from "@opensteer/client/host";
import type { LocalMcpSecretServer } from "@opensteer/client/integrations";
import { MockHostClient } from "@opensteer/client/mock";
import { native } from "../../test-support/settings-screens.js";

// What could break: an install that never reaches the Host, a switch for a
// place that never changes, a removal without confirmation, or install
// controls shown to someone the Host will refuse.

const harness = vi.hoisted(() => ({
  client: null as HostClient | null,
  secretServers: [] as readonly LocalMcpSecretServer[],
}));
vi.mock("@opensteer/client/integrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@opensteer/client/integrations")>()),
  localMcpSecretServers: async () => [...harness.secretServers],
}));
vi.mock(
  "react-native",
  async () => (await import("../../test-support/settings-screens.js")).reactNative,
);
vi.mock(
  "../ui/primitives.js",
  async () => (await import("../../test-support/settings-screens.js")).primitives,
);
vi.mock(
  "../ui/choice-menu.js",
  async () => (await import("../../test-support/settings-screens.js")).choiceMenu,
);
vi.mock(
  "../ui/screen.js",
  async () => (await import("../../test-support/settings-screens.js")).screen,
);
vi.mock("../ui/symbol.js", () => ({ Symbol: () => null }));
vi.mock("../ui/workspace-mark.js", () => ({ WorkspaceMark: () => null }));
vi.mock("./deployment-gate.js", () => ({
  DeploymentGate: () => null,
  useAttachedHost: () => harness.client,
}));
vi.mock("../client/mobile-client.js", () => ({
  operationDetail: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

const { PluginsScreen } = await import("./plugins.js");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
const clients: MockHostClient[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  document.body.replaceChildren();
  harness.client = null;
  native.reset();
});

/** Waits, with a deadline well inside the test's, for what the last action should show. */
async function shows(check: () => void): Promise<void> {
  await vi.waitFor(check, { timeout: 2_000 });
}

async function open(
  options: {
    readonly administrator?: boolean;
    readonly secretServers?: readonly LocalMcpSecretServer[];
  } = {},
) {
  const host = new MockHostClient({ automations: "absent", latencyMs: 0 });
  clients.push(host);
  await host.load();
  // The mock runs no server on a computer; this person may own one that takes secrets.
  harness.secretServers = options.secretServers ?? [];
  if (options.administrator === false) {
    const read = host.getSnapshot.bind(host);
    const held = new WeakMap<HostSnapshot, HostSnapshot>();
    vi.spyOn(host, "getSnapshot").mockImplementation(() => {
      const snapshot = read();
      const view =
        held.get(snapshot) ??
        ({
          ...snapshot,
          user: snapshot.user ? { ...snapshot.user, instanceRole: "user" } : null,
        } as HostSnapshot);
      held.set(snapshot, view);
      return view;
    });
  }
  harness.client = host;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<PluginsScreen route={{ params: { deploymentId: "deployment" } }} />));
  await shows(() =>
    expect(container.querySelector('[role="progressbar"]'), "plugins were never read").toBeNull(),
  );
  return { container, host };
}

function button(scope: ParentNode, text: string): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === text || node.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text}`);
  return found;
}

async function press(target: HTMLElement): Promise<void> {
  await act(async () => target.click());
}

describe("Settings → Plugins on the phone", () => {
  it("installs from a folder, turns it on in Main, and removes it after confirming", async () => {
    const { container } = await open();
    expect(container.textContent).toContain("Nothing installed yet");
    const folder = container.querySelector<HTMLInputElement>('input[aria-label="Folder"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(folder, "/Users/me/plugins/notes");
      folder.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(button(container, "Install plugin"));
    await shows(() =>
      expect(container.textContent, "the plugin was never listed").toContain("Off everywhere"),
    );
    expect(container.textContent).toContain("notes");
    expect(container.textContent).toContain("Off everywhere");
    expect(container.textContent).toContain("/Users/me/plugins/notes");

    await press(button(container, "Off everywhere. Show where notes can be on"));
    await press(container.querySelector<HTMLInputElement>('input[aria-label="notes on in Main"]')!);
    await shows(() =>
      expect(container.textContent, "it never turned on in Main").toContain("On in Main"),
    );

    await press(button(container, "Remove"));
    expect(native.alert?.title).toBe("Remove notes?");
    const remove = native.alert!.buttons.find(({ text }) => text === "Remove plugin")!;
    await act(async () => remove.onPress!());
    await shows(() =>
      expect(container.textContent, "the plugin was never removed").toContain(
        "Nothing installed yet",
      ),
    );
  });

  it("tells someone who isn't an administrator who manages plugins, and offers no install", async () => {
    const { container } = await open({ administrator: false });
    expect(container.textContent).toContain("An administrator manages plugins");
    expect(container.querySelector('input[aria-label="Folder"]')).toBeNull();
    expect(container.textContent).not.toContain("Secrets on your computers");
  });

  it("lets a computer's owner who isn't an administrator change its plugin's secrets", async () => {
    const serverId = "isv_00000000-0000-4000-8000-000000000009" as LocalMcpSecretServer["id"];
    const { container, host } = await open({
      administrator: false,
      secretServers: [
        {
          computer: "Studio Mac",
          id: serverId,
          name: "camera",
          plugin: "Tapo",
          secrets: [{ name: "CAMERA_PASSWORD", title: "Camera password" }],
        },
      ],
    });
    const dispatch = vi
      .spyOn(host, "dispatch")
      .mockResolvedValue({ type: "integration.server.secrets.set" } as never);
    await shows(() =>
      expect(container.textContent, "its secrets were never listed").toContain(
        "Secrets on your computers",
      ),
    );
    expect(container.textContent).toContain("camera · Studio Mac · Camera password");
    await press(button(container, "Change"));
    await press(button(container, "Save"));
    expect(container.textContent).toContain("Enter a new value to change.");
    const field = container.querySelector<HTMLInputElement>('input[aria-label="Camera password"]')!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(field, "swordfish");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await press(button(container, "Save"));
    await shows(() =>
      expect(container.textContent, "the change was never confirmed").toContain(
        "Tapo’s secrets changed",
      ),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        secrets: { CAMERA_PASSWORD: "swordfish" },
        serverId,
        type: "integration.server.secrets.set",
      }),
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
