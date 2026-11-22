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
    await client.load();
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
              message: "Turn on Remote access to add a computer.",
              reason: "personal-remote-access-off",
            },
          },
    );
    const mint = vi.fn(client.dispatch.bind(client));
    shell = {
      hostClient: {
        connection: client.connection,
        rpc: { "agentPhone.target.get": target },
        dispatch: mint,
      },
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
    await click("Linux server");
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
      expect(document.body.textContent).toContain("Turn on Remote access");
      expect(document.querySelector("pre")).toBeNull();
    }
  },
);

it.each([
  ["cloud-computer", "sign in with your Opensteer account", "password"],
  ["server", "sign in with your password", "Opensteer account"],
] as const)("tells a %s Home how to sign in on another device", async (homeKind, says, never) => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  const snapshot = client.getSnapshot();
  shell = {
    hostClient: client,
    snapshot: {
      ...snapshot,
      identityConfig: {
        ...snapshot.identityConfig,
        exposure: "networked",
        homeKind,
        publicOrigin: "https://home.example",
      },
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AddDeviceDialog homeName="Home" onClose={() => undefined} />);
  });
  await click("Use a pairing code");
  const text = (container.textContent ?? "").replace(/\s+/gu, " ");
  expect(text).toContain(says);
  expect(text).not.toContain(never);
});

it("lists what can be added by the thing itself, with a pairing code under Advanced", async () => {
  client = new MockHostClient({ latencyMs: 0 });
  await client.load();
  shell = { hostClient: client, snapshot: client.getSnapshot() };
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AddDeviceDialog homeName="Home" onClose={() => undefined} />);
  });
  const titles = [...container.querySelectorAll(".add-device__choices .option-row__title")].map(
    (element) => element.textContent,
  );
  expect(titles).toEqual([
    "A Mac",
    "A phone",
    "Chrome",
    "iPhone screen control",
    "Android Agent Phone",
    "Linux server",
    "Use a pairing code",
  ]);
  const advanced = container.querySelector("details.add-device__advanced");
  expect(advanced?.textContent).toContain("Use a pairing code");
  expect(advanced?.hasAttribute("open")).toBe(false);
  await click("A phone");
  expect(container.textContent).toContain(
    "Get the Opensteer app on the phone and sign in with the same Opensteer account.",
  );
});
