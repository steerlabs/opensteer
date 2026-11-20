import { isLoopbackHostname } from "@opensteer/core";
import type { HostDiscoveryDocument } from "@opensteer/deployment-authority";
import {
  isNetworkedPersonalAuthority,
  isPersonalHost,
} from "@opensteer/deployment-authority/personal-access-route";
import { createHttpHostApiClient } from "../host/host-api-client.js";
import { describeConnectionAccess } from "./connection-resolver.js";
import {
  verifyAccessEndpoint,
  type AttachmentConnection,
  type VerifiedHostEndpoint,
} from "./deployment-catalog.js";
import { classifyClientFailure, ClientOperationError } from "./operation-error.js";

/**
 * A personal Home someone runs on their own server: reached at its own HTTPS
 * canonical origin, with no Remote access route and no pairing code. A Mac's
 * Home keeps a loopback canonical origin and is reached remotely only by route.
 */
export function isNetworkedHome(
  document: Pick<HostDiscoveryDocument, "canonicalOrigin" | "deploymentShape">,
): boolean {
  return isNetworkedPersonalAuthority(document);
}

/**
 * Whether this Deployment signs people in with its own native OAuth at its
 * canonical origin: a team server, or a networked Home listed by that origin.
 */
export function usesHostNativeOAuth(connection: AttachmentConnection): boolean {
  return (
    !isPersonalHost(connection.authority.document) ||
    (describeConnectionAccess(connection, null).access === "native" &&
      isNetworkedHome(connection.authority.document))
  );
}

export interface VerifiedDeploymentAddress extends VerifiedHostEndpoint {
  readonly kind: "personal" | "team";
}

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
    throw deploymentAddressRefusal("address-needs-https");
  const verified = await verifyAccessEndpoint({
    fetch: options.fetch,
    kind: "canonical",
    origin: address.origin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!isPersonalHost(verified.discovery)) return { ...verified, kind: "team" };
  if (!isNetworkedHome(verified.discovery)) throw deploymentAddressRefusal("address-needs-pairing");
  if (await homeNeedsOwner(verified.discovery.canonicalOrigin, options))
    throw deploymentAddressRefusal("address-needs-owner");
  return { ...verified, kind: "personal" };
}

/** Best effort: a Home that can't say whether it is claimed is left to its own sign-in page. */
async function homeNeedsOwner(
  origin: string,
  options: { readonly fetch: typeof globalThis.fetch; readonly signal?: AbortSignal },
): Promise<boolean> {
  const client = createHttpHostApiClient({
    baseUrl: new URL(origin),
    kind: "personal",
    fetch: (url, init) =>
      options.fetch(url, {
        ...init,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
    onAuthenticationRequired() {},
  });
  const result = await client["auth.config"]({}, options.signal ? { signal: options.signal } : {});
  return result.ok && result.data.setupState === "required";
}

const addressRefusals = {
  "address-needs-https": "That address needs https.",
  "address-needs-pairing":
    "That address belongs to a computer reached by Remote access. Pair it with a pairing code from that computer.",
  "address-needs-owner":
    "This Opensteer has no owner yet. Open the setup link from your server to claim it.",
} as const;

function deploymentAddressRefusal(reason: keyof typeof addressRefusals): ClientOperationError {
  return new ClientOperationError(addressRefusals[reason], "blocked", { reason });
}

export function deploymentAddressFailure(error: unknown): string {
  const reason = classifyClientFailure(error).reason;
  return Object.hasOwn(addressRefusals, reason)
    ? addressRefusals[reason as keyof typeof addressRefusals]
    : "Opensteer isn’t answering at that address.";
}
