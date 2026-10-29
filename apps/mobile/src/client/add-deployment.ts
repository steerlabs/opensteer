import type { HostSessionExchange } from "@opensteer/client/auth";
import {
  deploymentConnectionFromVerifiedEndpoints,
  deploymentConnectionFromVerifiedPersonalRoute,
  resolveConnection,
  verifyAccessEndpoint,
  verifyPersonalAccessEndpoint,
  type DeploymentCatalogStore,
  type VerifiedHostEndpoint,
  type VerifiedPersonalHostEndpoint,
} from "@opensteer/client/connections";
import { isPersonalHost } from "@opensteer/deployment-authority";
import { personalSessionFrom, type PersonalSessionStore } from "./personal-session-store.js";

export type AddDeploymentFetch = typeof globalThis.fetch;

/**
 * The two doors a person can open without an Opensteer Account.
 *
 * The Desktop's `PrivateDeploymentConnectionService` is the same two doors for
 * a computer that owns a cookie jar. A phone does not: its Personal session
 * comes back in the exchange body and this application has to keep it, so the
 * personal arm is composed here instead. Everything either door decides —
 * verifying the endpoint, refusing a Personal Host at the server door, building
 * the connection, and resolving the attachment — goes through the shared
 * client, which stays the only place those rules live.
 */

/**
 * Step one of the server door: prove the address serves a Deployment, and show
 * the person its name and key fingerprint before anything is added. No
 * credential is sent.
 */
export async function verifyServerDeployment(options: {
  readonly fetch: AddDeploymentFetch;
  readonly origin: string;
  readonly signal?: AbortSignal;
}): Promise<VerifiedHostEndpoint> {
  const verified = await verifyAccessEndpoint({
    fetch: options.fetch,
    kind: "canonical",
    origin: options.origin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (isPersonalHost(verified.discovery)) {
    throw new Error(
      "That address belongs to a personal computer. Use “Connect to a computer” and its pairing code.",
    );
  }
  return verified;
}

/** Step two: add the verified Deployment and make it the selected one. */
export async function addServerDeployment(options: {
  readonly catalog: Pick<DeploymentCatalogStore, "upsertAndSelect">;
  readonly name: string;
  readonly verified: VerifiedHostEndpoint;
}): Promise<void> {
  await options.catalog.upsertAndSelect(
    deploymentConnectionFromVerifiedEndpoints({
      accountAccess: null,
      endpoints: [options.verified],
      kind: "self-hosted",
      name: options.name,
      source: { kind: "manual" },
    }),
  );
}

/** Step one of the personal door: the computer's separately signed HTTPS route. */
export async function verifyPersonalDeployment(options: {
  readonly fetch: AddDeploymentFetch;
  readonly origin: string;
  readonly signal?: AbortSignal;
}): Promise<VerifiedPersonalHostEndpoint> {
  return verifyPersonalAccessEndpoint({
    fetch: options.fetch,
    origin: options.origin,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

/**
 * Step two: redeem the one-use pairing code the operator carried off that
 * computer, keep the session the Host hands back, and add the Deployment.
 *
 * The exchange asks for header delivery because this build's OAuth identity is
 * the phone's. A Host that answers with a cookie is one this app cannot hold a
 * session for, and `personalSessionFrom` says so rather than pretending the
 * pairing worked.
 */
export async function addPersonalDeployment(options: {
  readonly catalog: Pick<DeploymentCatalogStore, "upsertAndSelect">;
  readonly name: string;
  readonly pairingCode: string;
  readonly sessions: PersonalSessionStore;
  readonly exchange: Pick<HostSessionExchange, "establish">;
  readonly verified: VerifiedPersonalHostEndpoint;
}): Promise<void> {
  const connection = deploymentConnectionFromVerifiedPersonalRoute({
    accountAccess: null,
    name: options.name,
    source: { kind: "manual" },
    verified: options.verified,
  });
  // The route was verified a moment ago and is not in the catalog yet, so the
  // attachment is resolved from it directly rather than read back through the
  // catalog it has not entered.
  const resolved = resolveConnection(connection, null, { authorization: null });
  const established = await options.exchange.establish(resolved, {
    pairingCode: options.pairingCode,
  });
  await options.sessions.save(personalSessionFrom(resolved.deploymentId, established));
  await options.catalog.upsertAndSelect(connection);
}

/**
 * What to call a Deployment nobody has named. The Host's own hostname is the
 * only honest answer for a server; a personal computer that has not published
 * a name is described by what it is.
 */
export function defaultDeploymentName(origin: string, personal: boolean): string {
  if (personal) return "Personal computer";
  const hostname = new URL(origin).hostname;
  return hostname.length > 0 && hostname.length <= 120 ? hostname : "Self-hosted deployment";
}
