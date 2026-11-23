import { describe, expect, it } from "vitest";
import {
  homePickerReason,
  settingsDestinations,
  settingsDestinationTarget,
} from "./settings-home-model.js";

describe("a Settings row with no Home open", () => {
  it("opens the Home picker told which page it is choosing a Home for, by the row's own name", () => {
    for (const { route, title } of settingsDestinations) {
      const target = settingsDestinationTarget(route, null);
      if (route === "SettingsAiSharing") expect(target).toEqual({ name: route });
      else expect(target).toEqual({ name: "DeploymentSwitcher", params: { opening: title } });
    }
    expect(homePickerReason("Messaging")).toBe(
      "Messaging belongs to a Home. Choose the Home whose Messaging you want to open.",
    );
  });

  it("opens the page for the open Home", () => {
    expect(settingsDestinationTarget("SettingsMessaging", "dep_1")).toEqual({
      name: "SettingsMessaging",
      params: { deploymentId: "dep_1" },
    });
  });
});
