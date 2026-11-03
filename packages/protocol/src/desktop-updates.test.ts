import { expect, it } from "vitest";
import { DesktopUpdateChannelSchema, DesktopUpdateStateSchema } from "./desktop.js";
it("accepts only the two selectable desktop channels", () => {
  expect(DesktopUpdateChannelSchema.options).toEqual(["stable", "beta"]);
  for (const value of ["latest", "insider", "nightly", null, {}])
    expect(DesktopUpdateChannelSchema.safeParse(value).success).toBe(false);
});
it("carries channel evidence separately from an offer", () => {
  expect(
    DesktopUpdateStateSchema.parse({
      status: "ahead",
      channel: "stable",
      currentVersion: "0.1.430",
      latestVersion: "0.1.420",
      availableVersion: null,
      downloadPercent: null,
      failed: null,
    }),
  ).toMatchObject({ latestVersion: "0.1.420", availableVersion: null });
});
