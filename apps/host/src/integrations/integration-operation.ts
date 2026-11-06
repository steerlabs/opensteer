import { createHash } from "node:crypto";
import type { CallableIntegrationTool } from "@opensteer/database";

export type OperationResolution =
  | { readonly kind: "found"; readonly callable: CallableIntegrationTool }
  | {
      readonly kind: "account-required";
      readonly candidates: readonly CallableIntegrationTool[];
    }
  | { readonly kind: "ambiguous"; readonly operations: readonly string[] }
  | { readonly kind: "changed" }
  | { readonly kind: "none" };

/**
 * What search shows a model to call: the tool's name, then a short token for
 * the stored tool and its schema. Generated names are not stable, because a
 * spec update can move a suffixed name onto another endpoint, so the token,
 * not the name, says which operation a held address means. It survives a
 * rename in place and stops matching when the operation's schema changes.
 */
export function operationAddress({ tool }: Pick<CallableIntegrationTool, "tool">): string {
  const token = createHash("sha256")
    .update(`${tool.id}.${tool.schemaDigest}`)
    .digest("base64url")
    .slice(0, 8);
  return `${tool.name}@${token}`;
}

/**
 * Finds one operation among what the caller may reach. An account-backed
 * operation always names its account: a default could retarget a write if the
 * caller's accounts changed after it searched.
 */
export function resolveOperation(
  callable: readonly CallableIntegrationTool[],
  operation: string,
  account: string | undefined,
): OperationResolution {
  const separator = operation.lastIndexOf("@");
  const named =
    separator > 0
      ? callable.filter((candidate) =>
          operationAddress(candidate).endsWith(operation.slice(separator)),
        )
      : callable.filter(({ tool }) => tool.name === operation);
  if (named.length === 0) {
    const name = operation.slice(0, separator);
    return separator > 0 && callable.some(({ tool }) => tool.name === name)
      ? { kind: "changed" }
      : { kind: "none" };
  }
  const addresses = [...new Set(named.map(operationAddress))].sort();
  if (addresses.length > 1) return { kind: "ambiguous", operations: addresses };
  if (account === undefined) {
    if (named.some(({ grant }) => grant.connectionId !== null)) {
      return { kind: "account-required", candidates: named };
    }
    return named.length === 1
      ? { kind: "found", callable: named[0]! }
      : { kind: "ambiguous", operations: addresses };
  }
  const [selected, ...rest] = named.filter(({ grant }) => grant.connectionId === account);
  if (!selected) return { kind: "none" };
  return rest.length === 0
    ? { kind: "found", callable: selected }
    : { kind: "ambiguous", operations: addresses };
}

/** Reading a schema acts on no account, so any account's copy serves when they agree. */
export function describedOperation(
  resolution: OperationResolution,
): CallableIntegrationTool | undefined {
  if (resolution.kind === "found") return resolution.callable;
  return resolution.kind === "account-required" ? resolution.candidates[0] : undefined;
}
