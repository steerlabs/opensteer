import {
  buildIntegrationAuthorizationAppReturn,
  integrationAuthorizationAppReturnBase,
  parseIntegrationAuthorizationAppReturn,
  type IntegrationAuthorizationAppReturn,
} from "@opensteer/integration-core";

export const opensteerMobileIntegrationAuthorizationCallback =
  integrationAuthorizationAppReturnBase("native");

export type NativeIntegrationAuthorizationCallback = IntegrationAuthorizationAppReturn;

/**
 * Uses the shared fixed mobile callback, including an optional app return proof.
 */
export function buildNativeIntegrationAuthorizationCallback(
  input: Omit<NativeIntegrationAuthorizationCallback, "returnProof"> & {
    readonly returnProof?: string | null;
  },
): string {
  return buildIntegrationAuthorizationAppReturn("native", {
    ...input,
    returnProof: input.returnProof ?? null,
  });
}

/** Accepts exactly this build's sign-in return shape and nothing else. */
export function parseNativeIntegrationAuthorizationCallback(
  rawUrl: string,
): NativeIntegrationAuthorizationCallback | null {
  return parseIntegrationAuthorizationAppReturn("native", rawUrl);
}

export { IntegrationAuthorizationAttempts } from "./authorization-attempts.js";

export class IntegrationAuthorizationCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled.");
  }
}
