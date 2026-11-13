/**
 * Every version in [floor, current] keeps every security property: proof of the
 * Host key before any secret, token authentication, and the exact signed and
 * scoped fields. Negotiation is unsigned, so this invariant is what makes an
 * unauthenticated downgrade to the floor harmless. Never add a version that
 * weakens one.
 */
export const browserSourceWireFloor = 4;
export const browserSourceWireCurrent = 5;

/** A peer that states no wire version speaks wire 4, whatever the floor is now. */
const unstatedWire = 4;

export type WireQuery =
  | { readonly kind: "absent" }
  | { readonly kind: "valid"; readonly wire: number }
  | { readonly kind: "invalid" };

/** The connect URL's `wire` query: exactly one positive safe integer in plain decimal. */
export function parseWireQuery(searchParams: URLSearchParams): WireQuery {
  const values = searchParams.getAll("wire");
  if (values.length === 0) return { kind: "absent" };
  const [value] = values;
  if (values.length !== 1 || value === undefined) return { kind: "invalid" };
  if (!/^[1-9][0-9]{0,15}$/u.test(value)) return { kind: "invalid" };
  const wire = Number(value);
  return Number.isSafeInteger(wire) ? { kind: "valid", wire } : { kind: "invalid" };
}

export type WireNegotiation =
  | { readonly kind: "negotiated"; readonly wire: number }
  | { readonly kind: "below-floor"; readonly supportedVersion: number };

/** The version both sides speak, given the highest one the peer stated (null when it stated none). */
export function negotiateWire(requested: number | null): WireNegotiation {
  const wire = Math.min(requested ?? unstatedWire, browserSourceWireCurrent);
  return wire < browserSourceWireFloor
    ? { kind: "below-floor", supportedVersion: browserSourceWireFloor }
    : { kind: "negotiated", wire };
}
