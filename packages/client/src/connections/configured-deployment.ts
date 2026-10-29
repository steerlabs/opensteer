import {
  deploymentConnectionFromVerifiedEndpoints,
  verifyAccessEndpoint,
  type DeploymentCatalogStore,
  type VerifiedHostEndpoint,
} from "./deployment-catalog.js";
import { isPersonalHost } from "@opensteer/deployment-authority";

/**
 * Preserve the zero-terminal configured-Host experience while the Account
 * directory is introduced. A fresh catalog learns durable identity from the
 * Host discovery document; an existing catalog is never overwritten by a
 * release manifest or environment value.
 */
export async function ensureConfiguredDeployment(options: {
  readonly catalog: Pick<DeploymentCatalogStore, "load" | "upsert">;
  readonly hostUrl: URL;
  /**
   * Supplied by the caller rather than derived here: the name comes from
   * `os.hostname()`, and this module is otherwise portable.
   */
  readonly personalDeploymentName: string;
  readonly verify?: (origin: string) => Promise<VerifiedHostEndpoint>;
}): Promise<void> {
  const current = await options.catalog.load();
  if (current.deployments.length > 0) return;
  const verified = await (
    options.verify ??
    ((origin) =>
      verifyAccessEndpoint({
        kind: "canonical",
        origin,
      }))
  )(options.hostUrl.origin);
  const hostname = options.hostUrl.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const local =
    hostname === "localhost" ||
    hostname === "::1" ||
    /^127\.(?:[0-9]{1,3}\.){2}[0-9]{1,3}$/u.test(hostname);
  const personal = isPersonalHost(verified.discovery);
  await options.catalog.upsert(
    deploymentConnectionFromVerifiedEndpoints({
      accountAccess: null,
      endpoints: [verified],
      kind: personal ? "personal" : "self-hosted",
      name: local ? options.personalDeploymentName : options.hostUrl.host,
      source: { kind: "manual" },
    }),
  );
}
