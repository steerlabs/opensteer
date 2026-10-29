import { HostDescriptorSchema, hostApiVersion } from "@opensteer/deployment-authority";

/**
 * The `/.well-known/opensteer` body a Host this control plane provisioned
 * serves, for the fakes that stand in for one.
 *
 * `@opensteer/client` has the same fixture for its own tests, but it is a
 * client-only package this server does not depend on, and taking a dependency
 * on it to reach a fixture would be the wrong edge. The fact both copies share
 * — the protocol epoch — has one home either way, in
 * `@opensteer/deployment-authority`.
 */
export function publicHostDescriptor(
  authority: unknown,
  overrides: { readonly apiVersion?: number } = {},
): Readonly<Record<string, unknown>> {
  const descriptor = {
    apiVersion: overrides.apiVersion ?? hostApiVersion,
    authority,
    bootstrapMethods: ["oidc"],
    capabilities: [],
  };
  // Parsed only when it claims to be what this tree serves, so a deliberately
  // incompatible fixture can still be built.
  if (descriptor.apiVersion === hostApiVersion) HostDescriptorSchema.parse(descriptor);
  return descriptor;
}
