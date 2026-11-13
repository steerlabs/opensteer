// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MockHostClient } from "@opensteer/client/mock";
import { AddDeviceDialog } from "./add-device-dialog.js";

let shell: unknown;
vi.mock("../app-shell.js", () => ({ useShell: () => shell }));
let root: Root | undefined;
let client: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  client?.dispose();
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
});

async function click(label: string) {
  const button = [...document.querySelectorAll("button")].find((element) =>
    element.textContent?.includes(label),
  );
  if (!button) throw new Error(`Missing ${label}`);
  await act(async () => {
    button.click();
  });
}

it.each(["https://home.connect.example", "https://home.private.example", null])(
  "uses the approved route %s before minting a Server command",
  async (route) => {
    vi.stubEnv("OPENSTEER_RUNNER_SOURCE_REVISION", "a".repeat(40));
    vi.stubEnv("OPENSTEER_RUNNER_ARTIFACT_BASE_URL", "https://releases.example");
    client = new MockHostClient({ latencyMs: 0 });
    const snapshot = client.getSnapshot();
    const target = vi.fn().mockResolvedValue(
      route
        ? {
            ok: true,
            data: {
              deploymentId: snapshot.deploymentId!,
              deploymentName: "Home",
              hostInstanceId: "hst_00000000-0000-4000-8000-000000000001",
              hostUrl: route,
            },
          }
        : {
            ok: false,
            error: {
              code: "forbidden",
              message: "Turn on Use from anywhere to add a computer.",
              reason: "personal-remote-access-off",
            },
          },
    );
    const mint = vi.fn(client.dispatch.bind(client));
    shell = {
      hostClient: { rpc: { "agentPhone.target.get": target }, dispatch: mint },
      snapshot: {
        ...snapshot,
        identityConfig: { ...snapshot.identityConfig, publicOrigin: "http://127.0.0.1:4848" },
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<AddDeviceDialog homeName="Home" onClose={() => undefined} />);
    });
    await click("Server");
    await click("Create connection command");
    expect(target).toHaveBeenCalledOnce();
    if (route) {
      const commands = [...document.querySelectorAll("pre")].map((element) => element.textContent);
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command).toContain(`OPENSTEER_HOST_URL='${route}'`);
        expect(command).not.toContain("127.0.0.1");
      }
      expect(target.mock.invocationCallOrder[0]).toBeLessThan(mint.mock.invocationCallOrder[0]!);
    } else {
      expect(mint).not.toHaveBeenCalled();
      expect(document.body.textContent).toContain("Turn on Use from anywhere");
      expect(document.querySelector("pre")).toBeNull();
    }
  },
);
