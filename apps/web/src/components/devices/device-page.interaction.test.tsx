// @vitest-environment happy-dom
import { act } from "react";
import { expect, it, vi } from "vitest";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { mockIphoneScreenDeviceId, mockIphoneScreenDriverId } from "@opensteer/client/mock";
import { client, goTo, mount } from "../workspace/workspace.interaction.test-support.js";
import { deviceRoute, devicesRoute } from "./device-routes.js";

const button = (name: string) =>
  [...document.querySelectorAll("button")].find((entry) => entry.textContent?.trim() === name);

it("cancels a device's setup from Devices, so its token can never join", async () => {
  await mount(devicesRoute);
  const minted = await client.dispatch({
    allowedModules: ["browser", "integrations", "messaging", "shell"],
    idempotencyKey: mutationIdempotencyKey("server-add"),
    name: "Build box",
    type: "runner.enrollment.createLocal",
  });
  if (minted.type !== "runner.enrollment.createLocal") throw new Error("Nothing was minted");
  await act(async () => goTo!(deviceRoute(minted.enrollmentId)));
  await vi.waitFor(
    () => {
      if (!document.body.textContent?.includes("Setting up · expires"))
        throw new Error("The pending device never showed its expiry");
    },
    { timeout: 2_000 },
  );
  // Rename and switches act on a runner, which a pending row isn't yet.
  expect(document.querySelector('[aria-label="Rename Build box"]')).toBeNull();
  expect(document.querySelector('[role="switch"]')).toBeNull();

  await act(async () => button("Cancel setup")!.click());
  const confirm = [...document.querySelectorAll(".dialog button")].find(
    (entry) => entry.textContent?.trim() === "Cancel setup",
  ) as HTMLButtonElement;
  await act(async () => confirm.click());
  await vi.waitFor(
    () => {
      if (client.getSnapshot().machines.some(({ id }) => id === minted.enrollmentId))
        throw new Error("The pending row never left Devices");
    },
    { timeout: 2_000 },
  );
  expect(() => client.connectLocalRunner(minted.token)).toThrow(/not waiting to connect/);
});

it("disconnects an iPhone's screen control and keeps it, then removes only the iPhone", async () => {
  const phoneId = mockIphoneScreenDeviceId;
  const macId = mockIphoneScreenDriverId;
  await mount(deviceRoute(phoneId));
  const confirm = async (label: string) => {
    const action = [...document.querySelectorAll(".dialog button")].find(
      (entry) => entry.textContent?.trim() === label,
    ) as HTMLButtonElement;
    await act(async () => action.click());
  };
  const phone = () => client.getSnapshot().machines.find(({ id }) => id === phoneId);
  await vi.waitFor(() => {
    if (!button("Disconnect screen control")) throw new Error("No disconnect for the iPhone");
  });
  expect(document.body.textContent).toContain("Screen control through Alex’s MacBook Pro");

  await act(async () => button("Disconnect screen control")!.click());
  await confirm("Disconnect");
  await vi.waitFor(
    () => {
      if (phone()?.phoneDisplay?.driver?.attached !== false)
        throw new Error("Screen control never disconnected");
    },
    { timeout: 2_000 },
  );
  await vi.waitFor(() => {
    if (button("Disconnect screen control"))
      throw new Error("A detached iPhone still offers disconnect");
  });
  expect(document.body.textContent).toContain("Not connected");

  await act(async () => button("Remove this iPhone")!.click());
  expect(document.querySelector(".dialog")?.textContent).not.toContain("Browser profiles");
  await confirm("Remove");
  await vi.waitFor(
    () => {
      if (phone()) throw new Error("The iPhone was never removed");
    },
    { timeout: 2_000 },
  );
  expect(client.getSnapshot().machines.some(({ id }) => id === macId)).toBe(true);
});
