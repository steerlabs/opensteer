// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeploymentCatalogStore,
  PrivateDeploymentConnectionService,
} from "@opensteer/client/connections";
import {
  MemoryPrivateFilesystem,
  signTestDiscoveryEnvelope,
  testHostAuthorityKeys,
  testHostDescriptor,
} from "@opensteer/client/test-support";
import { createId } from "@opensteer/core";
import {
  DesktopConnectPrivateDeploymentInputSchema,
  type DesktopConnectPrivateDeploymentInput,
} from "@opensteer/protocol/desktop";
import { DesktopConnect } from "./desktop-entry.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

/** Fills and submits the real "Add a Home by address" form; answers what it sends. */
async function submitAddress(origin: string): Promise<DesktopConnectPrivateDeploymentInput> {
  const onConnect = vi.fn<(input: DesktopConnectPrivateDeploymentInput) => void>();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <DesktopConnect
        busy={false}
        error={null}
        kind="address"
        onBack={vi.fn()}
        onConnect={onConnect}
      />,
    ),
  );
  const input = container.querySelector<HTMLInputElement>("#desktop-connect-origin")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, origin);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(onConnect).toHaveBeenCalledOnce();
  return onConnect.mock.calls[0]![0];
}

function discoveryAt(canonicalOrigin: string, kind: "personal") {
  return signTestDiscoveryEnvelope(
    {
      canonicalOrigin,
      deploymentId: createId("deployment"),
      deploymentShape: { kind },
      hostInstanceId: createId("hostInstance"),
      hostKey: { algorithm: "Ed25519" },
    },
    testHostAuthorityKeys(),
  );
}

describe("Add a Home by address", () => {
  it.each([["a Home on its own server", "https://home.example.com", "personal"]] as const)(
    "adds %s through the bridge's own schema",
    async (_name, origin, kind) => {
      const sent = await submitAddress(origin);
      // The bridge and the service parse exactly what the form sent.
      const bridged = DesktopConnectPrivateDeploymentInputSchema.parse(sent);
      const discovery = discoveryAt(origin, kind);
      const catalog = new DeploymentCatalogStore({
        filePath: "/private/deployment-catalog.json",
        privateFiles: new MemoryPrivateFilesystem(),
      });
      const service = new PrivateDeploymentConnectionService({
        catalog,
        fetch: async (request) =>
          String(request).includes("/v1/rpc/auth.config")
            ? Response.json({ ok: true, data: { setupState: "complete" } })
            : Response.json(testHostDescriptor(discovery)),
        sessions: {
          establish: vi.fn(async () => {
            throw new Error("An address is never paired");
          }),
          probe: vi.fn(async () => "unauthenticated" as const),
        },
      });
      await service.connect(bridged);
      const listed = (await catalog.load()).deployments;
      expect(listed).toMatchObject([
        { kind, authority: { document: { canonicalOrigin: origin } } },
      ]);
    },
  );
});
