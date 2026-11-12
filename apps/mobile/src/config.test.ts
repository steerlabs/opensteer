import { describe, expect, it } from "vitest";
import { readMobileConfiguration } from "./config.js";

const distribution = { development: false };
const developmentBundle = { development: true };

describe("readMobileConfiguration", () => {
  it("refuses an Account origin that is not one", () => {
    expect(() =>
      readMobileConfiguration(
        { EXPO_PUBLIC_OPENSTEER_ACCOUNT_ORIGIN: "not an origin" },
        distribution,
      ),
    ).toThrow();
  });

  it("turns the development entry on only for the exact flag", () => {
    expect(
      readMobileConfiguration({ EXPO_PUBLIC_OPENSTEER_MOCK: "1" }, developmentBundle).mock,
    ).toBe(true);
    expect(
      readMobileConfiguration({ EXPO_PUBLIC_OPENSTEER_MOCK: "0" }, developmentBundle).mock,
    ).toBe(false);
  });

  it("refuses a value it cannot read rather than guessing what was meant", () => {
    expect(() =>
      readMobileConfiguration({ EXPO_PUBLIC_OPENSTEER_MOCK: "true" }, developmentBundle),
    ).toThrow();
  });

  it("will not run the simulated product in a build that is not a development one", () => {
    const configuration = readMobileConfiguration(
      { EXPO_PUBLIC_OPENSTEER_MOCK: "1" },
      distribution,
    );

    expect(configuration.mock).toBe(false);
    expect(configuration.refusal).toMatch(/mock mode/u);
  });

  it("lets a build command declare a development or preview build", () => {
    for (const profile of ["development", "preview"] as const) {
      const configuration = readMobileConfiguration(
        { EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE: profile, EXPO_PUBLIC_OPENSTEER_MOCK: "1" },
        distribution,
      );

      expect(configuration.mock).toBe(true);
      expect(configuration.refusal).toBeNull();
    }
  });

  it("does not let the production profile open the same door", () => {
    const configuration = readMobileConfiguration(
      { EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE: "production", EXPO_PUBLIC_OPENSTEER_MOCK: "1" },
      distribution,
    );

    expect(configuration.mock).toBe(false);
    expect(configuration.refusal).not.toBeNull();
  });

  it("refuses a build profile it does not know", () => {
    expect(() =>
      readMobileConfiguration({ EXPO_PUBLIC_OPENSTEER_BUILD_PROFILE: "staging" }, distribution),
    ).toThrow();
  });
});

it("only offers Mac sharing when a portal origin is configured", () => {
  expect(readMobileConfiguration({}, distribution).portalOrigin).toBeNull();
  expect(
    readMobileConfiguration(
      { EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN: "https://app.example.com" },
      distribution,
    ).portalOrigin,
  ).toBe("https://app.example.com");
  expect(() =>
    readMobileConfiguration(
      { EXPO_PUBLIC_OPENSTEER_PORTAL_ORIGIN: "https://app.example.com/path" },
      distribution,
    ),
  ).toThrow();
});
