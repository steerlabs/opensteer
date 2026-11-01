import { browserRuntimeWireVersion } from "@opensteer/protocol/browser";
export function browserRuntimeCompatibilityReason(version: number | undefined): string | null {
  return version === browserRuntimeWireVersion
    ? null
    : "Update the Browser Runtime on this computer. This Host requires the current native browser runtime contract.";
}
