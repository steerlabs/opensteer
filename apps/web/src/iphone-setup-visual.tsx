import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import {
  createMockIphoneSetupPort,
  MockHostClient,
  mockIphoneScreenDeviceId,
  mockIphoneScreenDriverId,
  mockIphoneSetupScenes,
  type MockIphoneSetupScene,
} from "@opensteer/client/mock";
import type { DeploymentId } from "@opensteer/core";
import { Dialog } from "./components/dialog.js";
import { AddIphoneDialog } from "./components/devices/add-iphone-dialog.js";
import { IphoneSetupOnMac } from "./components/devices/iphone-setup-needs.js";
import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/fraunces/wght.css";
import "./styles/index.css";

// `?scene=<name>` holds the dialog at one setup state; `?scene=journey` plays a whole setup;
// `?existing` fixes the mock Work iPhone instead; `?scene=on-mac` is the card shown where setup can't run.
const search = new URLSearchParams(location.search);
const scene = search.get("scene") ?? "journey";
const client = new MockHostClient({ latencyMs: 0 });
const port = createMockIphoneSetupPort({
  autoplay: scene === "journey",
  driverRunnerId: mockIphoneScreenDriverId,
  dispatch: (command) => client.dispatch(command),
  ...(scene in mockIphoneSetupScenes ? { start: scene as MockIphoneSetupScene } : {}),
});
Object.assign(window, { iphoneSetupVisual: port });

createRoot(document.getElementById("root")!).render(
  <MemoryRouter>
    {scene === "on-mac" ? (
      <Dialog
        labelledBy="on-mac-title"
        onClose={() => undefined}
        title={<span id="on-mac-title">Control an iPhone’s screen</span>}
      >
        <IphoneSetupOnMac />
      </Dialog>
    ) : (
      <AddIphoneDialog
        client={client}
        deploymentId={client.getSnapshot().deploymentId as DeploymentId}
        deploymentName="Alex’s Opensteer"
        onClose={() => undefined}
        port={port}
        {...(search.has("existing")
          ? {
              existing: {
                kind: "existing",
                deviceId: mockIphoneScreenDeviceId,
                expectedGeneration: 1,
              },
            }
          : {})}
      />
    )}
  </MemoryRouter>,
);
