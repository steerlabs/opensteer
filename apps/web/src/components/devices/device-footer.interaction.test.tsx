// @vitest-environment happy-dom
import { hostsDeployment } from "@opensteer/client/computers";
import { expect, it, vi } from "vitest";
import { client, mount } from "../workspace/workspace.interaction.test-support.js";
import { deviceRoute } from "./device-routes.js";

const footer = "Connected agents also need you to choose this Device’s profile or app for them.";

it("says under a Device's switches that a connected agent also needs its profile or app", async () => {
  await mount((source) => {
    const device = source
      .getSnapshot()
      .machines.find(
        (machine) =>
          !hostsDeployment(machine) && !machine.phoneDisplay && machine.status === "online",
      );
    if (!device) throw new Error("The mock Host has no other online computer");
    return deviceRoute(device.id);
  });
  await vi.waitFor(() => {
    if (!document.querySelector('[role="switch"]')) throw new Error("No switches drawn");
  });
  const section = document.querySelector(".device-uses");
  expect(section?.textContent).toContain(footer);
  expect(client.getSnapshot().machines.length).toBeGreaterThan(1);
});
