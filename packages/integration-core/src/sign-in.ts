import { z } from "zod";
import { IntegrationOAuthAttemptIdSchema } from "./ids.js";

/** What plugin sign-in attempts are named by, on the Host and in every app return. */
export const IntegrationAuthorizationAttemptIdSchema = IntegrationOAuthAttemptIdSchema;

/**
 * `app`: the consent finishes in the app that started it, which returns the
 * browser's one-use proof to its own Host. Only apps can receive that return;
 * a browser-only client stays proven by its Account sign-in.
 */
export const IntegrationAuthorizationFinishSchema = z.literal("app");

/**
 * The ports a desktop app may receive its browser return on. A hostile Host
 * chooses this value for its own attempts, so it may only name these reserved
 * ports, never a service a person happens to run on their computer.
 */
export const integrationAuthorizationReturnPorts = { first: 48_200, last: 48_215 } as const;
export const IntegrationAuthorizationReturnPortSchema = z
  .number()
  .int()
  .min(integrationAuthorizationReturnPorts.first)
  .max(integrationAuthorizationReturnPorts.last);

export const integrationProviderIdentityAlreadyConnectedFailureCode =
  "provider-identity-already-connected";
