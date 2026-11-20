import { isLoopbackHostname } from "@opensteer/core";
import { apiVersionHeaders, type HostDiscoveryDocument } from "@opensteer/deployment-authority";
import { z } from "zod";
import {
  verifyAccessEndpoint,
  type AttachmentConnection,
  type VerifiedHostEndpoint,
} from "./deployment-catalog.js";
import { ClientOperationError } from "./operation-error.js";

/**
 * A personal Home someone runs on their own server: reached at its own HTTPS
 * canonical origin, with no Remote access route and no pairing code. A Mac's
 * Home keeps a loopback canonical origin and is reached remotely only by route.
 */
export function isNetworkedHome(
  document: Pick<HostDiscoveryDocument, "canonicalOrigin" | "deploymentShape">,
): boolean {
  if (document.deploymentShape.kind !== "personal") return false;
  const canonical = new URL(document.canonicalOrigin);
  return canonical.protocol === "https:" && !isLoopbackHostname(canonical.hostname);
}

/**
 * Whether this Deployment signs people in with its own native OAuth at its
 * canonical origin: a team server, or a networked Home listed by that origin.
 */
export function usesHostNativeOAuth(
  connection: Pick<AttachmentConnection, "authority" | "kind" | "reachability">,
): boolean {
  return (
    connection.kind === "team" ||
    (connection.reachability === "canonical" && isNetworkedHome(connection.authority.document))
  );
}

export interface VerifiedDeploymentAddress extends VerifiedHostEndpoint {
  readonly kind: "personal" | "team";
}

const setupStateSchema = z.object({
  ok: z.literal(true),
  data: z.object({ setupState: z.enum(["complete", "required"]) }),
});

/**
 * Step one of adding a Deployment by its address: a team server, or a Home.
 * Verifies the signed discovery at the canonical origin, exactly as a team is
 * pinned, and sends no credential. A Mac Home reached by Remote access is the
 * pairing door instead, so its loopback authority is refused here.
 */
export async function verifyDeploymentAddress(options: {
  readonly fetch: typeof globalThis.fetch;
  readonly origin: string;
  readonly signal?: AbortSignal;
}): Promise<VerifiedDeploymentAddress> {
  const address = new URL(options.origin);
  if (address.protocol !== "https:" && !isLoopbackHostname(address.hostname))
    throw new ClientOperationError("That address needs https.", "blocked");
  const verified = await verifyAccessEndpoint({
    fetch: options.fetch,
    kind: "canonical",
    origin: address.origin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (verified.discovery.deploymentShape.kind === "team") return { ...verified, kind: "team" };
  if (!isNetworkedHome(verified.discovery))
    throw new ClientOperationError(
      "That address belongs to a computer reached by Remote access. Pair it with a pairing code from that computer.",
      "blocked",
    );
  if (await homeNeedsOwner(verified.discovery.canonicalOrigin, options))
    throw new ClientOperationError(
      "This Opensteer has no owner yet. Open the setup link from your server to claim it.",
      "blocked",
    );
  return { ...verified, kind: "personal" };
}

/** Best effort: a Home that can't say whether it is claimed is left to its own sign-in page. */
async function homeNeedsOwner(
  origin: string,
  options: { readonly fetch: typeof globalThis.fetch; readonly signal?: AbortSignal },
): Promise<boolean> {
  try {
    const response = await options.fetch(new URL("/v1/rpc/auth.config?input=%7B%7D", origin), {
      cache: "no-store",
      credentials: "omit",
      headers: { accept: "application/json", ...apiVersionHeaders("personal") },
      method: "GET",
      redirect: "error",
      referrerPolicy: "no-referrer",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return false;
    const parsed = setupStateSchema.safeParse(await response.json());
    return parsed.success && parsed.data.data.setupState === "required";
  } catch {
    return false;
  }
}
