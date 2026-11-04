import {
  DeploymentIdSchema,
  opensteerDesktopApplicationId,
  opensteerMobileApplicationId,
  type DeploymentId,
} from "@opensteer/core";
import { z } from "zod";
import { IntegrationAuthorizationAttemptIdSchema } from "./models.js";

export type IntegrationAuthorizationReturnSurface = "desktop" | "native" | "web";
/** The surfaces whose consent finishes in the app that started it. */
export type IntegrationAuthorizationAppSurface = Exclude<
  IntegrationAuthorizationReturnSurface,
  "web"
>;

/**
 * The one-use proof an app-finished consent returns to the app that started it.
 * Only the attempt's own Host can redeem it, and only once.
 */
export const IntegrationAuthorizationReturnProofSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

export type IntegrationAuthorizationBrowserReturn =
  | { readonly kind: "completion-page" }
  | { readonly kind: "redirect"; readonly location: string }
  /** A page that offers the app return; desktop browsers open app links only when the person agrees. */
  | { readonly kind: "open-app"; readonly location: string };

export interface IntegrationAuthorizationAppReturn {
  readonly attemptId: z.infer<typeof IntegrationAuthorizationAttemptIdSchema>;
  readonly deploymentId: DeploymentId;
  /** Present when the consent waits for its app to prove it returned; absent for older returns. */
  readonly returnProof: string | null;
}

/** The fixed app return each native surface registers with its operating system. */
export function integrationAuthorizationAppReturnBase(
  surface: IntegrationAuthorizationAppSurface,
): string {
  const applicationId =
    surface === "desktop" ? opensteerDesktopApplicationId : opensteerMobileApplicationId;
  return `${applicationId}:/oauth/integration-callback`;
}

/**
 * Builds the app return. It names stored Deployment and attempt ids and, for an
 * app-finished consent, its one-use return proof; never a provider result,
 * credential, launch ticket or Host address.
 */
export function buildIntegrationAuthorizationAppReturn(
  surface: IntegrationAuthorizationAppSurface,
  input: IntegrationAuthorizationAppReturn,
): string {
  const url = new URL(integrationAuthorizationAppReturnBase(surface));
  url.searchParams.set("deployment_id", DeploymentIdSchema.parse(input.deploymentId));
  url.searchParams.set(
    "attempt_id",
    IntegrationAuthorizationAttemptIdSchema.parse(input.attemptId),
  );
  if (input.returnProof !== null) {
    url.searchParams.set(
      "return",
      IntegrationAuthorizationReturnProofSchema.parse(input.returnProof),
    );
  }
  return url.toString();
}

/** Accepts exactly this surface's app return shape and nothing else. */
export function parseIntegrationAuthorizationAppReturn(
  surface: IntegrationAuthorizationAppSurface,
  rawUrl: string,
): IntegrationAuthorizationAppReturn | null {
  if (rawUrl.length > 8_192) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const expected = new URL(integrationAuthorizationAppReturnBase(surface));
  if (
    url.protocol !== expected.protocol ||
    url.host !== expected.host ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    return null;
  }
  const keys = [...url.searchParams.keys()];
  const allowed = new Set(["deployment_id", "attempt_id", "return"]);
  if (
    keys.some((key) => !allowed.has(key)) ||
    keys.length !== new Set(keys).size ||
    url.searchParams.get("deployment_id") === null ||
    url.searchParams.get("attempt_id") === null
  ) {
    return null;
  }
  const deploymentId = DeploymentIdSchema.safeParse(url.searchParams.get("deployment_id"));
  const attemptId = IntegrationAuthorizationAttemptIdSchema.safeParse(
    url.searchParams.get("attempt_id"),
  );
  const rawProof = url.searchParams.get("return");
  const returnProof =
    rawProof === null ? null : IntegrationAuthorizationReturnProofSchema.safeParse(rawProof);
  if (!deploymentId.success || !attemptId.success || (returnProof && !returnProof.success)) {
    return null;
  }
  return {
    attemptId: attemptId.data,
    deploymentId: deploymentId.data,
    returnProof: returnProof?.data ?? null,
  };
}

/**
 * Selects the browser destination after an integration authorization callback.
 *
 * The caller supplies the Deployment's already-verified canonical origin and a return path stored
 * with the authorization attempt. Browser input never chooses an origin. An app-finished consent
 * returns to its surface's fixed app return with its proof; an older desktop attempt completes on
 * the callback page; native uses its fixed app return; web returns to the stored same-origin path
 * with only the durable attempt id.
 */
export function integrationAuthorizationBrowserReturn(input: {
  readonly attemptId: string;
  readonly canonicalOrigin: string;
  readonly deploymentId?: string;
  /** Present only for an app-finished consent that is waiting for its app. */
  readonly returnProof?: string;
  readonly finish?: "app";
  readonly returnPath?: string;
  readonly surface: IntegrationAuthorizationReturnSurface;
}): IntegrationAuthorizationBrowserReturn {
  if (input.surface === "web") return webReturn(input);
  if (input.surface === "desktop" && input.finish !== "app") return { kind: "completion-page" };
  if (!input.deploymentId) {
    throw new TypeError("An app integration return requires a Deployment identity");
  }
  const location = buildIntegrationAuthorizationAppReturn(input.surface, {
    attemptId: IntegrationAuthorizationAttemptIdSchema.parse(input.attemptId),
    deploymentId: DeploymentIdSchema.parse(input.deploymentId),
    returnProof: input.returnProof ?? null,
  });
  return input.surface === "desktop"
    ? { kind: "open-app", location }
    : { kind: "redirect", location };
}

function webReturn(input: {
  readonly attemptId: string;
  readonly canonicalOrigin: string;
  readonly returnPath?: string;
}): IntegrationAuthorizationBrowserReturn {
  if (input.returnPath === undefined) return { kind: "completion-page" };
  if (!input.returnPath.startsWith("/") || input.returnPath.startsWith("//")) {
    throw new TypeError("Web integration authorization requires a relative return path");
  }
  const canonical = verifiedCanonicalOrigin(input.canonicalOrigin);
  const destination = new URL(input.returnPath, canonical);
  if (
    destination.origin !== canonical ||
    destination.username.length > 0 ||
    destination.password.length > 0 ||
    destination.hash.length > 0
  ) {
    throw new TypeError("Integration authorization return path escaped the canonical origin");
  }
  destination.searchParams.set("integrationAttempt", input.attemptId);
  return { kind: "redirect", location: destination.toString() };
}

function verifiedCanonicalOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new TypeError("Integration authorization canonical origin is invalid", { cause: error });
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError("Integration authorization canonical origin is invalid");
  }
  return parsed.origin;
}
