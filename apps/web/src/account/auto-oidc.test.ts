import type { IdentityConfig } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { shouldAutoStartOidc, type AutoOidcOptions } from "./auto-oidc.js";

const config = {
  deployment: { cloud: false, kind: "self-hosted" as const, name: null },
  emailDeliveryAvailable: false,
  localPasswordEnabled: false,
  machineOwner: false,
  oidcProviders: [{ id: "opensteer-account", label: "Opensteer Account", type: "oidc" }],
  passkeysEnabled: false,
  exposure: "networked",
  portalOrigin: null,
  publicOrigin: "https://host.opensteer.test",
  setupState: "complete",
  signupPolicy: "invite-only",
} satisfies IdentityConfig;

const options = {
  desktop: false,
  hasAuthorizationError: false,
  hasNativeOAuthQuery: false,
  recentAttempt: false,
  setupInProgress: false,
} satisfies AutoOidcOptions;

describe("shouldAutoStartOidc", () => {
  it("starts for exactly one OIDC provider with no password sign-in", () => {
    expect(shouldAutoStartOidc(config, options)).toBe(true);
  });

  it("does not start when password sign-in is available", () => {
    expect(shouldAutoStartOidc({ ...config, localPasswordEnabled: true }, options)).toBe(false);
  });

  it("does not start when more than one OIDC provider is available", () => {
    expect(
      shouldAutoStartOidc(
        {
          ...config,
          oidcProviders: [
            ...config.oidcProviders,
            { id: "company", label: "Company SSO", type: "oidc" },
          ],
        },
        options,
      ),
    ).toBe(false);
  });

  it("does not start inside Desktop", () => {
    expect(shouldAutoStartOidc(config, { ...options, desktop: true })).toBe(false);
  });

  it("does not start during native OAuth consent", () => {
    expect(shouldAutoStartOidc(config, { ...options, hasNativeOAuthQuery: true })).toBe(false);
  });

  it("does not start while an authorization failure is on screen", () => {
    expect(shouldAutoStartOidc(config, { ...options, hasAuthorizationError: true })).toBe(false);
  });

  it("does not start during initial-owner setup or after a recent attempt", () => {
    expect(shouldAutoStartOidc({ ...config, setupState: "required" }, options)).toBe(false);
    expect(shouldAutoStartOidc(config, { ...options, setupInProgress: true })).toBe(false);
    expect(shouldAutoStartOidc(config, { ...options, recentAttempt: true })).toBe(false);
  });
});
