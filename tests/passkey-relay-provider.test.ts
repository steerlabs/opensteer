import { expect, it } from "vitest";
import { chromium } from "playwright-core";
import { PlaywrightChromiumLauncher } from "../apps/browser-runtime/src/browser/playwright-launcher.js";
import {
  PasskeyProviderTestAuthenticator,
  passkeyProviderChromiumArguments,
  runPasskeyProviderScenario,
} from "../packages/browser-runtime-core/src/test-support/passkey-provider-scenario.js";
it.each(["person", "unknown"] as const)(
  "relays the shared provider scenario through a Host (%s cause)",
  async (cause) => {
    const { HostRelayAuthenticator } =
      await import("../packages/browser-runtime-core/src/passkeys/host-relay.js");
    const { PasskeyService } = await import("../apps/host/src/browser/passkey-service.js");
    const {
      NormalizedPasskeyCreationOptionsJSONSchema,
      NormalizedPasskeyRequestOptionsJSONSchema,
      passkeyBytesToJSON,
    } = await import("../packages/protocol/src/passkeys.js");
    const { decodeBase64Url } = await import("@opensteer/shared/base64url");
    const authenticator = new PasskeyProviderTestAuthenticator();
    const controllers = new Map<string, AbortController>();
    const token = "e2799da2-9fe9-438e-a160-47e275ee2703";
    const causes: unknown[] = [];
    const relay = new HostRelayAuthenticator((targetId) => {
      if (cause === "person") relay.record(targetId, { person: token });
      return {
        sessionId: "session",
        surfaceId: targetId,
        send: (message) => {
          if (message.type === "passkey.ceremony") {
            causes.push(message.cause);
            viewer.surfaceId = message.surfaceId;
            host.ceremony(message);
          }
          if (message.type === "passkey.cancel") host.cancel(message.ceremonyId);
        },
      };
    });
    const viewer: import("../apps/host/src/browser/passkey-service.js").PasskeyViewer = {
      token,
      userId: "person",
      fullControl: true,
      mode: "native",
      surfaceId: null,
      live: true,
      authorized: async () => true,
      send: (message) => {
        if (message.type === "browser.passkey.offer")
          void host.viewer(token, { type: "passkey.claim", requestId: message.requestId });
        if (message.type === "browser.passkey.withdrawn")
          controllers.get(message.requestId)?.abort();
        if (message.type !== "browser.passkey.request") return;
        const controller = new AbortController();
        controllers.set(message.requestId, controller);
        const common = {
          origin: message.origin,
          rpId: message.rpId,
          signal: controller.signal,
          clientDataJSON: decodeBase64Url(message.clientDataJSON),
        };
        void authenticator
          .ceremony(
            message.op === "create"
              ? {
                  ...common,
                  op: "create",
                  options: NormalizedPasskeyCreationOptionsJSONSchema.parse(message.options),
                }
              : {
                  ...common,
                  op: "get",
                  options: NormalizedPasskeyRequestOptionsJSONSchema.parse(message.options),
                },
          )
          .then((outcome) =>
            host.viewer(token, {
              type: "passkey.respond",
              requestId: message.requestId,
              outcome: passkeyBytesToJSON(outcome),
            }),
          );
      },
    };
    const host = new PasskeyService({
      ownOrigins: () => [],
      viewers: () => [viewer],
      result: (message) => relay.result("session", message),
    });
    try {
      await runPasskeyProviderScenario({
        authenticator,
        launcher: new PlaywrightChromiumLauncher({
          chromiumSandbox: false,
          executablePath: chromium.executablePath(),
          headless: true,
          authenticator: relay,
          args: passkeyProviderChromiumArguments,
        }),
      });
      expect(causes).toContainEqual(cause === "person" ? { person: token } : "unknown");
    } finally {
      host.close();
      relay.close();
      for (const controller of controllers.values()) controller.abort();
    }
  },
  60_000,
);
