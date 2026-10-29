export type IntegrationAuthorizationReturnSurface = "desktop" | "native" | "web";

export type IntegrationAuthorizationBrowserReturn =
  { readonly kind: "completion-page" } | { readonly kind: "redirect"; readonly location: string };

/**
 * Selects the browser destination after an integration authorization callback.
 *
 * The caller supplies the Deployment's already-verified canonical origin and a return path stored
 * with the authorization attempt. Browser input never chooses an origin. Desktop completes on the
 * callback page, native uses the one registered application link, and web returns to the stored
 * same-origin path with only the durable attempt id.
 */
export function integrationAuthorizationBrowserReturn(input: {
  readonly attemptId: string;
  readonly canonicalOrigin: string;
  readonly deploymentId?: string;
  readonly returnPath?: string;
  readonly surface: IntegrationAuthorizationReturnSurface;
}): IntegrationAuthorizationBrowserReturn {
  if (input.surface === "desktop") return { kind: "completion-page" };

  if (input.surface === "native") {
    if (!input.deploymentId) {
      throw new TypeError("Native integration authorization requires a Deployment identity");
    }
    const destination = new URL("com.opensteer.mobile:/oauth/integration-callback");
    destination.searchParams.set("deployment_id", input.deploymentId);
    destination.searchParams.set("attempt_id", input.attemptId);
    return { kind: "redirect", location: destination.toString() };
  }

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
